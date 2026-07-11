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
    logo: 'branding/logo.svg',
    accentColor: null,
    defaultTheme: 'auto',
    links: { imprint: null, support: null, privacy: null },
  },
  features: {
    sieveEditor: true,
    remoteContentDefault: 'block',
    imageProxyUrl: null,
    undoSendSeconds: 10,
  },
  offline: { cacheDays: 30, maxStorageMB: 512 },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge a partial override (parsed config.json) over the defaults. Nested
 * objects are merged key by key; arrays and scalars in the override replace the
 * default wholesale. Unknown keys are ignored by the typed return.
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

/** Normalize a merged config: clamp operator-supplied numeric knobs into their supported ranges. */
export function normalizeConfig(config: WaxwingConfig): WaxwingConfig {
  return {
    ...config,
    features: {
      ...config.features,
      undoSendSeconds: clampUndoSend(config.features.undoSendSeconds),
    },
  }
}

/**
 * Load config.json relative to document.baseURI (so it works under any path prefix,
 * FR-DEP-02), network-first with no caching. Any failure — missing file, network
 * error, invalid JSON — falls back to the built-in defaults so the app always boots.
 */
export async function loadConfig(): Promise<WaxwingConfig> {
  try {
    const url = new URL('config.json', document.baseURI)
    const response = await fetch(url.href, { cache: 'no-store' })
    if (!response.ok) {
      return DEFAULT_CONFIG
    }
    const raw: unknown = await response.json()
    return normalizeConfig(deepMerge(DEFAULT_CONFIG, raw))
  } catch {
    return DEFAULT_CONFIG
  }
}
