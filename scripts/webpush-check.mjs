// Waxwing — hand-verification harness for Web Push while the app is CLOSED (M4.0, §13 row B29).
//
//   pnpm webpush            → build, serve at http://localhost:5174, fixture behind a proxy
//   pnpm webpush:deliver    → deliver one mail to alice (second terminal, app closed)
//   pnpm webpush:status     → what the server thinks it is pushing to
//
// (Not to be confused with `scripts/push-demo.mjs`, which is SP.3's JMAP push-TRANSPORT latency
// demo — SSE and WebSocket while the app is running. This one is about Web Push, RFC 8030, which
// is what reaches a closed app.)
//
// ── WHY THIS EXISTS AND WHY IT IS NOT AN E2E TEST ─────────────────────────────────────────────
//
// Playwright cannot observe a closed app, and the harness Chromium has no push service to mint an
// endpoint against — `PushManager.subscribe()` fails there and the app degrades to `unsupported`,
// correctly. Everything AROUND the delivery is unit-tested; the delivery itself cannot be. §13 row
// B29 is that gap, and this script exists so closing it is ten minutes rather than an afternoon.
//
// ── WHAT IT NEEDS, AND WHY IT IS localhost RATHER THAN YOUR PHONE ─────────────────────────────
//
// Web Push has three parties: the browser, the browser vendor's push service (FCM for Chrome,
// Mozilla autopush for Firefox, APNs for Safari), and the application server — here Stalwart. The
// server does NOT need to be reachable from the internet: it makes an OUTBOUND POST to the endpoint
// the push service minted. A local fixture is therefore fine, and that is the part people expect to
// be the obstacle and isn't.
//
// The actual obstacle is the origin. Service workers and the Push API require a **secure context**:
// https, or a loopback host. `http://192.168.x.x:5174` is neither, so no service worker registers
// and there is nothing to push to. That is a browser rule, not a setting — which is why this serves
// `localhost`, and why a phone needs a certificate it trusts rather than a config flag.
//
// Both ends still need internet: the browser holds a connection to its push service, and Stalwart
// POSTs to it. A default Docker bridge gives the container outbound access.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { ACCOUNTS, down, up } from '../e2e/stalwart/fixture.mjs'
import { seedDemoMail } from '../e2e/stalwart/seed-demo.mjs'

const PORT = Number(process.env.WAXWING_PUSH_PORT ?? '5174')
const ORIGIN = `http://localhost:${PORT}`
const [alice] = ACCOUNTS

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${String(code)}`)),
    )
  })
}

/** Refuse before touching Docker: `vite preview --strictPort` would die after the fixture moved. */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') return reject(error)
      reject(new Error(`port ${port} is in use — stop it, or set WAXWING_PUSH_PORT`))
    })
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve()))
  })
}

function banner() {
  const line = '─'.repeat(74)
  console.log(`\n${line}`)
  console.log('  Waxwing — Web Push hand-check (closes §13 row B29)')
  console.log(line)
  console.log(`  1. Open  ${ORIGIN}  in Chrome.`)
  console.log('     NOT an incognito window — service workers are disabled there.')
  console.log(`  2. Sign in:  ${alice.login}  /  ${alice.password}`)
  console.log('  3. Settings → Notifications → switch ON, allow the browser prompt.')
  console.log('     Three limit sentences must appear under the switch: no sender or')
  console.log('     subject, the folder list does not apply, open it once a week.')
  console.log('  4. CLOSE every Waxwing tab. Leave Chrome itself running.')
  console.log('  5. Second terminal:   pnpm webpush:deliver')
  console.log('')
  console.log('  Expected: ONE banner saying new mail arrived — no sender, no subject.')
  console.log('  Clicking it opens Waxwing.')
  console.log('')
  console.log('  Then, in order, the three cases that would each be a real defect:')
  console.log('   · pnpm webpush:deliver --read   marks a message read instead of')
  console.log('     delivering. NO banner may appear — that is EmailDelivery vs Email,')
  console.log('     and it is the whole reason a contentless banner is not noise.')
  console.log('   · With a Waxwing tab open and VISIBLE, deliver again: exactly ONE')
  console.log('     banner, the rich one from the live channel. Never two.')
  console.log('   · Set quiet hours around now, deliver: no banner at all.')
  console.log('')
  console.log('  pnpm webpush:status   shows what the server holds — the subscription,')
  console.log('  its types filter, and whether verification completed.')
  console.log('')
  console.log('  FROM ANOTHER MACHINE, tunnel rather than expose — an SSH forward makes')
  console.log('  the origin `localhost` there too, which is what the Push API needs:')
  console.log(`      ssh -L ${String(PORT)}:localhost:${String(PORT)} <user>@<this-host>`)
  console.log(`  then open http://localhost:${String(PORT)} on that machine. Safari on macOS 16.1+`)
  console.log('  does Web Push for ordinary websites — no Home Screen step; that rule is')
  console.log('  iOS-only. (This server listens on IPv6 loopback; `localhost` as the')
  console.log('  forward target is correct, sshd tries every address it resolves to.)')
  console.log('')
  console.log('  ON AN iPHONE none of that helps: iOS 16.4+ delivers Web Push only to a')
  console.log('  web app added to the Home Screen, and there is no SSH tunnel to make the')
  console.log('  origin trustworthy. It needs real HTTPS — and this fixture has')
  console.log('  world-known passwords, so it must not be exposed off-host to get it.')
  console.log('')
  console.log('  Stop + tear down: Ctrl-C')
  console.log(`${line}\n`)
}

let preview = null
let broughtUp = false
let tornDown = false

function teardown() {
  if (tornDown || !broughtUp) return
  tornDown = true
  try {
    down()
  } catch (error) {
    console.error(`[webpush] teardown failed: ${error.message}`)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    preview?.kill(signal)
    teardown()
    process.exit(0)
  })
}

try {
  await assertPortFree(PORT)

  // The fixture must advertise the BROWSER's origin: the session document's apiUrl and
  // eventSourceUrl are absolute and Stalwart ignores Host/X-Forwarded-* (SP.4 probe Q1). With this
  // the built app only ever talks to the preview server, which proxies through — no CORS, no
  // cross-origin loopback. Same arrangement as `pnpm demo`.
  process.env.STALWART_PUBLIC_URL = ORIGIN
  await up('dev')
  broughtUp = true

  console.log('[webpush] seeding alice’s inbox ...')
  await seedDemoMail(12)

  // A PRODUCTION build, and this step cannot be skipped: `devOptions.enabled: false` in
  // pwa-options.ts plus the PROD-only registration in use-update-prompt.ts mean there is NO service
  // worker under `vite dev` — hence no push listener, hence nothing whatsoever to test.
  console.log('[webpush] building the production bundle (this is where the SW comes from) ...')
  await run('pnpm', ['--filter', '@waxwing/web', 'build'])

  banner()

  // WAXWING_E2E=1 switches on the same-origin Stalwart proxy for `vite preview` (vite.config.ts).
  preview = spawn(
    'pnpm',
    ['--filter', '@waxwing/web', 'exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: 'inherit', env: { ...process.env, WAXWING_E2E: '1' } },
  )
  await new Promise((resolve) => preview.on('exit', resolve))
} finally {
  teardown()
}
