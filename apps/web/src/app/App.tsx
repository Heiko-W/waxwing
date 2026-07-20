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

import { useUpdatePrompt } from '../pwa/use-update-prompt'
import { SyncEngineHost } from '../sync/engine'
import { ToastProvider } from '../ui'
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
          {/* App-global toast surface: the reading action bar (reply/forward stubs) and future
              features raise toasts; without a provider here `useToast` throws on first use. */}
          <ToastProvider>
            <AppBody config={config} />
          </ToastProvider>
        </SessionProvider>
      </ConfigProvider>
    </ServicesProvider>
  )
}

function AppBody({ config }: { config: WaxwingConfig }) {
  const { status } = useSession()

  // Registered ABOVE the auth gate, and deliberately so: from inside <AppShell> the worker would only
  // ever install after a sign-in, which means a first-time visitor precaches nothing (no offline shell
  // — FR-OFF-01) and Chromium, whose installability check needs a registered worker, would offer no
  // install at all on the sign-in screen (FR-DEP-06). Nothing in the registration needs a session.
  // It is mounted here rather than in main.tsx because the reload it offers is a toast (ToastProvider,
  // just above).
  //
  // THE COST OF THAT PLACEMENT, AND HOW IT IS PAID (M3.10). The update toast promises "Open drafts
  // are saved first", and the draft flush needs the replica — which <ReplicaProvider> supplies from
  // inside <SyncEngineHost>, a DESCENDANT of this component. Context flows down only, so the hook's
  // original `useDraftSync()` read `null` here and silently took the no-replica branch, whose `flush`
  // is `async () => {}`: for five milestones the toast said the drafts were saved and nothing was
  // written. The registration could not simply move below the gate without losing both guarantees
  // above, so the SEAM moved instead — `flushActiveDraft` (compose/use-draft-sync.ts) resolves the
  // live replica through `getActiveReplica()` at call time, which needs no ancestry at all. Pre-auth
  // there is genuinely nothing to flush (no account, and the composer lives inside the shell), so the
  // accessor's `null` is the correct answer there rather than a hole.
  useUpdatePrompt()

  if (status !== 'ready') {
    return <Onboarding />
  }

  return (
    <RouterProvider>
      <SyncEngineHost>
        <AppShell config={config} />
      </SyncEngineHost>
    </RouterProvider>
  )
}
