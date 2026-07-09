// Waxwing SP.3 — instrumented push-transport demo (dependency-free Node ≥ 22 builtins only).
//
// Against a RUNNING Stalwart fixture (pnpm e2e:server), this opens BOTH JMAP push transports,
// delivers a mail via Email/set, and prints the observed StateChange latency per transport:
//
//   pnpm e2e:server                 # bring the fixture up first
//   node scripts/push-demo.mjs      # this demo
//   pnpm e2e:server:down            # tear the fixture down
//
// It deliberately uses only Node builtins (fetch, global WebSocket, TextDecoder) and speaks
// the exact auth mechanisms @waxwing/jmap implements, as proven by the SP.3 probe:
//   - SSE  : a fetch() + ReadableStream reader sending `Authorization` (native EventSource
//            cannot set headers, and Stalwart's SSE endpoint accepts only header auth).
//   - WS   : an RFC 8887 WebSocket whose Upgrade carries `Authorization` (undici supports the
//            header; browsers cannot, so against Stalwart WS is a Node/server-side transport).
//
// Env overrides: WAXWING_BASE, WAXWING_USER, WAXWING_PASS.

const BASE = process.env.WAXWING_BASE ?? 'http://localhost:18080'
const USER = process.env.WAXWING_USER ?? 'alice@waxwing.test'
const PASS = process.env.WAXWING_PASS ?? 'waxwing-e2e-Pw1!'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const MAIL = 'urn:ietf:params:jmap:mail'
const CORE = 'urn:ietf:params:jmap:core'

const die = (message) => {
  console.error(`[push-demo] ${message}`)
  process.exit(1)
}

async function getSession() {
  const res = await fetch(`${BASE}/.well-known/jmap`, {
    headers: { Authorization: AUTH, Accept: 'application/json' },
    redirect: 'follow',
  })
  if (!res.ok) die(`session fetch failed: HTTP ${res.status} (is the fixture up? pnpm e2e:server)`)
  return res.json()
}

async function jmap(session, methodCalls) {
  const res = await fetch(session.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: AUTH,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ using: [CORE, MAIL], methodCalls }),
  })
  if (!res.ok) die(`JMAP request failed: HTTP ${res.status} — ${await res.text()}`)
  return res.json()
}

async function findInbox(session, accountId) {
  const body = await jmap(session, [
    ['Mailbox/get', { accountId, ids: null, properties: ['id', 'role'] }, '0'],
  ])
  const list = body.methodResponses[0][1].list
  const inbox = list.find((m) => m.role === 'inbox') ?? list[0]
  if (!inbox) die('no mailbox found on the account')
  return inbox.id
}

async function deliverMail(session, accountId, inboxId, label) {
  const body = await jmap(session, [
    [
      'Email/set',
      {
        accountId,
        create: {
          seed: {
            mailboxIds: { [inboxId]: true },
            keywords: {},
            from: [{ name: 'Alice', email: USER }],
            to: [{ name: 'Alice', email: USER }],
            subject: `Waxwing SP.3 push-demo ${label} ${Date.now().toString(36)}`,
            textBody: [{ partId: 't', type: 'text/plain' }],
            bodyValues: { t: { value: `push-demo ${label}` } },
          },
        },
      },
      '0',
    ],
  ])
  const created = body.methodResponses[0][1].created?.seed
  if (!created) die(`Email/set failed: ${JSON.stringify(body.methodResponses[0][1].notCreated)}`)
  return created.id
}

const expand = (template, vars) => template.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '')

// ── WebSocket (RFC 8887) ────────────────────────────────────────────────────────────────
async function measureWebSocket(session, accountId, inboxId) {
  const cap = session.capabilities['urn:ietf:params:jmap:websocket']
  if (!cap?.url) return { transport: 'WebSocket', skipped: 'capability not advertised' }
  const ws = new WebSocket(cap.url, { headers: { Authorization: AUTH }, protocols: ['jmap'] })

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('WS error before open'))
    setTimeout(() => reject(new Error('WS open timeout')), 8000)
  })
  await opened
  ws.send(
    JSON.stringify({
      '@type': 'WebSocketPushEnable',
      dataTypes: ['Email', 'Mailbox', 'Thread', 'EmailDelivery'],
    }),
  )

  const gotState = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no StateChange within 15s')), 15000)
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data)
      if (frame['@type'] === 'StateChange' && frame.changed[accountId]?.Email) {
        clearTimeout(timer)
        resolve(frame.changed[accountId])
      }
    }
  })

  const t0 = Date.now()
  await deliverMail(session, accountId, inboxId, 'ws')
  const types = await gotState
  const latency = Date.now() - t0
  ws.close(1000)
  return { transport: 'WebSocket', latency, types: Object.keys(types) }
}

// ── SSE (fetch-based reader) ────────────────────────────────────────────────────────────
async function measureSse(session, accountId, inboxId) {
  const url = expand(session.eventSourceUrl, { types: '*', closeafter: 'no', ping: '30' })
  const ac = new AbortController()
  const res = await fetch(url, {
    headers: { Authorization: AUTH, Accept: 'text/event-stream' },
    signal: ac.signal,
  })
  if (res.status !== 200) die(`SSE connect failed: HTTP ${res.status}`)

  let resolveState
  const gotState = new Promise((resolve, reject) => {
    resolveState = resolve
    setTimeout(() => reject(new Error('no StateChange within 15s')), 15000)
  })

  // Minimal fetch-SSE reader (the package ships the full multi-line/CRLF/BOM parser).
  ;(async () => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (let sep = buffer.indexOf('\n\n'); sep !== -1; sep = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
          if (parsed['@type'] === 'StateChange' && parsed.changed[accountId]?.Email) {
            resolveState(parsed.changed[accountId])
            return
          }
        } catch {
          // keep-alive / non-JSON frame
        }
      }
    }
  })().catch(() => {})

  const t0 = Date.now()
  await deliverMail(session, accountId, inboxId, 'sse')
  const types = await gotState
  const latency = Date.now() - t0
  ac.abort()
  return { transport: 'SSE', latency, types: Object.keys(types) }
}

async function main() {
  const session = await getSession()
  const accountId = session.primaryAccounts[MAIL]
  if (!accountId) die('no primary mail account (bad credentials?)')
  const inboxId = await findInbox(session, accountId)
  console.log(`[push-demo] fixture ${BASE} · account ${accountId} · inbox ${inboxId}\n`)

  const results = []
  results.push(await measureWebSocket(session, accountId, inboxId))
  results.push(await measureSse(session, accountId, inboxId))

  console.log('\n[push-demo] StateChange latency per transport:')
  for (const r of results) {
    if (r.skipped) console.log(`  ${r.transport.padEnd(10)} — skipped (${r.skipped})`)
    else
      console.log(
        `  ${r.transport.padEnd(10)} ${String(r.latency).padStart(5)} ms   changed: ${r.types.join(', ')}`,
      )
  }
}

main().catch((error) => die(error.stack ?? error.message))
