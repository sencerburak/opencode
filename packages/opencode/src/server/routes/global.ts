import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { Bus } from "@/bus"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "@/util/queue"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { lazy } from "../../util/lazy"
import { Config } from "@/config/config"
import { errors } from "../error"
import { disposeAllInstancesAndEmitGlobalDisposed } from "../global-lifecycle"
import { Global } from "@opencode-ai/core/global"

// Key-value storage backed by the server filesystem.
// Bucket "opencode.global.dat" → ~/.config/opencode/kv/ (shared global config volume)
// All other buckets → ~/.local/share/opencode/kv/ (per-repo data volume)
function kvDir(bucket: string) {
  const safeBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, "_")
  const base = bucket === "opencode.global.dat" ? Global.Path.config : Global.Path.data
  return path.join(base, "kv", safeBucket)
}

function kvPath(bucket: string, key: string) {
  const safeKey = key.replace(/[^a-zA-Z0-9._:-]/g, "_")
  return path.join(kvDir(bucket), `${safeKey}.json`)
}

const log = Log.create({ service: "server" })

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<string | null>()
    let done = false

    q.push(
      JSON.stringify({
        payload: {
          id: Bus.createID(),
          type: "server.connected",
          properties: {},
        },
      }),
    )

    // Send heartbeat every 10s to prevent stalled proxy streams.
    const heartbeat = setInterval(() => {
      q.push(
        JSON.stringify({
          payload: {
            id: Bus.createID(),
            type: "server.heartbeat",
            properties: {},
          },
        }),
      )
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.push(null)
      log.info("global event disconnected")
    }

    const unsub = subscribe(q)

    stream.onAbort(stop)

    try {
      for await (const data of q) {
        if (data === null) return
        await stream.writeSSE({ data })
      }
    } finally {
      stop()
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: InstallationVersion })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: z.union([...BusEvent.payloads(), ...SyncEvent.payloads()]),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        const result = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.updateGlobal(config)))
        if (result.changed) {
          void AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })).catch(
            () => undefined,
          )
        }
        return c.json(result.info)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed())
        return c.json(true)
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade opencode",
        description: "Upgrade opencode to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const result = await AppRuntime.runPromise(
          Installation.Service.use((svc) =>
            Effect.gen(function* () {
              const method = yield* svc.method()
              if (method === "unknown") {
                return { success: false as const, status: 400 as const, error: "Unknown installation method" }
              }

              const target = c.req.valid("json").target || (yield* svc.latest(method))
              const result = yield* Effect.catch(
                svc.upgrade(method, target).pipe(Effect.as({ success: true as const, version: target })),
                (err) =>
                  Effect.succeed({
                    success: false as const,
                    status: 500 as const,
                    error: err instanceof Error ? err.message : String(err),
                  }),
              )
              if (!result.success) return result
              return { ...result, status: 200 as const }
            }),
          ),
        )
        if (!result.success) {
          return c.json({ success: false, error: result.error }, result.status)
        }
        const target = result.version
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: target },
          },
        })
        const response = c.json({ success: true, version: target })
        // Exit after a short delay so the response is delivered before we die.
        // The entrypoint restart loop will relaunch opencode with the new binary.
        setTimeout(() => process.exit(0), 500)
        return response
      },
    )
    .get(
      "/kv",
      describeRoute({
        summary: "Get KV entry",
        description: "Read a persisted key-value entry from server-side storage.",
        operationId: "global.kv.get",
        responses: {
          200: {
            description: "KV value",
            content: {
              "application/json": {
                schema: resolver(z.object({ value: z.string().nullable() })),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          bucket: z.string(),
          key: z.string(),
        }),
      ),
      async (c) => {
        const { bucket, key } = c.req.valid("query")
        const file = kvPath(bucket, key)
        try {
          const value = await fs.readFile(file, "utf8")
          return c.json({ value })
        } catch {
          return c.json({ value: null })
        }
      },
    )
    .put(
      "/kv",
      describeRoute({
        summary: "Set KV entry",
        description: "Write a persisted key-value entry to server-side storage.",
        operationId: "global.kv.set",
        responses: {
          200: {
            description: "KV stored",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          bucket: z.string(),
          key: z.string(),
          value: z.string(),
        }),
      ),
      async (c) => {
        const { bucket, key, value } = c.req.valid("json")
        const dir = kvDir(bucket)
        const file = kvPath(bucket, key)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(file, value, "utf8")
        return c.json(true)
      },
    )
    .delete(
      "/kv",
      describeRoute({
        summary: "Delete KV entry",
        description: "Remove a persisted key-value entry from server-side storage.",
        operationId: "global.kv.delete",
        responses: {
          200: {
            description: "KV deleted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          bucket: z.string(),
          key: z.string(),
        }),
      ),
      async (c) => {
        const { bucket, key } = c.req.valid("query")
        const file = kvPath(bucket, key)
        await fs.unlink(file).catch(() => { /* already gone */ })
        return c.json(true)
      },
    ),
)
