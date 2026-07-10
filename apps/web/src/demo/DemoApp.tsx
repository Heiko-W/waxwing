/**
 * SP.4 raw end-to-end demo container (dev-only, throwaway — NOT production UI).
 *
 * It wires the real packages directly with no replica, no virtualization and no design
 * system: `apps/web/src/auth` {@link AuthController} for login (Basic + OAuth PKCE) and
 * `@waxwing/jmap` (`connect` / `JmapClient` / `Methods` / back-references / `download`) for
 * every call. It validates the plumbing FR-AUTH-01/04 and FR-MBX/FR-LST/FR-RD read paths and
 * answers the SP.5 `Email/parse` question from the UI.
 *
 * The presentational views (Login/MailboxList/MessageList/Message) are separate and pure so
 * they are unit- and axe-testable without a server; this container owns all I/O.
 */

import type { AuthProvider, Email, JmapClient, Mailbox } from '@waxwing/jmap'
import { connect, JmapHttpError, JmapMethodError, JmapProblemError, Methods } from '@waxwing/jmap'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthController, DEFAULT_CLIENT_ID, DEFAULT_SCOPES } from '../auth'
import { formatDate } from '../i18n/formatters'
import { formatAddresses, isUnread, joinBody, senderLabel } from './body'
import styles from './demo.module.css'
import { LoginView } from './LoginView'
import { MailboxListView } from './MailboxListView'
import { MessageListView, type MessageRow } from './MessageListView'
import { type AttachmentRow, MessageView, type ParsedMessage } from './MessageView'
import { DEMO_PAGE_SIZE, nextPosition, prevPosition } from './pagination'

/** Distinctive marker asserted absent from every production build (see main.tsx / verify). */
export const DEMO_MARKER = 'waxwing-sp4-raw-demo-marker'

const JMAP_MAIL = 'urn:ietf:params:jmap:mail'

const LIST_PROPERTIES = [
  'id',
  'subject',
  'from',
  'receivedAt',
  'preview',
  'hasAttachment',
  'keywords',
]
const MESSAGE_PROPERTIES = [
  'id',
  'blobId',
  'subject',
  'from',
  'to',
  'receivedAt',
  'preview',
  'hasAttachment',
  'textBody',
  'htmlBody',
  'attachments',
  'bodyValues',
  'keywords',
]
const BODY_PROPERTIES = ['partId', 'blobId', 'type', 'size', 'name', 'disposition', 'cid']

type Phase = 'login' | 'busy' | 'ready'

interface AccountInfo {
  id: string
  name: string
  username: string
}

interface MessageState {
  id: string
  subject: string | null
  from: string
  to: string
  receivedAt: string
  textBody: string
  htmlBody: string
  attachments: AttachmentRow[]
  rawJson: string
}

function oauthIsAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined'
  )
}

function describeError(error: unknown): string {
  if (error instanceof JmapMethodError)
    return `${error.type}: ${error.description ?? error.message}`
  if (error instanceof JmapProblemError) return `${error.type}: ${error.detail ?? error.message}`
  if (error instanceof JmapHttpError) return `HTTP ${error.status}`
  if (error instanceof Error) return error.message
  return String(error)
}

/** Role-first, then sortOrder, then name — a stable order for the demo tree. */
function sortMailboxes(list: Mailbox[]): Mailbox[] {
  const roleRank = (role: string | null): number => (role === 'inbox' ? 0 : role === null ? 2 : 1)
  return [...list].sort((a, b) => {
    const byRole = roleRank(a.role) - roleRank(b.role)
    if (byRole !== 0) return byRole
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.name.localeCompare(b.name)
  })
}

function toRow(email: Email): MessageRow {
  return {
    id: email.id,
    sender: senderLabel(email.from),
    subject: email.subject ?? null,
    preview: email.preview ?? '',
    receivedAt: email.receivedAt,
    hasAttachment: email.hasAttachment ?? false,
    unread: isUnread(email.keywords),
  }
}

