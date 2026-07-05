// Waxwing — Stalwart JMAP dev/E2E fixture control script (WP P0.4).
//
// Subcommands (see the e2e package `server:*` scripts and ./README.md):
//   up [profile]  compose up -d -> wait ready -> provision accounts -> smoke check
//   down          compose down -v (removes containers + ephemeral volumes)
//   provision     idempotent: create the test domain + accounts over the JMAP mgmt API
//   smoke         assert the fixture is a working, auth-enforcing JMAP server
//   status        print container state + connection details
//
// No third-party deps — Node >= 22 globals only (fetch, URL, Buffer). The functions and
// constants are also exported for a future Playwright global-setup (M1.9).

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const COMPOSE_FILE = fileURLToPath(new URL('./docker-compose.yml', import.meta.url))

export const HOST_PORT = 18080
export const BASE_URL = `http://localhost:${HOST_PORT}`

// Stalwart rejects `test.example`; use the RFC 6761 reserved `.test` TLD (never resolves
// on the public internet) — see docs/adr/002.
export const DOMAIN = 'waxwing.test'

// One shared, dev-only password for every fixture account (admin + users). World-known by
// design: this server is local, plain-HTTP and ephemeral. Never reuse it anywhere real.
export const PASSWORD = 'waxwing-e2e-Pw1!'

// The stable master admin, provided to the container via STALWART_RECOVERY_ADMIN.
export const ADMIN = { login: 'admin', password: PASSWORD }

// Test users, provisioned under DOMAIN with PASSWORD. `login` is the full Basic/JMAP name.
export const ACCOUNTS = [
  { name: 'alice', description: 'Alice Anderson (Waxwing e2e)' },
  { name: 'bob', description: 'Bob Baker (Waxwing e2e)' },
  { name: 'carol', description: 'Carol Chen (Waxwing e2e)' },
].map((account) => ({ ...account, login: `${account.name}@${DOMAIN}`, password: PASSWORD }))

const JMAP_URL = `${BASE_URL}/jmap`
const SESSION_URL = `${BASE_URL}/.well-known/jmap` // 307 -> /jmap/session
const MGMT_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']

// Container names per profile (see docker-compose.yml `container_name`). Both variants bind
// the same host port, so at most one may run at a time — used by the conflict preflight.
const CONTAINER = { dev: 'waxwing-stalwart-dev', main: 'waxwing-stalwart-main' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const basicAuth = (login, password) =>
  `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`

const isNonEmptyObject = (value) =>
  !!value && typeof value === 'object' && Object.keys(value).length > 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function compose(args) {
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit' })
}

// Fail fast with an actionable message if Docker itself is missing/stopped, instead of
// letting a raw ENOENT / "Cannot connect to the Docker daemon" dump surface from deep in
// execFileSync. Runs before any compose invocation in up()/down().
function preflightDocker() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
  } catch {
    throw new Error(
      'Docker not found or not running — install/start Docker (docker + docker compose) and retry.',
    )
  }
}

// Refuse to start one profile while the other is already up: both bind host port 18080, so
// compose would otherwise fail with a raw "port is already allocated". Give the actionable
// remedy instead.
function assertNoConflictingProfile(profile) {
  const other = profile === 'dev' ? 'main' : 'dev'
  const running = execFileSync(
    'docker',
    ['ps', '--filter', `name=${CONTAINER[other]}`, '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
  if (running) {
    throw new Error(
      `${CONTAINER[other]} is already using port ${HOST_PORT} — run ` +
        `\`pnpm e2e:server:down\` first, then \`up ${profile}\`.`,
    )
  }
}

// Poll the JMAP session endpoint until the server answers 200 (listener up + datastore
// ready). The task's readiness signal for `e2e:server`. Budget (120s) is kept >= the
// compose healthcheck window (start_period 5s + 24 * 5s ~= 125s) so a slow cold boot on a
// busy CI runner is not tripped by this poll before the container would report healthy.
async function waitForReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(SESSION_URL, { redirect: 'follow' })
      if (res.status === 200) return
    } catch {
      // Listener not accepting connections yet — keep polling.
    }
    if (Date.now() > deadline) throw new Error(`Stalwart not ready after ${timeoutMs} ms`)
    await sleep(500)
  }
}

// A single-call JMAP management request, authenticated as the recovery admin.
async function jmap(methodCalls) {
  const res = await fetch(JMAP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: basicAuth(ADMIN.login, ADMIN.password),
    },
    body: JSON.stringify({ using: MGMT_USING, methodCalls }),
  })
  if (!res.ok) throw new Error(`JMAP request failed: HTTP ${res.status} — ${await res.text()}`)
  const [name, args] = (await res.json()).methodResponses[0]
  if (name === 'error') throw new Error(`JMAP error: ${JSON.stringify(args)}`)
  return args
}

async function queryFirstId(object, filter) {
  const args = await jmap([[`x:${object}/query`, { filter }, '0']])
  return args.ids[0] ?? null
}

async function ensureDomain() {
  const existing = await queryFirstId('Domain', { name: DOMAIN })
  if (existing) return { id: existing, created: false }
  const args = await jmap([
    ['x:Domain/set', { create: { d: { name: DOMAIN, isEnabled: true } } }, '0'],
  ])
  const created = args.created?.d
  if (!created) throw new Error(`Domain ${DOMAIN} not created: ${JSON.stringify(args.notCreated)}`)
  return { id: created.id, created: true }
}

