/**
 * Generating a deployment `config.json` (M5.20).
 *
 * The assertions that matter are the ones about NOT knowing. "OAuth discovery did not answer" and
 * "OAuth discovery could not be checked" must not collapse into the same config — the first is
 * grounds for narrowing the sign-in methods, the second is grounds for leaving a working setup
 * alone. Flattening them is how a generator silently turns off OAuth for a deployment that has it.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type WaxwingConfig } from './config'
import {
  buildConfigFromSession,
  discoveryUrl,
  isInsecureOrigin,
  isSameOrigin,
  serializeConfig,
} from './config-probe'
import type { JmapSession } from './session/types'

const session = (apiUrl: string): JmapSession => ({ apiUrl }) as unknown as JmapSession

describe('where the server is', () => {
  it('writes null for a same-origin server, so the deployment can move', () => {
    const { config } = buildConfigFromSession(session('https://mail.example.com/jmap'), {
      origin: 'https://mail.example.com',
      oauthDiscovered: true,
    })
    expect(config.server.sessionUrl).toBeNull()
  })

  it('pins the ORIGIN, not the full apiUrl, for a cross-origin server', () => {
    // The config's `sessionUrl` is what `connect()` is given; it resolves the well-known path
    // itself. Pinning `/jmap` would hard-code an endpoint the server is free to move.
    const { config } = buildConfigFromSession(session('https://jmap.example.net/jmap/api'), {
      origin: 'https://mail.example.com',
      oauthDiscovered: true,
    })
    expect(config.server.sessionUrl).toBe('https://jmap.example.net')
  })

  it('warns that a cross-origin deployment depends on CORS', () => {
    const { findings } = buildConfigFromSession(session('https://jmap.example.net/jmap'), {
      origin: 'https://mail.example.com',
      oauthDiscovered: true,
    })
    const cors = findings.find((finding) => finding.key === 'crossOrigin')
    expect(cors?.level).toBe('warn')
    expect(cors?.values?.origin).toBe('https://jmap.example.net')
  })

  it('does not mistake a different port for the same origin', () => {
    expect(isSameOrigin('https://x.test:8443/jmap', 'https://x.test')).toBe(false)
    expect(isSameOrigin('https://x.test/jmap', 'https://x.test')).toBe(true)
  })

  it('treats a RELATIVE apiUrl as same-origin, which is what RFC 8620 means', () => {
    // A session may advertise `apiUrl: "/jmap/api"`, resolved against the session URL. That is a
    // same-origin deployment and must produce `sessionUrl: null`, not a pin.
    const { config } = buildConfigFromSession(session('/jmap/api'), {
      origin: 'https://mail.example.com',
      oauthDiscovered: true,
    })
    expect(config.server.sessionUrl).toBeNull()
  })

  it('does not flatten a foreign absolute apiUrl to null', () => {
    // The failure that would matter: writing `null` for a server on another host produces a config
    // that silently points at the deployment's own origin.
    const { config } = buildConfigFromSession(session('https://elsewhere.test/jmap'), {
      origin: 'https://mail.example.com',
      oauthDiscovered: true,
    })
    expect(config.server.sessionUrl).toBe('https://elsewhere.test')
  })
})

describe('which sign-in methods it enables', () => {
  const basicOnly: WaxwingConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, auth: ['basic'] },
  }

  it('offers both when discovery answered', () => {
    const { config } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: true,
      current: basicOnly,
    })
    expect(config.server.auth).toEqual(['oauth', 'basic'])
  })

  it('narrows to Basic when discovery answered NO, and says why', () => {
    const { config, findings } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: false,
    })
    expect(config.server.auth).toEqual(['basic'])
    expect(findings.find((finding) => finding.key === 'basicOnly')?.level).toBe('warn')
  })

  it('KEEPS the current methods when discovery could not be checked', () => {
    // The bug this exists to catch: treating "could not check" as "no OAuth" turns it off for a
    // deployment that has it, from one failed request.
    const { config, findings } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: null,
      current: DEFAULT_CONFIG,
    })
    expect(config.server.auth).toEqual(DEFAULT_CONFIG.server.auth)
    expect(findings.find((finding) => finding.key === 'oauthUnknown')?.level).toBe('warn')
    expect(findings.find((finding) => finding.key === 'basicOnly')).toBeUndefined()
  })
})

describe('insecure origins', () => {
  it('flags plain HTTP on a real host', () => {
    const { findings } = buildConfigFromSession(session('http://mail.example.com/jmap'), {
      origin: 'http://mail.example.com',
      oauthDiscovered: true,
    })
    expect(findings.find((finding) => finding.key === 'insecureOrigin')?.level).toBe('warn')
  })

  it('does NOT flag localhost, which browsers treat as secure', () => {
    // The dev fixture runs on plain HTTP against localhost and works. Flagging it would be wrong.
    expect(isInsecureOrigin('http://localhost:5173')).toBe(false)
    expect(isInsecureOrigin('http://127.0.0.1:8080')).toBe(false)
    expect(isInsecureOrigin('http://mail.example.com')).toBe(true)
    expect(isInsecureOrigin('https://mail.example.com')).toBe(false)
  })
})

describe('what it refuses to invent', () => {
  it('carries branding across untouched', () => {
    const branded: WaxwingConfig = {
      ...DEFAULT_CONFIG,
      branding: { ...DEFAULT_CONFIG.branding, productName: 'Hoster Mail' },
    }
    const { config } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: true,
      current: branded,
    })
    expect(config.branding).toEqual(branded.branding)
  })

  it('carries features and offline settings across untouched', () => {
    const tuned: WaxwingConfig = {
      ...DEFAULT_CONFIG,
      features: { ...DEFAULT_CONFIG.features, sieveEditor: false },
      offline: { cacheDays: 7, maxStorageMB: 42 },
    }
    const { config } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: true,
      current: tuned,
    })
    expect(config.features).toEqual(tuned.features)
    expect(config.offline).toEqual(tuned.offline)
  })

  it('says out loud that branding was not discovered', () => {
    const { findings } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: true,
    })
    expect(findings.map((finding) => finding.key)).toContain('brandingUntouched')
  })
})

describe('the file it writes', () => {
  it('is valid JSON that round-trips', () => {
    const { config } = buildConfigFromSession(session('https://x.test/jmap'), {
      origin: 'https://x.test',
      oauthDiscovered: true,
    })
    const text = serializeConfig(config)
    expect(JSON.parse(text)).toEqual(config)
  })

  it('ends with a newline and is indented for a human editor', () => {
    expect(serializeConfig(DEFAULT_CONFIG).endsWith('}\n')).toBe(true)
    expect(serializeConfig(DEFAULT_CONFIG)).toContain('\n  "server"')
  })
})

describe('OAuth discovery URL', () => {
  it('is the RFC 8414 well-known path at the issuer root', () => {
    expect(discoveryUrl('https://x.test')).toBe('https://x.test/.well-known/openid-configuration')
    // A path on the issuer must not push the well-known below it.
    expect(discoveryUrl('https://x.test/mail/')).toBe(
      'https://x.test/.well-known/openid-configuration',
    )
  })
})
