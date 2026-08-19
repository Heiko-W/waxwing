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
import { fetchThrottled } from './http.mjs'

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

// The compose project name (`name:` in docker-compose.yml) prefixes every named volume.
const VOLUME = {
  dev: 'waxwing-stalwart_stalwart-data',
  main: 'waxwing-stalwart_stalwart-main-data',
}

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

function dockerOut(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * Warn when the data volume is OLDER than the image now running on it.
 *
 * Stalwart seeds its first-boot defaults only into a VIRGIN registry — the whole block in
 * `crates/common/src/manager/defaults.rs` is nested inside `if count_object(OidcProvider) == 0`, and
 * that includes the RFC 9749 VAPID keypair v0.16.14 generates. The registry lives in a NAMED volume
 * that `up` deliberately does NOT remove (that would destroy seeded state without asking; `down -v`
 * is the explicit, data-losing step). So the ordinary upgrade path — bump the pinned tag, run `up` —
 * boots a new binary against a registry an older version populated, and those defaults are silently
 * never generated. The symptom surfaces far away, as a capability the pinned version is supposed to
 * have simply being absent (`e2e/tests/settings.spec.ts` fails on its premise while the pin is fine).
 *
 * A volume created BEFORE the image was built cannot have been populated by that image, which makes
 * this a cheap and general detector — no per-version knowledge, no capability list to maintain.
 *
 * It only ever WARNS: it never blocks `up` and never deletes data. It is also strictly best-effort —
 * every failure path (docker output shape changed, volume not created yet, unparseable timestamps)
 * falls through silently, because a diagnostic must not be able to break the fixture it diagnoses.
 */
function warnIfVolumePredatesImage(profile) {
  try {
    const volume = VOLUME[profile]
    if (!volume) return
    const volumeAt = Date.parse(
      dockerOut(['volume', 'inspect', '--format', '{{.CreatedAt}}', volume]),
    )
    const imageId = dockerOut(['inspect', '--format', '{{.Image}}', CONTAINER[profile]])
    const imageAt = Date.parse(dockerOut(['image', 'inspect', '--format', '{{.Created}}', imageId]))
    if (!Number.isFinite(volumeAt) || !Number.isFinite(imageAt) || volumeAt >= imageAt) return
    console.warn(
      `[fixture] WARNING: the data volume ${volume} predates the image it is running on.\n` +
        "  It was populated by an OLDER Stalwart, so this version's first-boot defaults (the\n" +
        '  RFC 9749 VAPID keypair among them) were never generated and capabilities may be missing.\n' +
        '  If you just bumped the pinned tag: `pnpm e2e:server:down` then `pnpm e2e:server`.\n' +
        '  That DELETES all fixture data — see e2e/stalwart/README.md "Upgrading the pinned image".',
    )
  } catch {
    // Best-effort diagnostic only — never let it fail `up`.
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
      const res = await fetchThrottled(SESSION_URL, { redirect: 'follow' })
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
  const res = await fetchThrottled(JMAP_URL, {
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

/**
 * Give every test account a disk quota (M3.7, FR-QTA-01).
 *
 * Stalwart advertises `urn:ietf:params:jmap:quota` out of the box but returns an EMPTY `Quota/get`
 * list until an account actually HAS one — so without this, the quota bar has nothing to reflect and
 * the M3.7 Done-when ("the quota bar reflects a filled test account") is untestable.
 *
 * The key is `maxDiskQuota`, camelCase: Stalwart's `quotas` map is keyed by its `StorageQuota` enum,
 * and `MaxDiskQuota` / `max-disk-quota` are both rejected with `invalidPatch`.
 *
 * 100 MB is chosen to be roomy: uploads are capped at 50 MB and the seeded corpora are tiny, so no
 * existing send/upload test can bump into it — but it is small enough that a filled account moves
 * the bar. Idempotent, like the rest of `provision()`.
 */
const ACCOUNT_QUOTA_BYTES = 100 * 1024 * 1024

async function ensureQuota(accountId) {
  const args = await jmap([
    [
      'x:Account/set',
      { update: { [accountId]: { quotas: { maxDiskQuota: ACCOUNT_QUOTA_BYTES } } } },
      '0',
    ],
  ])
  if (args.notUpdated?.[accountId]) {
    throw new Error(`Quota not set on ${accountId}: ${JSON.stringify(args.notUpdated[accountId])}`)
  }
}

/**
 * Delegation, so M4.4 (shared accounts) is testable at all (M4.4 stage 4).
 *
 * Without this the fixture provisions three STANDALONE users, `secondaryMailAccounts()` returns `[]`
 * for every one of them, and every shared-account path in the app is dead code in every suite —
 * M4.4's own "Done when" ("a fixture delegation setup shows the shared mailbox") is unprovable.
 *
 * Established against the live fixture (Stalwart v0.16.14) rather than assumed:
 *
 *  - **Sharing is `Mailbox/set` + `shareWith`** (JMAP Sharing / `urn:ietf:params:jmap:mail:share`,
 *    which Stalwart advertises per account), keyed by the grantee's PRINCIPAL id. Principal ids and
 *    account ids coincide here — `Principal/query` returns the same short ids as the session's
 *    `accounts` map — but they are conceptually distinct, so we resolve principals explicitly.
 *  - **The grantor shares; the admin cannot do it for them.** Each `Mailbox/set` runs as the owning
 *    user, which is why this takes their Basic credentials rather than the recovery admin's.
 *  - **The grantee then sees the account** in `/.well-known/jmap` with `isPersonal: false` and
 *    `urn:ietf:params:jmap:mail` in that account's OWN `accountCapabilities` — which is exactly what
 *    `packages/jmap/src/session.ts` filters on — and sees ONLY the shared mailbox, not the whole tree.
 *  - **`Account.isReadOnly` stays `false` even for a read-only share.** The truth lives in each
 *    mailbox's `myRights`; the account flag is not a usable signal (this is why B34 gates on rights
 *    per mailbox, and why the account-level "Read only" badge cannot be trusted to mean anything).
 *  - Writes beyond the grant are rejected server-side, PER ID, as
 *    `notUpdated[id] = { type: 'forbidden', description: … }` — never wholesale.
 *
 * Two shares, so both halves are covered: bob grants alice READ-WRITE (triage must work), carol
 * grants alice READ-ONLY (triage must be refused).
 */
const DELEGATIONS = [
  { owner: 'bob', grantee: 'alice', access: 'rw' },
  { owner: 'carol', grantee: 'alice', access: 'ro' },
]

/** The two right-sets a share is granted with. `mayShare` stays false: a grantee may not re-share. */
const SHARE_RIGHTS = {
  rw: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: false,
    mayRename: false,
    mayDelete: false,
    maySubmit: false,
    mayShare: false,
  },
  ro: {
    mayReadItems: true,
    mayAddItems: false,
    mayRemoveItems: false,
    maySetSeen: false,
    maySetKeywords: false,
    mayCreateChild: false,
    mayRename: false,
    mayDelete: false,
    maySubmit: false,
    mayShare: false,
  },
}

const SHARE_USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:mail:share',
  'urn:ietf:params:jmap:principals',
]

/** A JMAP request as a regular USER (sharing is the grantor's own act, not the admin's). */
async function jmapAs(account, using, methodCalls) {
  const res = await fetchThrottled(JMAP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: basicAuth(account.login, account.password),
    },
    body: JSON.stringify({ using, methodCalls }),
  })
  if (!res.ok) throw new Error(`JMAP request failed: HTTP ${res.status} — ${await res.text()}`)
  const [name, args] = (await res.json()).methodResponses[0]
  if (name === 'error') throw new Error(`JMAP error: ${JSON.stringify(args)}`)
  return args
}

/** The account id the OWNER's own session names — the one their `Mailbox/set` must be scoped to. */
async function ownAccountId(account) {
  const res = await fetchThrottled(SESSION_URL, {
    headers: { authorization: basicAuth(account.login, account.password) },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`session for ${account.login}: HTTP ${res.status}`)
  const doc = await res.json()
  const id = Object.keys(doc.accounts ?? {}).find((key) => doc.accounts[key].isPersonal)
  if (!id) throw new Error(`no personal account in ${account.login}'s session`)
  return id
}

/** The grantee's principal id, as the OWNER's account can see it. */
async function principalIdFor(owner, ownerAccountId, granteeLogin) {
  const args = await jmapAs(owner, SHARE_USING, [
    ['Principal/get', { accountId: ownerAccountId, ids: null }, '0'],
  ])
  const found = (args.list ?? []).find(
    (principal) => principal.email === granteeLogin || principal.name === granteeLogin,
  )
  if (!found) throw new Error(`principal ${granteeLogin} not visible to ${owner.login}`)
  return found.id
}

/** Idempotent: `shareWith` is a full replacement, so re-writing the same grant is a no-op update. */
async function ensureDelegation({ owner, grantee, access }) {
  const ownerAccount = ACCOUNTS.find((a) => a.name === owner)
  const granteeAccount = ACCOUNTS.find((a) => a.name === grantee)
  if (!ownerAccount || !granteeAccount)
    throw new Error(`unknown delegation pair ${owner}/${grantee}`)

  const ownerAccountId = await ownAccountId(ownerAccount)
  const granteePrincipal = await principalIdFor(ownerAccount, ownerAccountId, granteeAccount.login)

  const boxes = await jmapAs(ownerAccount, SHARE_USING, [
    ['Mailbox/get', { accountId: ownerAccountId, ids: null, properties: ['id', 'role'] }, '0'],
  ])
  const inbox = (boxes.list ?? []).find((box) => box.role === 'inbox')
  if (!inbox) throw new Error(`${ownerAccount.login} has no inbox to share`)

  const args = await jmapAs(ownerAccount, SHARE_USING, [
    [
      'Mailbox/set',
      {
        accountId: ownerAccountId,
        update: { [inbox.id]: { shareWith: { [granteePrincipal]: SHARE_RIGHTS[access] } } },
      },
      '0',
    ],
  ])
  if (args.notUpdated?.[inbox.id]) {
    throw new Error(
      `share ${owner}->${grantee} rejected: ${JSON.stringify(args.notUpdated[inbox.id])}`,
    )
  }
  return { ownerAccountId, inboxId: inbox.id, granteePrincipal }
}

// Idempotent: query-before-create, so it is safe to run on every `up`.
export async function provision() {
  const domain = await ensureDomain()
  console.log(`  domain ${DOMAIN} -> ${domain.id} ${domain.created ? '(created)' : '(exists)'}`)
  for (const account of ACCOUNTS) {
    const result = await ensureAccount(account, domain.id)
    const state = result.created ? '(created)' : '(exists)'
    await ensureQuota(result.id)
    console.log(`  account ${result.login} -> ${result.id} ${state} quota=${ACCOUNT_QUOTA_BYTES}`)
  }
}

/**
 * NOTE for anyone tempted to give a fixture account an ALIAS (M5.1 nearly did):
 *
 * Stalwart mints one Identity per address the account owns, aliases included — measured, and it is
 * why the idea was dropped. A single alias therefore gives alice TWO identities, and `FromField`
 * renders its From selector from two identities up: every suite that opens the composer would grow a
 * control it has never had, which is the same trap `ensureDelegations` below documents for sharing.
 *
 * The identity editor does not need one anyway. RFC 8621 §6 explicitly allows several identities on
 * the SAME address ("for example, with different names/signatures"), Stalwart accepts that, and the
 * E2E suite creates one on alice's own address instead.
 */

/**
 * Grant every {@link DELEGATIONS} share. **Opt-in, called by the shared-account suite's setup — NOT
 * by `provision()`**, and that is a deliberate trade rather than tidiness.
 *
 * Delegation changes what alice's UI IS: with a shared account the sidebar switches from one folder
 * tree to account-grouped sections, so `getByRole('treeitem', { name: /Inbox/ })` — which 19 call
 * sites across 8 suites use — becomes ambiguous. Measured, not assumed: turning it on inside
 * `provision()` failed the whole read suite. Rewriting those call sites would have cost more than it
 * bought, and it would have cost something that matters more: the single-account path is Waxwing's
 * documented byte-for-byte invariant, and with delegation always on it would have had NO end-to-end
 * coverage left at all. So the default fixture stays single-account and the shared suite opts in.
 *
 * Pair it with {@link revokeDelegations} in that suite's teardown: `up` does not wipe the volume, so
 * a share left behind would silently reshape every later suite's sidebar.
 */
export async function ensureDelegations() {
  const granted = []
  for (const delegation of DELEGATIONS) {
    const { ownerAccountId, inboxId } = await ensureDelegation(delegation)
    granted.push({ ...delegation, ownerAccountId, inboxId })
    console.log(
      `  share ${delegation.owner}(${ownerAccountId}) inbox -> ${delegation.grantee} [${delegation.access}]`,
    )
  }
  return granted
}

/** Withdraw every share (`shareWith: {}`), returning the fixture to its single-account default. */
export async function revokeDelegations() {
  for (const { owner } of DELEGATIONS) {
    const ownerAccount = ACCOUNTS.find((a) => a.name === owner)
    if (!ownerAccount) continue
    const ownerAccountId = await ownAccountId(ownerAccount)
    const boxes = await jmapAs(ownerAccount, SHARE_USING, [
      ['Mailbox/get', { accountId: ownerAccountId, ids: null, properties: ['id', 'role'] }, '0'],
    ])
    const inbox = (boxes.list ?? []).find((box) => box.role === 'inbox')
    if (!inbox) continue
    await jmapAs(ownerAccount, SHARE_USING, [
      [
        'Mailbox/set',
        { accountId: ownerAccountId, update: { [inbox.id]: { shareWith: {} } } },
        '0',
      ],
    ])
  }
}

// The P0.4 Done-when smoke check. Asserts the fixture is a working, auth-enforcing JMAP
// server. Note (docs/adr/002): an UNAUTHENTICATED session request returns 200 with an
// anonymous, capabilities-only document (empty accounts/username) — Stalwart v0.16 does
// NOT 401 there. We assert the security-equivalent invariant (no account data leaks) plus
// a hard 401 for INVALID credentials, and a full parseable session for VALID credentials.
export async function smoke() {
  const [alice] = ACCOUNTS

  const anon = await fetchThrottled(SESSION_URL, { redirect: 'follow' })
  assert(anon.status === 200, `unauth session: expected 200, got ${anon.status}`)
  const anonDoc = await anon.json()
  assert(isNonEmptyObject(anonDoc.capabilities), 'unauth session: missing capabilities')
  assert(Object.keys(anonDoc.accounts ?? {}).length === 0, 'unauth session leaked accounts')
  assert(!anonDoc.username, 'unauth session leaked a username')

  const badRes = await fetchThrottled(`${BASE_URL}/jmap/session`, {
    headers: { authorization: basicAuth('nobody', 'wrong-password') },
  })
  assert(badRes.status === 401, `invalid credentials: expected 401, got ${badRes.status}`)

  const okRes = await fetchThrottled(SESSION_URL, {
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

  // The fixture's DEFAULT is single-account (M4.4). Asserted, because a stray share left behind by an
  // interrupted shared-account run would silently reshape every other suite's sidebar — the grouped
  // rail makes `treeitem name=/Inbox/` ambiguous — and the failure would look like anything but its
  // cause. `ensureDelegations()` is opt-in; `revokeDelegations()` puts it back.
  const shared = Object.entries(doc.accounts).filter(([, account]) => !account.isPersonal)
  assert(
    shared.length === 0,
    `fixture default: expected no shared accounts for ${alice.login}, got ${shared
      .map(([id, a]) => `${a.name}(${id})`)
      .join(', ')} — a previous shared-account run did not revoke`,
  )
  console.log(`  ${alice.login} sees no delegated account (fixture default)`)
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
  warnIfVolumePredatesImage(profile)
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