async function ensureAccount(account, domainId) {
  const existing = await queryFirstId('Account', { name: account.name })
  if (existing) return { ...account, id: existing, created: false }
  const args = await jmap([
    [
      'x:Account/set',
      {
        create: {
          a: {
            '@type': 'User',
            name: account.name,
            description: account.description,
            domainId,
            credentials: { 0: { '@type': 'Password', secret: account.password } },
          },
        },
      },
      '0',
    ],
  ])
  const created = args.created?.a
  if (!created) {
    throw new Error(`Account ${account.login} not created: ${JSON.stringify(args.notCreated)}`)
  }
  return { ...account, id: created.id, created: true }
}

// Idempotent: query-before-create, so it is safe to run on every `up`.
export async function provision() {
  const domain = await ensureDomain()
  console.log(`  domain ${DOMAIN} -> ${domain.id} ${domain.created ? '(created)' : '(exists)'}`)
  for (const account of ACCOUNTS) {
    const result = await ensureAccount(account, domain.id)
    const state = result.created ? '(created)' : '(exists)'
    console.log(`  account ${result.login} -> ${result.id} ${state}`)
  }
}

// The P0.4 Done-when smoke check. Asserts the fixture is a working, auth-enforcing JMAP
// server. Note (docs/adr/002): an UNAUTHENTICATED session request returns 200 with an
// anonymous, capabilities-only document (empty accounts/username) — Stalwart v0.16 does
// NOT 401 there. We assert the security-equivalent invariant (no account data leaks) plus
// a hard 401 for INVALID credentials, and a full parseable session for VALID credentials.
export async function smoke() {
  const [alice] = ACCOUNTS

  const anon = await fetch(SESSION_URL, { redirect: 'follow' })
  assert(anon.status === 200, `unauth session: expected 200, got ${anon.status}`)
  const anonDoc = await anon.json()
  assert(isNonEmptyObject(anonDoc.capabilities), 'unauth session: missing capabilities')
  assert(Object.keys(anonDoc.accounts ?? {}).length === 0, 'unauth session leaked accounts')
  assert(!anonDoc.username, 'unauth session leaked a username')

  const badRes = await fetch(`${BASE_URL}/jmap/session`, {
    headers: { authorization: basicAuth('nobody', 'wrong-password') },
  })
  assert(badRes.status === 401, `invalid credentials: expected 401, got ${badRes.status}`)

  const okRes = await fetch(SESSION_URL, {
    headers: { authorization: basicAuth(alice.login, alice.password) },
    redirect: 'follow',
  })
  assert(okRes.status === 200, `auth session: expected 200, got ${okRes.status}`)
  const doc = await okRes.json()
  assert(isNonEmptyObject(doc.capabilities), 'auth session: missing capabilities')
  assert(isNonEmptyObject(doc.accounts), 'auth session: missing accounts')
  assert(doc.username === alice.login, `auth session: username ${doc.username} != ${alice.login}`)

  console.log('  unauth  /.well-known/jmap -> 200 anonymous (no accounts) [ADR-002]')
  console.log('  invalid Basic             -> 401')
  console.log(`  ${alice.login}  -> 200 session, accounts=${Object.keys(doc.accounts).join(',')}`)
}

function printReady() {
  console.log('\n[fixture] Stalwart is up and provisioned.')
  console.log(`  JMAP base URL : ${BASE_URL}`)
  console.log(`  Session       : ${SESSION_URL}  (307 -> /jmap/session)`)
  console.log(`  OIDC discovery: ${BASE_URL}/.well-known/openid-configuration`)
  console.log(`  Admin (Basic) : ${ADMIN.login} / ${ADMIN.password}`)
  console.log(`  Accounts      : ${ACCOUNTS.map((a) => a.login).join(', ')}`)
  console.log(`  Shared pass   : ${PASSWORD}`)
  console.log('  Tear down     : pnpm e2e:server:down\n')
}

export async function up(profile = 'dev') {
  preflightDocker()
  assertNoConflictingProfile(profile)
  console.log(`[fixture] compose up (profile: ${profile})`)
  // The `main` compat profile tracks the mutable `:latest` tag; force a fresh pull so a
  // persistent/self-hosted runner cannot silently test a stale cached image. The pinned
  // `dev` baseline is immutable-by-tag, so no forced pull there.
  const pull = profile === 'main' ? ['--pull', 'always'] : []
  compose(['--profile', profile, 'up', '-d', ...pull])
  console.log('[fixture] waiting for Stalwart to become ready ...')
  try {
    await waitForReady()
  } catch (error) {
    // Dump container state + logs before bailing: on a CI runner you cannot SSH into, an
    // opaque readiness timeout is otherwise near-impossible to triage.
    console.error('[fixture] readiness timed out — dumping container diagnostics:')
    try {
      compose(['--profile', profile, 'ps'])
      compose(['--profile', profile, 'logs', '--no-color'])
    } catch {
      // Best-effort diagnostics only — surface the original timeout regardless.
    }
    throw error
  }
  console.log('[fixture] provisioning test domain + accounts ...')
  await provision()
  console.log('[fixture] smoke check ...')
  await smoke()
  printReady()
}

export function down() {
  preflightDocker()
  console.log('[fixture] compose down -v (removes containers + ephemeral volumes)')
  // Enable BOTH profiles so `down` removes whichever variant is running: compose skips
  // profiled services whose profile is not active, even on teardown.
  compose(['--profile', 'dev', '--profile', 'main', 'down', '-v', '--remove-orphans'])
}

function status() {
  compose(['ps'])
}

const COMMANDS = {
  up: () => up(process.argv[3]),
  down: () => down(),
  provision: () => provision(),
  smoke: () => smoke(),
  status: () => status(),
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const run = COMMANDS[process.argv[2]]
  if (!run) {
    console.error(`usage: node fixture.mjs <${Object.keys(COMMANDS).join('|')}> [profile]`)
    process.exit(2)
  }
  Promise.resolve(run()).catch((error) => {
    console.error(`[fixture] ${error.message}`)
    process.exit(1)
  })
}
