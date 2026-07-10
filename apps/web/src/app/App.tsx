/**
 * App root (M1.4). Composes the provider stack and gates onboarding vs. the authenticated
 * shell:
 *
 *   ServicesProvider  → the injectable connect/auth/probe seam (fakes in tests)
 *     SessionProvider → the auth lifecycle (boot, login, re-auth, sign-out)
 *       status !== 'ready'  → <Onboarding/>          (connect + sign-in)
 *       status === 'ready'  → <RouterProvider>       (base-path-safe routing)
 *                               <AppShell/>          (three-pane responsive frame)
 *
 * The router only mounts once connected, so its base is read from the `<base href>` element
 * (reflecting any Stalwart mount-prefix rewrite) and no route decision runs during the OAuth
 * callback. Branding (product name) always comes from config — never hardcoded (FR-THEME-02).
 */

import type { WaxwingConfig } from './config'
import { ConfigProvider } from './config-context'
import { Onboarding } from './onboarding/Onboarding'
import { RouterProvider } from './route'
import { ServicesProvider, type ShellServices } from './services'
import { useSession } from './session/context'
import { SessionProvider } from './session/SessionProvider'
import { AppShell } from './shell/AppShell'

export interface AppProps {
  readonly config: WaxwingConfig
  /** Injectable service overrides (tests only); production uses the real defaults. */
  readonly services?: Partial<ShellServices>
}

export function App({ config, services }: AppProps) {
  return (
    <ServicesProvider {...(services ? { value: services } : {})}>
      <ConfigProvider config={config}>
        <SessionProvider config={config}>
          <AppBody config={config} />
        </SessionProvider>
      </ConfigProvider>
    </ServicesProvider>
  )
}

function AppBody({ config }: { config: WaxwingConfig }) {
  const { status } = useSession()

  if (status !== 'ready') {
    return <Onboarding />
  }

  return (
    <RouterProvider>
      <AppShell config={config} />
    </RouterProvider>
  )
}
