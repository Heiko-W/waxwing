/**
 * Deployment configuration (config.json, functional-spec §9).
 *
 * config.json lives next to index.html in the deployment directory and is fetched
 * network-first at boot (never precached), so a hoster can rebrand or repoint the
 * server without a rebuild (FR-DEP-04, FR-THEME-02). The JSON is NEVER imported at
 * build time — that would bake it into the bundle and defeat runtime configuration.
 */

export type ThemeSetting = 'auto' | 'light' | 'dark'
export type AuthMethod = 'oauth' | 'basic'
export type RemoteContentDefault = 'block' | 'allow'

export interface WaxwingConfig {
  server: {
    /** null = same-origin /.well-known/jmap */
    sessionUrl: string | null
    /** show a server field on the login form */
    allowCustomServer: boolean
    /** enabled auth methods, in order of preference */
    auth: AuthMethod[]
  }
  branding: {
    productName: string
    logo: string
    /** Hoster accent override applied to both themes. `null` keeps the built-in theme-aware
     *  accent (recommended); a custom value is not contrast-guaranteed. */
    accentColor: string | null
    /** Which built-in accent palettes to offer (FR-THEME-03); `null` offers all of them. A hoster
     *  can narrow the list but cannot add to it — every palette is contrast-proved, and an invented
     *  one would not be. */
    accentPalettes: readonly string[] | null
    /** Remove the accent choice entirely — for a deployment with a mandated brand colour. */
    accentLocked: boolean
    defaultTheme: ThemeSetting
    links: {
      imprint: string | null
      support: string | null
      privacy: string | null
    }
  }
  features: {
    sieveEditor: boolean
    remoteContentDefault: RemoteContentDefault
    imageProxyUrl: string | null
    undoSendSeconds: number
  }
  offline: {
    cacheDays: number
    maxStorageMB: number
  }
}

export const DEFAULT_CONFIG: WaxwingConfig = {
  server: {
    sessionUrl: null,
    allowCustomServer: true,
    auth: ['oauth', 'basic'],
  },
  branding: {
    productName: 'Waxwing',
    logo: 'branding/logo-icon.svg',
    accentColor: null,
    accentPalettes: null,
    accentLocked: false,
    defaultTheme: 'auto',
    links: { imprint: null, support: null, privacy: null },
  },
  features: {
    sieveEditor: true,
    remoteContentDefault: 'block',
    imageProxyUrl: null,
    undoSendSeconds: 15,
  },
  offline: { cacheDays: 30, maxStorageMB: 512 },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A validator for one operator-supplied key: `{ value }` to accept (possibly a repaired value),
 * or `null` to reject it and keep the built-in default.
 */
type Validator = (value: unknown) => { readonly value: unknown } | null

/**
 * A string `new URL()` accepts with an http/https scheme, or `null` (= "unset", the default).
 *
 * `server.sessionUrl` is the field that decides WHO RECEIVES THE PASSWORD, and until this existed
 * it was the only unchecked one that could take the app down: `mail.example.com/.well-known/jmap`
 * (no scheme) parses as a relative URL and throws a TypeError out of `new URL()` in session/target
 * during boot — an unhandled rejection no ErrorBoundary sees (React boundaries do not catch async
 * rejections), so the app sits on the booting spinner forever. Rejecting it here keeps the boot on
 * the same-origin default. The scheme allow-list also stops a `javascript:`/`data:` session URL.
 */
function httpUrlOrNull(value: unknown): { readonly value: unknown } | null {
  if (value === null) return { value }
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? { value } : null
}

/** Accept only the listed literals — an enum typo must not reach code that switches on it. */
function oneOf(...allowed: readonly string[]): Validator {
  return (value) => (typeof value === 'string' && allowed.includes(value) ? { value } : null)
}

/**
 * Filter the auth list to the methods the login form can actually drive, preserving the operator's
 * order (it is a preference order) and dropping duplicates. An all-junk list is REJECTED rather
 * than accepted-as-empty: an empty array is a login form with no way to log in, which is a worse
 * outcome than ignoring the key.
 */
function authMethods(value: unknown): { readonly value: unknown } | null {
  if (!Array.isArray(value)) return null
  const methods = value.filter(
    (method, index): method is AuthMethod =>
      (method === 'oauth' || method === 'basic') && value.indexOf(method) === index,
  )
  return methods.length > 0 ? { value: methods } : null
}

/**
 * Per-key validators for the parsed config.json, by dotted path.
 *
 * Only the keys where a wrong value does something worse than "looks odd" are listed: the URLs
 * (a bad one throws or leaks), and the closed enums (code switches on them). The numeric knobs are
 * clamped downstream by {@link normalizeConfig}, and everything else is a string or a boolean whose
 * worst case is cosmetic — deliberately NOT a schema validator, which would have to be kept in step
 * with the interface by hand and would fail the whole file over one bad label.
 */
const VALIDATORS: Readonly<Record<string, Validator>> = {
  'server.sessionUrl': httpUrlOrNull,
  'server.auth': authMethods,
  'branding.defaultTheme': oneOf('auto', 'light', 'dark'),
  'features.remoteContentDefault': oneOf('block', 'allow'),
  'features.imageProxyUrl': httpUrlOrNull,
}

/**
 * Drop every override that fails its validator, and NAME it on the console.
 *
 * config.json is hand-edited on a server with nothing to check it, and the loader is otherwise
 * silent by construction (any failure falls back to the defaults), so a typo used to produce a
 * working app that quietly ignored the setting — or, for `sessionUrl`, no app at all. The warning
 * is the only feedback channel a static deployment has; it costs nothing and turns "the theme
 * setting does nothing" into one line in the console.
 *
 * Rejected keys are removed from the override, so the deep merge below leaves the default in place.
 */
function sanitizeOverride(raw: unknown, path = ''): unknown {
  if (!isPlainObject(raw)) return raw
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const keyPath = path === '' ? key : `${path}.${key}`
    const validate = VALIDATORS[keyPath]
    if (validate === undefined) {
      result[key] = isPlainObject(value) ? sanitizeOverride(value, keyPath) : value
      continue
    }
    const accepted = validate(value)
    if (accepted === null) {
      console.warn(
        `[waxwing] config.json: ignoring invalid "${keyPath}" (${JSON.stringify(value)}); using the built-in default`,
      )
      continue
    }
    result[key] = accepted.value
  }
  return result
}

