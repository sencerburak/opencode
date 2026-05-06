// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const checkUpdate: Platform["checkUpdate"] = async () => {
  try {
    const response = await fetch("https://api.github.com/repos/sencerburak/opencode/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) return { updateAvailable: false }
    const data = (await response.json()) as { tag_name?: string }
    const latest = data.tag_name?.replace(/^v/, "")
    if (!latest) return { updateAvailable: false }
    const updateAvailable = latest !== pkg.version
    return { updateAvailable, version: latest }
  } catch {
    return { updateAvailable: false }
  }
}

const updateAndRestart: Platform["updateAndRestart"] = async () => {
  const serverUrl = getCurrentUrl()
  const response = await fetch(`${serverUrl}/global/upgrade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
  if (response.ok) {
    window.location.reload()
  }
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

// Server-backed AsyncStorage for the web platform.
// Reads/writes to the opencode server's KV endpoint so that global
// preferences (e.g. enabled models) persist on the server filesystem
// instead of browser localStorage, surviving across sessions/subdomains.
function makeServerStorage(baseUrl: string) {
  return (bucket?: string): import("@solid-primitives/storage").AsyncStorage => {
    const b = bucket ?? "opencode.direct.dat"
    const url = (key: string) =>
      `${baseUrl}/global/kv?bucket=${encodeURIComponent(b)}&key=${encodeURIComponent(key)}`
    return {
      getItem: async (key: string) => {
        try {
          const res = await fetch(url(key))
          if (!res.ok) return null
          const json = await res.json() as { value: string | null }
          return json.value
        } catch {
          return null
        }
      },
      setItem: async (key: string, value: string) => {
        try {
          await fetch(`${baseUrl}/global/kv`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bucket: b, key, value }),
          })
        } catch { /* best-effort */ }
      },
      removeItem: async (key: string) => {
        try {
          await fetch(url(key), { method: "DELETE" })
        } catch { /* best-effort */ }
      },
    }
  }
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  storage: makeServerStorage(getCurrentUrl()),
  checkUpdate,
  updateAndRestart,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement) {
  const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
  clearAuthToken()
  const server: ServerConnection.Http = {
    type: "http",
    authToken: !!auth,
    http: {
      url: getCurrentUrl(),
      ...auth,
    },
  }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
