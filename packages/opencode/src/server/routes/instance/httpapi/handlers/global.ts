import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput, KvQuery, KvGetResult, KvSetInput } from "../groups/global"
import fs from "fs/promises"
import path from "path"

const log = Log.create({ service: "server" })

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: Bus.createID(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      // Exit after a short delay so the response is delivered before we die.
      // The entrypoint restart loop will relaunch opencode with the new binary.
      setTimeout(() => process.exit(0), 500)
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    // Key-value storage backed by the server filesystem.
    // Bucket "opencode.global.dat" → ~/.config/opencode/kv/ (global config volume)
    // All other buckets → ~/.local/share/opencode/kv/ (per-repo data volume)
    const kvDir = (bucket: string) => {
      const safeBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, "_")
      const base = bucket === "opencode.global.dat" ? Global.Path.config : Global.Path.data
      return path.join(base, "kv", safeBucket)
    }

    const kvPath = (bucket: string, key: string) => {
      const safeKey = key.replace(/[^a-zA-Z0-9._:-]/g, "_")
      return path.join(kvDir(bucket), `${safeKey}.json`)
    }

    const kvGet = Effect.fn("GlobalHttpApi.kvGet")(function* (ctx: { query: typeof KvQuery.Type }) {
      const file = kvPath(ctx.query.bucket, ctx.query.key)
      const value = yield* Effect.tryPromise(() => fs.readFile(file, "utf8")).pipe(
        Effect.map((v): string | null => v),
        Effect.orElseSucceed((): string | null => null),
      )
      return { value }
    })

    const kvSet = Effect.fn("GlobalHttpApi.kvSet")(function* (ctx: { payload: typeof KvSetInput.Type }) {
      const dir = kvDir(ctx.payload.bucket)
      const file = kvPath(ctx.payload.bucket, ctx.payload.key)
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(file, ctx.payload.value, "utf8")
        },
        catch: (e) => { throw e },
      })
      return true
    })

    const kvDelete = Effect.fn("GlobalHttpApi.kvDelete")(function* (ctx: { query: typeof KvQuery.Type }) {
      const file = kvPath(ctx.query.bucket, ctx.query.key)
      yield* Effect.tryPromise({
        try: () => fs.unlink(file).catch(() => { /* already gone */ }),
        catch: (e) => { throw e },
      })
      return true
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handle("kvGet", kvGet)
      .handle("kvSet", kvSet)
      .handle("kvDelete", kvDelete)
  }),
)