function toMessageState(email: Email): MessageState {
  const attachments: AttachmentRow[] = (email.attachments ?? []).map((part, index) => ({
    key: part.blobId ?? `part-${index}`,
    blobId: part.blobId,
    type: part.type,
    name: part.name,
    size: part.size,
    isMessage: part.type === 'message/rfc822',
  }))
  // Only treat genuine text/html parts as the HTML body. For a text-only mail RFC 8621 puts
  // the text/plain part in BOTH textBody and htmlBody (so a bare htmlBody client still shows
  // something); rendering that as "HTML" would wrap plain text in the iframe, so filter it out.
  const htmlParts = (email.htmlBody ?? []).filter((part) => part.type === 'text/html')
  return {
    id: email.id,
    subject: email.subject ?? null,
    from: formatAddresses(email.from),
    to: formatAddresses(email.to),
    receivedAt: email.receivedAt,
    textBody: joinBody(email.textBody, email.bodyValues),
    htmlBody: joinBody(htmlParts, email.bodyValues),
    attachments,
    rawJson: JSON.stringify(email, null, 2),
  }
}

export function DemoApp() {
  const { t } = useTranslation()

  const [serverUrl, setServerUrl] = useState(
    () => import.meta.env.VITE_WAXWING_DEMO_SERVER || window.location.origin,
  )
  const [phase, setPhase] = useState<Phase>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [selectedMailbox, setSelectedMailbox] = useState<string | null>(null)
  const [rows, setRows] = useState<MessageRow[]>([])
  const [position, setPosition] = useState(0)
  const [total, setTotal] = useState(0)
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)
  const [mode, setMode] = useState<'html' | 'text'>('html')
  const [parsed, setParsed] = useState<Record<string, ParsedMessage>>({})

  const clientRef = useRef<JmapClient | null>(null)
  const controllerRef = useRef<AuthController | null>(null)
  const accountIdRef = useRef<string | null>(null)
  const oauthAvailable = useRef(oauthIsAvailable()).current

  function makeController(issuer: string): AuthController {
    return new AuthController({
      oauth: { issuer, clientId: DEFAULT_CLIENT_ID, scopes: DEFAULT_SCOPES },
    })
  }

  async function loadMailboxes(client: JmapClient, accountId: string): Promise<void> {
    const builder = client.request()
    const get = builder.invoke(Methods.mailboxGet, { accountId, ids: null })
    const response = await builder.send()
    const sorted = sortMailboxes(response.get(get).list)
    setMailboxes(sorted)
    const inbox = sorted.find((mailbox) => mailbox.role === 'inbox') ?? sorted[0]
    if (inbox) await loadPage(client, accountId, inbox.id, 0)
  }

  async function loadPage(
    client: JmapClient,
    accountId: string,
    mailboxId: string,
    pos: number,
  ): Promise<void> {
    // One request: Email/query -> Email/get via the '#ids' back-reference (RFC 8620 §3.7).
    const builder = client.request()
    const query = builder.invoke(Methods.emailQuery, {
      accountId,
      filter: { inMailbox: mailboxId },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: false,
      position: pos,
      limit: DEMO_PAGE_SIZE,
      calculateTotal: true,
    })
    const get = builder.invoke(Methods.emailGet, {
      accountId,
      '#ids': query.ref('/ids'),
      properties: LIST_PROPERTIES,
    })
    const response = await builder.send()
    const queryResult = response.get(query)
    const byId = new Map(response.get(get).list.map((email) => [email.id, email]))
    const nextRows: MessageRow[] = []
    for (const id of queryResult.ids) {
      const email = byId.get(id)
      if (email) nextRows.push(toRow(email))
    }
    setRows(nextRows)
    setPosition(queryResult.position)
    setTotal(queryResult.total ?? nextRows.length)
    setSelectedMailbox(mailboxId)
  }

  async function connectAndLoad(provider: AuthProvider, url: string): Promise<void> {
    const client = await connect(url, provider)
    clientRef.current = client
    const session = client.session
    const accountId = session.primaryAccounts[JMAP_MAIL]
    if (!accountId) throw new Error(t('demo.error.noAccount'))
    accountIdRef.current = accountId
    const acct = session.accounts[accountId]
    setAccount({ id: accountId, name: acct?.name ?? accountId, username: session.username })
    await loadMailboxes(client, accountId)
    setPhase('ready')
  }

  // Handle an OAuth redirect callback (or restore a persisted session) on first mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-once effect; serverUrl default is stable across the OAuth callback path.
  useEffect(() => {
    const controller = makeController(serverUrl)
    controllerRef.current = controller
    let cancelled = false
    void (async () => {
      try {
        if (controller.isRedirectCallback()) {
          setPhase('busy')
          setBusy(true)
          await controller.completeRedirect()
          const provider = controller.getAuthProvider()
          if (!cancelled) await connectAndLoad(provider, serverUrl)
          return
        }
        // restore() only touches crypto.subtle when a secret exists (secure-context OAuth),
        // so it is safe on an insecure origin; guard anyway so boot never throws.
        const restored = await controller.restore().catch(() => null)
        if (restored && !cancelled) {
          setPhase('busy')
          setBusy(true)
          await connectAndLoad(restored.authProvider, serverUrl)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(describeError(caught))
          setPhase('login')
        }
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleBasicLogin(username: string, password: string): Promise<void> {
    setBusy(true)
    setError(null)
    setPhase('busy')
    try {
      const controller = makeController(serverUrl)
      controllerRef.current = controller
      await controller.startLogin({ method: 'basic', username, password })
      await connectAndLoad(controller.getAuthProvider(), serverUrl)
    } catch (caught) {
      setError(describeError(caught))
      setPhase('login')
    } finally {
      setBusy(false)
    }
  }

  async function handleOAuthLogin(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const controller = makeController(serverUrl)
      controllerRef.current = controller
      // Navigates the whole page to Stalwart's /login; execution ends here on success.
      await controller.startLogin({ method: 'oauth' })
    } catch (caught) {
      setError(describeError(caught))
      setBusy(false)
    }
  }

  async function selectMailbox(mailboxId: string): Promise<void> {
    const client = clientRef.current
    const accountId = accountIdRef.current
    if (!client || !accountId) return
    setBusy(true)
    setError(null)
    setSelectedEmail(null)
    setMessage(null)
    setParsed({})
    try {
      await loadPage(client, accountId, mailboxId, 0)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function goToPage(pos: number): Promise<void> {
    const client = clientRef.current
    const accountId = accountIdRef.current
    if (!client || !accountId || !selectedMailbox) return
    setBusy(true)
    setError(null)
    try {
      await loadPage(client, accountId, selectedMailbox, pos)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function selectEmail(id: string): Promise<void> {
    const client = clientRef.current
    const accountId = accountIdRef.current
    if (!client || !accountId) return
    setBusy(true)
    setError(null)
    try {
      const builder = client.request()
      const get = builder.invoke(Methods.emailGet, {
        accountId,
        ids: [id],
        properties: MESSAGE_PROPERTIES,
        bodyProperties: BODY_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
      })
      const response = await builder.send()
      const email = response.get(get).list[0]
      if (!email) throw new Error(t('demo.error.notFound'))
      const state = toMessageState(email)
      setMessage(state)
      setSelectedEmail(id)
      setParsed({})
      setMode(state.htmlBody.length > 0 ? 'html' : 'text')
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function downloadAttachment(attachment: AttachmentRow): Promise<void> {
    const client = clientRef.current
    const accountId = accountIdRef.current
    if (!client || !accountId || !attachment.blobId) return
    setBusy(true)
    setError(null)
    try {
      // Blobs need the Authorization header (no <a href> shortcut): fetch bytes, then hand
      // the user a blob: URL and revoke it after the download has had a chance to start.
      const bytes = await client.download(
        accountId,
        attachment.blobId,
        attachment.type,
        attachment.name ?? 'attachment',
      )
      // Copy into a fresh ArrayBuffer-backed view so the Blob part type is concrete.
      const blob = new Blob([new Uint8Array(bytes)], { type: attachment.type })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = attachment.name ?? 'attachment'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function parseAttachment(attachment: AttachmentRow): Promise<void> {
    const client = clientRef.current
    const accountId = accountIdRef.current
    if (!client || !accountId || !attachment.blobId) return
    setBusy(true)
    setError(null)
    try {
      const builder = client.request()
      const parse = builder.invoke(Methods.emailParse, {
        accountId,
        blobIds: [attachment.blobId],
        properties: [
          'messageId',
          'from',
          'to',
          'subject',
          'receivedAt',
          'textBody',
          'bodyValues',
          'preview',
        ],
        bodyProperties: ['partId', 'blobId', 'type', 'size'],
        fetchTextBodyValues: true,
      })
      const response = await builder.send()
      const result = response.get(parse)
      const inner = result.parsed[attachment.blobId]
      if (!inner) throw new Error(t('demo.error.notParsable'))
      setParsed((previous) => ({
        ...previous,
        [attachment.key]: {
          subject: inner.subject ?? null,
          from: formatAddresses(inner.from),
          text: joinBody(inner.textBody, inner.bodyValues),
        },
      }))
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await controllerRef.current?.logout()
    } catch {
      // Best-effort — reset the UI regardless.
    }
    clientRef.current = null
    accountIdRef.current = null
    setPhase('login')
    setAccount(null)
    setMailboxes([])
    setSelectedMailbox(null)
    setRows([])
    setPosition(0)
    setTotal(0)
    setSelectedEmail(null)
    setMessage(null)
    setParsed({})
    setError(null)
  }

  return (
    <div className={styles.demo} data-waxwing-demo={DEMO_MARKER}>
      <header className={styles.topbar}>
        <h1 className={styles.title}>{t('demo.title')}</h1>
        {account && (
          <div className={styles.accountBar}>
            <span className={styles.accountName}>
              {t('demo.account', { name: account.username || account.name })}
            </span>
            <button type="button" className={styles.secondary} onClick={() => void handleLogout()}>
              {t('demo.logout')}
            </button>
          </div>
        )}
      </header>

      <div className={styles.errorRegion} aria-live="polite">
        {error && <p className={styles.error}>{error}</p>}
      </div>

      {phase === 'login' ? (
        <LoginView
          serverUrl={serverUrl}
          onServerUrlChange={setServerUrl}
          onBasicSubmit={(username, password) => void handleBasicLogin(username, password)}
          onOAuth={() => void handleOAuthLogin()}
          oauthAvailable={oauthAvailable}
          defaultUsername={import.meta.env.VITE_WAXWING_DEMO_USER ?? ''}
          defaultPassword={import.meta.env.VITE_WAXWING_DEMO_PASS ?? ''}
          busy={busy}
        />
      ) : !account ? (
        <p className={styles.hint}>{t('demo.loading')}</p>
      ) : (
        <div className={styles.workspace}>
          <MailboxListView
            mailboxes={mailboxes}
            selectedId={selectedMailbox}
            onSelect={(id) => void selectMailbox(id)}
          />
          <MessageListView
            rows={rows}
            position={position}
            total={total}
            pageSize={DEMO_PAGE_SIZE}
            selectedId={selectedEmail}
            busy={busy}
            onSelect={(id) => void selectEmail(id)}
            onPrev={() => void goToPage(prevPosition(position, DEMO_PAGE_SIZE))}
            onNext={() => void goToPage(nextPosition(position, DEMO_PAGE_SIZE, total))}
          />
          {message ? (
            <MessageView
              subject={message.subject}
              from={message.from}
              to={message.to}
              date={formatDate(new Date(message.receivedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              textBody={message.textBody}
              htmlBody={message.htmlBody}
              mode={mode}
              onToggleMode={setMode}
              attachments={message.attachments}
              onDownload={(attachment) => void downloadAttachment(attachment)}
              onParse={(attachment) => void parseAttachment(attachment)}
              parsed={parsed}
              rawJson={message.rawJson}
              busy={busy}
            />
          ) : (
            <p className={styles.placeholder}>{t('demo.message.select')}</p>
          )}
        </div>
      )}
    </div>
  )
}