/**
 * Deep-merge a partial override (parsed config.json) over the defaults. Nested
 * objects are merged key by key; arrays and scalars in the override replace the
 * default wholesale. Unknown keys are ignored by the typed return.
 *
 * The override is expected to have been through {@link sanitizeOverride} first: this function
 * copies whatever it is given verbatim and cannot tell a URL from a number.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return base
  }
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue
    }
    const baseValue = result[key]
    result[key] = isPlainObject(baseValue) ? deepMerge(baseValue, value) : value
  }
  return result as T
}

/**
 * Clamp the undo-send grace to a sane range (0–30 s); a non-numeric or NaN override falls back to
 * the default. Without this a negative value would send immediately yet leave a never-dismissing
 * Undo toast (a duration ≤ 0 means "sticky"), and an absurd value would delay the send arbitrarily.
 */
function clampUndoSend(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return DEFAULT_CONFIG.features.undoSendSeconds
  }
  return Math.min(30, Math.max(0, Math.round(seconds)))
}

/**
 * Clamp the offline horizon to 1–3650 days (M3.4). A NON-POSITIVE value falls back to the default
 * rather than clamping to 1: `windowFilter` builds `receivedAt >= now − cacheDays`, so `0` puts that
 * boundary at *today* (and a negative one in the future) and every mailbox renders permanently
 * empty — an operator typo must not silently become "keep one day of mail", it must be ignored.
 */
function clampCacheDays(days: unknown): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return DEFAULT_CONFIG.offline.cacheDays
  const rounded = Math.round(days)
  if (rounded < 1) return DEFAULT_CONFIG.offline.cacheDays
  return Math.min(3650, rounded)
}

/**
 * Clamp the cache budget to 50–4096 MB (M3.4). Below `MIN_BUDGET_BYTES` (50 MB) every maintenance
 * pass would evict the cache it just filled; the eviction planner floors it there anyway, so
 * accepting a lower number here would only misreport the budget in Settings.
 */
function clampMaxStorageMB(mb: unknown): number {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) return DEFAULT_CONFIG.offline.maxStorageMB
  return Math.min(4096, Math.max(50, Math.round(mb)))
}

/** Normalize a merged config: clamp operator-supplied numeric knobs into their supported ranges. */
export function normalizeConfig(config: WaxwingConfig): WaxwingConfig {
  return {
    ...config,
    features: {
      ...config.features,
      undoSendSeconds: clampUndoSend(config.features.undoSendSeconds),
    },
    offline: {
      ...config.offline,
      cacheDays: clampCacheDays(config.offline.cacheDays),
      maxStorageMB: clampMaxStorageMB(config.offline.maxStorageMB),
    },
  }
}

/**
 * How long the boot waits for config.json. `main.tsx` AWAITS this before it renders anything, so
 * without a deadline a hung request — a captive portal answers the TCP handshake and then nothing —
 * leaves the app on a blank page forever. On timeout the fetch aborts and we boot with the defaults.
 */
const CONFIG_TIMEOUT_MS = 5000

/**
 * Load config.json relative to document.baseURI (so it works under any path prefix,
 * FR-DEP-02), network-first with no caching. Any failure — missing file, network
 * error, invalid JSON, no answer within {@link CONFIG_TIMEOUT_MS} — falls back to the
 * built-in defaults so the app always boots.
 *
 * A file that parses can still be wrong, so individual keys go through
 * {@link sanitizeOverride} (rejected → warned about and defaulted) before the merge, and the
 * numeric knobs through {@link normalizeConfig} after it. Neither is a full schema check: an
 * unknown key or a mistyped boolean still merges through. The invariant they do buy is that a
 * hand-edited config.json cannot stop the app from booting.
 */
export async function loadConfig(
  options: { readonly timeoutMs?: number } = {},
): Promise<WaxwingConfig> {
  try {
    const url = new URL('config.json', document.baseURI)
    const response = await fetch(url.href, {
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? CONFIG_TIMEOUT_MS),
    })
    if (!response.ok) {
      return DEFAULT_CONFIG
    }
    const raw: unknown = await response.json()
    return normalizeConfig(deepMerge(DEFAULT_CONFIG, sanitizeOverride(raw)))
  } catch {
    return DEFAULT_CONFIG
  }
}
