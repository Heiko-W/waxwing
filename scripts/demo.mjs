// Waxwing SP.4 — one-command raw end-to-end demo (dependency-free, Node >= 22 builtins only).
//
//   pnpm demo          → serve at http://localhost:5173 (secure context: Basic + OAuth work)
//   pnpm demo --lan    → serve at http://<your-lan-ip>:5173 so another machine can open it
//
// It (1) picks the browser origin, (2) brings the Stalwart fixture up advertising THAT origin
// (STALWART_PUBLIC_URL) so a same-origin Vite proxy is enough — no CORS, no cross-origin
// loopback (SP.4 probe Q1), (3) seeds alice's inbox with deterministic demo mail, (4) starts
// Vite with the demo flag + proxy, prints a banner, and (5) ALWAYS tears the fixture down on
// exit / Ctrl-C (try/finally + signal handlers, like scripts/verify-e2e.mjs).
//
// Env overrides: WAXWING_DEMO_ORIGIN (wins), WAXWING_DEMO_PORT (default 5173).

import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { ACCOUNTS, down, up } from '../e2e/stalwart/fixture.mjs'
import { seedDemoMail } from '../e2e/stalwart/seed-demo.mjs'

const PORT = Number(process.env.WAXWING_DEMO_PORT ?? '5173')
const LAN = process.argv.includes('--lan')
const [alice] = ACCOUNTS

// `networkInterfaces()` has no defined order, and a dev box carries Docker bridges, VPNs and
// container networks alongside the real NIC. Taking the first non-internal address would
// happily advertise something like 172.20.6.1, which no other machine on the LAN can reach.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|tun|tap|wg|tailscale|zt)/i

/** The LAN IPv4 another machine can reach, preferring physical NICs over virtual ones. */
function primaryLanIPv4() {
  const candidates = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        candidates.push({ name, address: address.address })
      }
    }
  }
  // Stable sort: virtual interfaces last, original order preserved within each group.
  candidates.sort(
    (a, b) => Number(VIRTUAL_INTERFACE.test(a.name)) - Number(VIRTUAL_INTERFACE.test(b.name)),
  )
  const [best, ...rest] = candidates
  if (!best) return null
  if (rest.length > 0) {
    const all = candidates.map((c) => `${c.name}=${c.address}`).join(', ')
    console.log(`[demo] IPv4 candidates: ${all} — set WAXWING_DEMO_ORIGIN to override`)
  }
  return best.address
}

function resolveOrigin() {
  if (process.env.WAXWING_DEMO_ORIGIN) return process.env.WAXWING_DEMO_ORIGIN
  if (LAN) {
    const ip = primaryLanIPv4()
    if (!ip) throw new Error('--lan: could not detect a non-internal IPv4 address')
    return `http://${ip}:${PORT}`
  }
  return `http://localhost:${PORT}`
}

function isInsecureOrigin(origin) {
  const url = new URL(origin)
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  return url.protocol === 'http:' && !loopback
}

function banner(origin) {
  const line = '─'.repeat(58)
  console.log(`\n${line}`)
  console.log('  Waxwing raw demo is ready.')
  console.log(`  Open in a browser : ${origin}`)
  console.log(`  Sign in (Basic)   : ${alice.login} / ${alice.password}`)
  if (isInsecureOrigin(origin)) {
    console.log('')
    console.log('  ! Insecure origin (plain http, not localhost): crypto.subtle is')
    console.log('    unavailable, so OAuth and "stay signed in" do NOT work here.')
    console.log('    Basic sign-in works fine (it is pre-filled above).')
  } else {
    console.log('  OAuth             : available (secure context)')
  }
  console.log(`  Stop + tear down  : Ctrl-C`)
  console.log(`${line}\n`)
}

let vite = null
let tornDown = false
// Ownership guard: only `down()` a fixture this process got as far as starting. Set true once
// `up('dev')` resolves. Without it, an early failure — notably `up()`'s pre-check refusing to
// start while the `main` profile holds port 18080 — would run `compose … down -v` and
// volume-wipe a fixture the demo never owned. `up()` (like the rest of the fixture tooling)
// leaves its own containers standing on a mid-startup failure for the user to inspect and
// `pnpm e2e:server:down`, so declining to tear down here matches that contract.
//
// An already-running `dev` fixture is deliberately NOT protected: `compose up -d` recreates it
// with this run's STALWART_PUBLIC_URL — which it must, since the advertised origin has to match
// the browser's — so from that moment it is this process's to remove.
let broughtUp = false

function teardown() {
  if (tornDown || !broughtUp) return
  tornDown = true
  try {
    down()
  } catch (error) {
    console.error(`[demo] teardown failed: ${error.message}`)
  }
}

function shutdown(code) {
  if (vite && vite.exitCode === null) vite.kill('SIGTERM')
  teardown()
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    console.error(`\n[demo] ${signal} — shutting down`)
    shutdown(130)
  })
}

async function main() {
  const origin = resolveOrigin()
  // Stalwart advertises this exact origin in the session + OIDC docs (see docker-compose.yml).
  process.env.STALWART_PUBLIC_URL = origin

  console.log(`[demo] origin ${origin}`)
  await up('dev')
  // From here on the demo owns the dev fixture and teardown() may remove it.
  broughtUp = true
  console.log('[demo] seeding alice inbox with demo mail ...')
  const summary = await seedDemoMail()
  console.log(`[demo] seeded ${summary.created} mails (removed ${summary.removed} prior)`)

  const args = ['--filter', '@waxwing/web', 'exec', 'vite', '--port', String(PORT), '--strictPort']
  if (LAN) args.push('--host')

  vite = spawn('pnpm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      VITE_WAXWING_DEMO: '1',
      VITE_WAXWING_DEMO_USER: alice.login,
      VITE_WAXWING_DEMO_PASS: alice.password,
      VITE_WAXWING_DEMO_SERVER: origin,
      WAXWING_PROXY_TARGET: 'http://127.0.0.1:18080',
    },
  })

  banner(origin)

  vite.on('exit', (code) => {
    console.log(`\n[demo] vite exited (${code ?? 'signal'}) — tearing fixture down`)
    teardown()
    process.exit(code ?? 0)
  })
  vite.on('error', (error) => {
    console.error(`[demo] failed to start vite: ${error.message}`)
    shutdown(1)
  })
}

main().catch((error) => {
  console.error(`\n[demo] FAILED — ${error.stack ?? error.message}`)
  teardown()
  process.exit(1)
})
