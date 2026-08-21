/**
 * Settings → Server → generate this deployment's `config.json` (M5.20, closing rank 9's setup
 * wizard in the form a static client can actually offer).
 *
 * Bulwark's wizard writes a config file and an admin password to disk, which needs the Node process
 * it runs in. This does the half that does not: it describes the server the app is already
 * connected to and hands the admin a file to save next to `index.html`.
 *
 * The connection is not re-probed. CORS, redirects and the URLs the server advertises are exactly
 * what this session has already proved by existing. The one thing it cannot answer is whether OAuth
 * discovery responds, so that is one `HEAD`-shaped fetch — and "could not check" is carried through
 * as its own answer rather than being flattened into "no OAuth", which would turn it off for a
 * deployment that has it.
 */

import { Download } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigOptional } from '../app/config-context'
import {
  buildConfigFromSession,
  discoveryUrl,
  type ProbeResult,
  serializeConfig,
} from '../app/config-probe'
import type { JmapSession } from '../app/session/types'
import { Button } from '../ui'
import styles from './settings.module.css'

export interface ConfigGeneratorPanelProps {
  readonly session: JmapSession
  /** Injected in tests. Defaults to `location.origin`. */
  readonly origin?: string
  /** Injected in tests. Resolves to whether OAuth discovery answered, or null if unknowable. */
  readonly checkOAuth?: (issuer: string) => Promise<boolean | null>
}

/**
 * Whether `<issuer>/.well-known/openid-configuration` answers.
 *
 * A network failure returns `null`, not `false`: being offline is not evidence about the server,
 * and the caller treats the two differently on purpose.
 */
async function fetchOAuthDiscovery(issuer: string): Promise<boolean | null> {
  try {
    const response = await fetch(discoveryUrl(issuer), { method: 'GET', credentials: 'omit' })
    return response.ok
  } catch {
    return null
  }
}

export function ConfigGeneratorPanel({ session, origin, checkOAuth }: ConfigGeneratorPanelProps) {
  const { t } = useTranslation()
  const current = useConfigOptional()
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState(false)

  const here = origin ?? window.location.origin
  const check = checkOAuth ?? fetchOAuthDiscovery

  const generate = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const issuer =
        typeof session.apiUrl === 'string' && session.apiUrl !== '' ? session.apiUrl : here
      const oauthDiscovered = await check(new URL(issuer, here).origin)
      setResult(
        buildConfigFromSession(session, {
          origin: here,
          oauthDiscovered,
          // Spread rather than `current: current ?? undefined`: under exactOptionalPropertyTypes,
          // an explicit `undefined` is not the same as an absent key.
          ...(current === null ? {} : { current }),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [session, here, check, current])

  const save = useCallback((): void => {
    if (result === null) return
    const blob = new Blob([serializeConfig(result.config)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    // Not localized: it becomes a filename the deployment must literally be called `config.json`.
    anchor.download = 'config.json'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [result])

  // `.group`: a label over a block — an explanation, a button, a findings list and a file preview.
  // `.field` would put that label beside all of it, halfway down an otherwise empty column.
  return (
    <div className={styles.group}>
      <span className={styles.label}>{t('settings.server.generate.title')}</span>
      <p className={styles.hint}>{t('settings.server.generate.intro')}</p>

      <Button variant="secondary" disabled={busy} onClick={() => void generate()}>
        {busy ? t('settings.server.generate.checking') : t('settings.server.generate.action')}
      </Button>

      {result !== null && (
        <>
          <ul className={styles.findings}>
            {result.findings.map((finding) => (
              <li
                key={finding.key}
                className={finding.level === 'warn' ? styles.findingWarn : styles.findingInfo}
              >
                {/* The level is spelled out, not only coloured (WCAG 1.4.1). */}
                <strong>
                  {finding.level === 'warn'
                    ? t('settings.server.generate.warnLabel')
                    : t('settings.server.generate.infoLabel')}
                </strong>{' '}
                {/* One text node, so the message is addressable as a whole — by a test, and by a
                    screen reader reading the item rather than its fragments. */}
                <span>
                  {t(`settings.server.generate.finding.${finding.key}`, finding.values ?? {})}
                </span>
              </li>
            ))}
          </ul>

          {/* Shown before saving, deliberately: this file decides how every user reaches the
              server, and an admin should read it rather than trust a download button. */}
          <pre className={styles.configPreview}>
            <code>{serializeConfig(result.config)}</code>
          </pre>

          <Button variant="primary" onClick={save}>
            <Download aria-hidden="true" />
            {t('settings.server.generate.save')}
          </Button>
        </>
      )}
    </div>
  )
}
