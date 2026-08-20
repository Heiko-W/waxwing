import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { useComposerStore } from '../compose'
import {
  type EmailBodyRow,
  type EmailRow,
  putEmailBody,
  putMailboxes,
  type ReplicaDb,
  ReplicaProvider,
  setPref,
  toEmailRow,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { email, FULL_RIGHTS, freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { AUTO_MARK_READ_DELAY_MS, MessageView } from './MessageView'
import { useReadingStore } from './reading-store'
import { useBlobFetcher } from './use-blob'

/**
 * Reach a bar action the way a reader does, whether it is on the bar or behind the `⋯`.
 *
 * The bar shows PRIMARY_ACTIONS of them and hands the rest to the menu, so a test that only ever
 * looked for a button was testing the bar's composition rather than the action. This asks for the
 * action and lets the component decide where it lives — which is also what makes these tests
 * survive the next change to that composition.
 */
async function clickAction(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  const onBar = screen.queryByRole('button', { name })
  if (onBar !== null) {
    await waitFor(() => expect(onBar).toBeEnabled())
    await user.click(onBar)
    return
  }
  await user.click(await screen.findByRole('button', { name: 'More actions' }))
  const menu = await screen.findByRole('menu')
  await user.click(within(menu).getByRole('menuitem', { name: new RegExp(`^${name}`) }))
}

/**
 * Open the `⋯` menu once and answer "can the reader use this action" for anything inside it.
 *
 * Two shapes have to give the same answer: a bar button carries native `disabled`, a menu item
 * carries `aria-disabled` (and omits it entirely when enabled, so a `toHaveAttribute(…, 'false')`
 * assertion never matches). Asking the question once, here, keeps that difference out of the tests
 * that only care whether an action is offered.
 */
async function openOverflow(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'More actions' }))
  return await screen.findByRole('menu')
}

/**
 * The same trip, on `fireEvent` — for the dwell tests, which run on fake timers.
 *
 * `userEvent` schedules its own delays on the real clock, so it deadlocks under `vi.useFakeTimers`.
 * These tests were written with `fireEvent` for exactly that reason, and moving Mark-as-unread into
 * the overflow menu must not quietly convert them to the other library.
 */
function fireAction(name: string): void {
  const onBar = screen.queryByRole('button', { name })
  if (onBar !== null) {
    fireEvent.click(onBar)
    return
  }
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  const menu = screen.getByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(`^${name}`) }))
}

function isOffered(menu: HTMLElement, name: string): boolean {
  const item = within(menu).getByRole('menuitem', { name: new RegExp(`^${name}`) })
  return item.getAttribute('aria-disabled') !== 'true'
}

function part(over: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return {
    partId: null,
    blobId: null,
    size: 0,
    headers: [],
    name: null,
    type: 'text/plain',
    charset: null,
    disposition: null,
    cid: null,
    language: null,
    location: null,
    subParts: null,
    ...over,
  }
}
const val = (v: string): EmailBodyValue => ({
  value: v,
  isEncodingProblem: false,
  isTruncated: false,
})

function textBodyRow(id: string, text: string): EmailBodyRow & { authResults: string[] } {
  return {
    accountId: 'a',
    id,
    bodyValues: { t1: val(text) },
    bodyStructure: part({ partId: 't1' }),
    textBody: [part({ partId: 't1', type: 'text/plain' })],
    htmlBody: [part({ partId: 't1', type: 'text/plain' })],
    attachments: [],
    hasAttachment: false,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
  }
}

/**
 * The reader's only blob I/O. Mocked so a test can keep a `cid:` download PENDING:
 * `useInlineImages` awaits this fetcher before it flips `ready`, and `ready` is what gates the
 * sanitize pass, so a promise parked here IS the window S13 lives in. The default resolves to
 * `null`, which is what this suite already got from the real hook (the session's `getClient()`
 * returns null). One stable fetcher identity per test, because the hook's effect depends on it.
 */
vi.mock('./use-blob', () => ({ useBlobFetcher: vi.fn() }))

/** Park the inline-image download; the returned function completes it. */
function pendingBlob(): () => void {
  let release: () => void = () => {}
  const pending = new Promise<Blob | null>((resolve) => {
    release = () => resolve(null)
  })
  vi.mocked(useBlobFetcher).mockReturnValue(async () => await pending)
  return release
}

/** An HTML body with one inline `cid:` image, one remote tracker, and one real attachment. */
function htmlCidRow(id: string): EmailBodyRow & { authResults: string[] } {
  const html = '<p>Hi</p><img src="cid:c1" alt=""><img src="https://tracker.test/p.gif" alt="">'
  return {
    accountId: 'a',
    id,
    bodyValues: { h1: val(html) },
    bodyStructure: part({ partId: 'h1', type: 'text/html' }),
    textBody: [],
    htmlBody: [part({ partId: 'h1', type: 'text/html' })],
    attachments: [
      part({ blobId: 'inline1', cid: 'c1', type: 'image/png', disposition: 'inline' }),
      part({ blobId: 'b9', name: 'doc.pdf', type: 'application/pdf', size: 10 }),
    ],
    hasAttachment: true,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
  }
}

function htmlRemoteRow(id: string): EmailBodyRow & { authResults: string[] } {
  const html = '<p>Hi</p><img src="https://track.test/pixel.png" alt="x">'
  return {
    accountId: 'a',
    id,
    bodyValues: { h1: val(html) },
    bodyStructure: part({ partId: 'h1', type: 'text/html' }),
    textBody: [],
    htmlBody: [part({ partId: 'h1', type: 'text/html' })],
    attachments: [],
    hasAttachment: false,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
  }
}

const session = {
  getClient: () => null,
  connected: {
    jmapSession: {
      accounts: { a: { name: 'me@x.test', isPersonal: true } },
      username: 'me@x.test',
    },
  },
} as unknown as SessionContextValue
const dispatch = vi.fn()
let db: ReplicaDb
/** Every external link opens through `window.open`; the FR-RD-08 tests assert on exactly this. */
let openSpy: MockInstance<typeof window.open>

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  vi.mocked(useBlobFetcher).mockReturnValue(async () => null)
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
  setActiveEngine({
    dispatch,
    fetchBody: vi.fn(async () => {}),
    // The label picker hydrates the ids it was given before computing membership.
    fetchEnvelopes: vi.fn(async () => {}),
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
    mailbox('junk', { role: 'junk' }),
    mailbox('trash', { role: 'trash' }),
  ])
})

afterEach(async () => {
  vi.useRealTimers()
  setActiveEngine(null)
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
  await db.delete()
})

function seen(over: Parameters<typeof email>[1] = {}): EmailRow {
  return toEmailRow('a', email('e1', { keywords: { $seen: true }, ...over }))
}

/**
 * The tree under test, as a value — so a test can `rerender` it with a DIFFERENT `email` row. That
 * is exactly how the replica reaches this component in the app: an optimistic keyword apply lands,
 * the liveQuery fires, and the parent re-renders `MessageView` with a new row for the same message.
 *
 * Wrapped in `<StrictMode>` because `main.tsx` is: the dwell timer is an effect with a cleanup, and
 * StrictMode's dev double-invoke (mount → cleanup → mount) is precisely what breaks the obvious
 * "arm once per message id" ref-latch implementation of it — the latch refuses the second mount and
 * the message is never marked read at all. Without this wrapper that bug ships green.
 */
function tree(row: EmailRow, mailboxId: string | undefined = 'inbox') {
  return (
    <StrictMode>
      <RouterProvider>
        <ConfigProvider config={DEFAULT_CONFIG}>
          <SessionContext.Provider value={session}>
            <ToastProvider>
              <ReplicaProvider accountId="a" db={db}>
                <MessageView email={row} mailboxId={mailboxId} />
              </ReplicaProvider>
            </ToastProvider>
          </SessionContext.Provider>
        </ConfigProvider>
      </RouterProvider>
    </StrictMode>
  )
}

function renderView(row: EmailRow, mailboxId: string | undefined = 'inbox') {
  return render(tree(row, mailboxId))
}

/** An unread row for `e1` — the shape the auto-mark dwell exists for. */
function unseen(over: Parameters<typeof email>[1] = {}): EmailRow {
  return toEmailRow('a', email('e1', { keywords: {}, ...over }))
}

/**
 * Every `$seen` intent dispatched so far, in order: `true` = "mark read", `false` = "mark unread".
 * Asserting on the SEQUENCE is the point — the auto-mark bug is a second `true` that nobody asked
 * for, and a `not.toHaveBeenCalled()` style assertion cannot see it.
 */
function seenIntents(): boolean[] {
  return dispatch.mock.calls
    .map((call) => call[0] as { kind: string; keyword?: string; value?: boolean })
    .filter((intent) => intent.kind === 'setKeywords' && intent.keyword === '$seen')
    .map((intent) => intent.value === true)
}

describe('MessageView', () => {
  it('renders the sender and subject in the header', async () => {
    await putEmailBody(db, textBodyRow('e1', 'hello world'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }], subject: 'Hello' }))
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Hello' })).toBeInTheDocument()
  })

  it('opens the sender hover-card from the header avatar (FR-CON-05)', async () => {
    await putEmailBody(db, textBodyRow('e1', 'hello'))
    const user = userEvent.setup()
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }], subject: 'Hello' }))
    const trigger = await screen.findByRole('button', { name: 'Show contact card for Alice' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('alice@x.test')).toBeInTheDocument()
  })

  it('reply seeds a draft addressed to the sender with a Re: subject and threading', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        subject: 'Hi',
        messageId: ['<m1@x>'],
      }),
    )
    const reply = await screen.findByRole('button', { name: 'Reply' })
    await waitFor(() => expect(reply).toBeEnabled())
    await user.click(reply)
    const drafts = [...useComposerStore.getState().drafts.values()]
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.to).toEqual([{ name: 'Alice', email: 'alice@x.test' }])
    expect(drafts[0]?.subject).toBe('Re: Hi')
    expect(drafts[0]?.inReplyTo).toEqual(['<m1@x>'])
  })

  it('reply-all drops the signed-in user and keeps other recipients', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        to: [
          { name: 'Me', email: 'me@x.test' },
          { name: 'Bob', email: 'bob@x.test' },
        ],
        subject: 'Hi',
      }),
    )
    const replyAll = await screen.findByRole('button', { name: 'Reply all' })
    await waitFor(() => expect(replyAll).toBeEnabled())
    await user.click(replyAll)
    const draft = [...useComposerStore.getState().drafts.values()][0]
    const cc = (draft?.cc ?? []).map((address) => address.email)
    expect(cc).toContain('bob@x.test')
    expect(cc).not.toContain('me@x.test')
  })

  it('forward yields an empty To, a Fwd: subject, and carries attachments', async () => {
    await putEmailBody(db, {
      ...textBodyRow('e1', 'body'),
      attachments: [part({ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10 })],
    })
    const user = userEvent.setup()
    renderView(seen({ subject: 'Hi' }))
    const forward = await screen.findByRole('button', { name: 'Forward' })
    await waitFor(() => expect(forward).toBeEnabled())
    await user.click(forward)
    const draft = [...useComposerStore.getState().drafts.values()][0]
    expect(draft?.to).toEqual([])
    expect(draft?.subject).toBe('Fwd: Hi')
    expect(draft?.attachments).toHaveLength(1)
    expect(draft?.inReplyTo).toBeNull()
  })

  /**
   * The window between "body fetched" and "inline images fetched". `sanitized` is null throughout
   * it, so a draft seeded here used to be seeded with the RAW mail — which `use-draft-autosave` then
   * persists and uploads, and which a fast send puts on the wire. The attachment strip is the probe
   * for `loading === false`: it renders off `body`, so its presence means the body fetch is done and
   * only the `cid:` download is outstanding.
   */
  it('refuses reply/reply-all/forward while a cid: image is still downloading', async () => {
    const release = pendingBlob()
    await putEmailBody(db, htmlCidRow('e1'))
    renderView(seen())

    // BOTH conditions in one `waitFor`, and that is the whole assertion: the attachment strip
    // renders off `body`, so its presence means `loading === false`. A gate on `loading` alone can
    // therefore never satisfy this — once the strip is there, such a button is enabled for good.
    await waitFor(() => {
      expect(screen.getByText('doc.pdf')).toBeInTheDocument()
      for (const name of ['Reply', 'Reply all', 'Forward']) {
        expect(screen.getByRole('button', { name })).toBeDisabled()
      }
      // Inside the same `waitFor`, deliberately: the store is written by an effect, so reading it
      // after the DOM has settled assumes a commit order that holds on a fast machine and not on a
      // loaded one. The button and the chord must agree — polling for that is the assertion.
      expect(useReadingStore.getState().handlers?.bodyReady).toBe(false)
    })

    await act(async () => {
      release()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reply' })).toBeEnabled())
  })

  it('never claims the body is quotable for even one commit before the images resolve', async () => {
    // The assertion above polls, so it can only see states that PERSIST. This one records every
    // value the store passes through, which is what catches a single-commit lie — and there was
    // one: `useInlineImages` set `ready` to true while the body was still loading ("no body" read
    // as "no images"), so on the commit where the body landed, `loading` went false against a stale
    // `ready` and `bodyReady` was true for exactly one render. Reply in that window and the draft
    // is seeded from an unsanitized body, which is the whole point of the gate.
    //
    // CI found it as a flake in the test above and it took a full-suite run under load to even see
    // once. A subscription is the honest instrument here: a poll cannot observe a state that lasts
    // one commit.
    const seenValues: (boolean | undefined)[] = []
    const unsubscribe = useReadingStore.subscribe((state) =>
      seenValues.push(state.handlers?.bodyReady),
    )
    const release = pendingBlob()
    await putEmailBody(db, htmlCidRow('e1'))
    renderView(seen())

    await waitFor(() => expect(screen.getByText('doc.pdf')).toBeInTheDocument())
    await act(async () => {})

    expect(seenValues).not.toContain(true)

    await act(async () => {
      release()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reply' })).toBeEnabled())
    // …and the counter-test, so "never true" is a gate and not a permanently closed door.
    expect(seenValues).toContain(true)
    unsubscribe()
  })

  /**
   * The value behind that gate. The keyboard layer reaches `compose` through the store rather than
   * through the button, so this calls it the way a chord would — bypassing `disabled`, which is a UI
   * affordance and not a boundary — and pins that the seed in this window is EMPTY rather than the
   * unsanitized mail. Quoting nothing is a cosmetic loss; quoting `<img src=https://tracker…>` is a
   * beacon in the mail the victim sends back.
   */
  it('seeds no quoted body at all if compose is reached before the images resolve', async () => {
    const release = pendingBlob()
    await putEmailBody(db, htmlCidRow('e1'))
    renderView(seen({ subject: 'Hi' }))
    // Same two-condition wait as above: body in, images not. Then FLUSH — `waitFor` can observe the
    // DOM one commit before the effect that re-registers the handlers, and the store would still be
    // handing out the previous render's `compose`, whose `sanitized` is a different value entirely.
    await waitFor(() => {
      expect(screen.getByText('doc.pdf')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled()
    })
    await act(async () => {})
    const handlers = useReadingStore.getState().handlers
    expect(handlers?.bodyReady).toBe(false)

    act(() => handlers?.compose('reply'))
    const body = [...useComposerStore.getState().drafts.values()][0]?.body ?? ''
    expect(body).not.toContain('tracker.test')
    expect(body).not.toContain('<img')

    await act(async () => {
      release()
    })
  })

  it('archives by dispatching a move to the archive mailbox', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen(), 'inbox')
    // Archive is disabled until the archive-mailbox liveQuery resolves, and `clickAction` waits
    // for that — clicking a disabled control is a silent no-op, which would flake the dispatch
    // assertion below rather than fail it.
    await clickAction(user, 'Archive')
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' }),
      expect.anything(),
    )
  })

  it('the Archive button is disabled while reading a message already IN Archive', async () => {
    // `useTriage` refuses `to === from`, so this button was enabled over a dispatch that could never
    // happen: click, no move, no toast, no undo — "archived nothing, said nothing" (6da2350) on the
    // mouse path. Trash always had the equivalent (it swaps to Delete inside Trash); Archive did not.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen(), 'archive')
    // Junk IS a real move from Archive, and it enables as soon as its liveQuery lands — waiting for
    // it is what proves the assertion below is the self-move gate rather than an unresolved query.
    const user = userEvent.setup()
    const menu = await openOverflow(user)
    // Junk IS a real move from Archive, so it settles enabled once its liveQuery lands. Waiting on
    // it inside the OPEN menu is what proves the assertion below is the self-move gate rather than
    // an unresolved query — and the menu stays open across the re-render, so one open is enough.
    await waitFor(() => expect(isOffered(menu, 'Mark as junk')).toBe(true))
    expect(isOffered(menu, 'Archive')).toBe(false)
  })

  it('marks unread by dispatching a $seen=false keyword change', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickAction(user, 'Mark as unread')
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setKeywords',
        keyword: '$seen',
        value: false,
        emailIds: ['e1'],
      }),
      expect.anything(),
    )
  })

  it('confirms before permanently deleting a message in Trash', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen(), 'trash')
    // A single click on Delete opens a confirmation — it must NOT destroy immediately.
    // (findBy: the Trash button only becomes "Delete" once the trash mailbox liveQuery resolves.)
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(dispatch).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Delete' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'destroyEmails', emailIds: ['e1'] }),
      expect.anything(),
    )
  })

  it('shows the remote-content banner and hides it after Load images', async () => {
    await putEmailBody(db, htmlRemoteRow('e1'))
    const user = userEvent.setup()
    renderView(seen({ subject: 'Newsletter' }))
    expect(await screen.findByText('Remote content blocked')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load images' }))
    await waitFor(() =>
      expect(screen.queryByText('Remote content blocked')).not.toBeInTheDocument(),
    )
  })

  it('loads remote images with NO banner when the user has turned them on (M3.7)', async () => {
    // The user's setting overrides the deployment default — which is what makes the config a default
    // rather than a lock.
    await setPref(db, 'a', 'reading.remoteContent', 'allow')
    await putEmailBody(db, htmlRemoteRow('e1'))
    renderView(seen({ subject: 'Newsletter' }))
    // The pref arrives through liveQuery, so the first paint may still show the banner — what matters
    // is that it goes away without the user clicking anything.
    await waitFor(() =>
      expect(screen.queryByText('Remote content blocked')).not.toBeInTheDocument(),
    )
  })

  it('does NOT auto-mark read when the user has turned that off (M3.7)', async () => {
    // The pref has gated this dwell timer since M1.8 — M3.7 is the first release in which anyone
    // could actually set it.
    await setPref(db, 'a', 'reading.autoMarkRead', false)
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    renderView(toEmailRow('a', email('e1', { keywords: {} })))
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 2)
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'setKeywords', keyword: '$seen' }),
      expect.anything(),
    )
  })

  it('does NOT arm the dwell when the mailbox denies maySetSeen (B34)', async () => {
    // The one write the user never asked for, in a mailbox they may not mark read: correct behaviour
    // is silence — no dispatch, no toast, the message simply stays unread. Guards dropping the rights
    // term from the arming guard, and dropping `rights` from its deps: the verdict is optimistic
    // until the mailboxes load, so without the dep the guard only ever sees "allowed".
    //
    // REAL timers on purpose. Faking them stalls fake-indexeddb, so the mailbox liveQuery never
    // resolves, the verdict stays optimistic and the test would pass against a broken guard.
    await putMailboxes(db, 'a', [
      mailbox('inbox', { role: 'inbox', myRights: { ...FULL_RIGHTS, maySetSeen: false } }),
    ])
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(unseen())
    // Wait for the mailbox liveQuery through a control that is always ON the bar: Archive moved
    // into the overflow menu, and `findByRole('button')` for it now waits forever.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeEnabled())

    await new Promise((resolve) => setTimeout(resolve, AUTO_MARK_READ_DELAY_MS + 400))
    expect(seenIntents()).toEqual([])
  })

  it('auto-marks the message read after the dwell delay', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    // Enable fake timers only AFTER async DB seeding — fake-indexeddb stalls on faked timers.
    vi.useFakeTimers()
    renderView(toEmailRow('a', email('e1', { keywords: {} }))) // unread
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setKeywords',
        keyword: '$seen',
        value: true,
        emailIds: ['e1'],
      }),
      expect.anything(),
    )
  })

  it('does NOT re-mark a message the reader marked unread after the dwell already fired', async () => {
    // The bug: `$seen` was a dependency of the dwell effect, so the reader's own "mark as unread"
    // re-armed the very timer that had just marked it read — the control silently undid itself
    // 1.5 s later. The dwell belongs to the OPENING, not to every `$seen` transition.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    const { rerender } = renderView(unseen())
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS)
    expect(seenIntents()).toEqual([true])

    // The optimistic apply lands ($seen true), then the message is marked unread — from this pane's
    // action bar, from the message list's pointer controls, or by another client. All three reach
    // this component the same way, as a new row; that is all this test needs them to have in common.
    // (No keyboard chord is in that list: none can mark the open message unread — see the scope
    // proof on the arming effect in `MessageView.tsx`.)
    rerender(tree(seen()))
    rerender(tree(unseen()))
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 4)

    // Still exactly one auto-mark. A second `true` here is the message re-marking itself read.
    expect(seenIntents()).toEqual([true])
  })

  it('cancels an armed dwell when the reader marks unread INSIDE the window', async () => {
    // The other half of the same defect — and the half a fast reader actually meets: open, glance,
    // "mark as unread", move on, all inside 1.5 s. Keeping `$seen` out of the effect's deps closes
    // the case where the reader acts AFTER the dwell has fired, but it does nothing about a timer
    // that is still ARMED: it goes off at 1.5 s and marks read the message the reader has just said
    // to keep unread. Same user-visible symptom as the original bug ("mark as unread undoes
    // itself"), a narrower window, and no less wrong inside it.
    //
    // The click goes through the real action-bar button rather than the published handler, so what
    // is proven is the path a reader actually takes. This is also the ONE test that isolates
    // `markUnread`'s own cancel: `$seen` is false before the click and false after it, so no row
    // transition occurs and the transition effect cannot be what saves it. The outside-pane control
    // path is covered by the test below; what neither covers is an outside mark-unread against an
    // already-unread message, which moves no row — see the note on `dwellTimer`. No keyboard sibling
    // exists to drift from: reading scope has no mark-unread chord at all today (`u` is `nav.back`).
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    renderView(unseen())
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS - 500)
    fireAction('Mark as unread')
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 4)
    // The reader's intent, and nothing after it. A `true` here is the dwell overruling them.
    expect(seenIntents()).toEqual([false])
  })

  it('never arms for a message that was already read when it was opened', async () => {
    // Same defect from the other side: opening an already-read message must not leave a dwell
    // "primed" that fires the moment anything flips `$seen` back to false. The flip happens INSIDE
    // the dwell window on purpose — that is the one moment at which a timer wrongly armed at open
    // would still be pending AND would find `$seen` false when it fires.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    const { rerender } = renderView(seen())
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS / 3)
    rerender(tree(unseen()))
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 4)
    expect(seenIntents()).toEqual([])
  })

  it('drops a pending dwell when the message is read by other means first', async () => {
    // Another client (or the list) marks it read mid-dwell. Firing anyway would push a redundant
    // keyword intent into the outbox for a message that is already read.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    const { rerender } = renderView(unseen())
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS - 500)
    rerender(tree(seen()))
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 2)
    expect(seenIntents()).toEqual([])
  })

  it('cancels an armed dwell on a read-then-unread issued from OUTSIDE this pane', async () => {
    // This used to be pinned as a KNOWN RESIDUAL asserting `[true]` — the argument being that a
    // mark-unread from outside can only be seen here as an action, and no action arrives. That was
    // wrong: a dwell is armed while `$seen` is false at the ARMING instant and survives `$seen`
    // going true (that is what the one-shot `seenNow`/timer pair is for), so the outside unread
    // does show up here — as a `$seen` true → false transition on a live timer. The transition
    // effect in `MessageView.tsx` cancels on exactly that, and this test now asserts the fix.
    //
    // The two controls it stands for are `MessageList.tsx`'s bulk read/unread toggle (`BulkBar`'s
    // read button) and `commitSwipe`'s `read` branch, whose own comment says it "leaves the reading
    // pane be" — cited by symbol, because line numbers in a neighbouring file drift. Both call the
    // triage seam directly, so neither passes through `markUnread`.
    //
    // The transitions are driven at the replica boundary (a new `email` row), which is exactly how
    // a `triage.setSeen` from either control reaches this component — `MessageList` is not mounted
    // here, so what is proven is this component's response to that row sequence, not the list's
    // dispatch of it. NOT proven, and still open: an outside mark-unread against a message that is
    // ALREADY unread. It moves no row, so there is nothing for this effect to see; see the
    // "what this pair does not cover" note on `dwellTimer`.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    const { rerender } = renderView(unseen())
    await vi.advanceTimersByTimeAsync(500)
    rerender(tree(seen())) // read by other means — the dwell is still armed, `seenNow` moves to true
    await vi.advanceTimersByTimeAsync(200)
    rerender(tree(unseen())) // the mark-unread that never reaches `markUnread`
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 4)
    // Nothing at all: no auto-mark after the reader's unread, and no unread of our own to dispatch
    // (the unread came from elsewhere). A `true` here is the dwell overruling the reader.
    expect(seenIntents()).toEqual([])

    // The SAME timeline with the unread issued from this pane's own button. Be exact about what
    // this half is worth: it does NOT isolate `markUnread`'s cancel, because the optimistic apply
    // below also produces a true → false row and the transition effect would cancel on its own.
    // What pins `markUnread`'s cancel specifically is the "INSIDE the window" test above, where the
    // row never changes at all and the transition effect therefore never runs. This half is kept
    // as the realistic mouse timeline, and as the pair to the outside-pane one.
    //
    // The `unseen()` rerender after the click is not decoration, and leaving it out made this half
    // pass for the wrong reason: `triage.setSeen` applies optimistically and the row comes back
    // unread, which is what puts `seenNow` back to false by the time the timer would fire. Without
    // it the stale `seenNow === true` from the read step suppresses the dispatch on its own, and
    // this half stays green even with both cancels deleted — proving nothing about either.
    cleanup()
    dispatch.mockReset()
    const inPane = render(tree(unseen()))
    await vi.advanceTimersByTimeAsync(500)
    inPane.rerender(tree(seen()))
    await vi.advanceTimersByTimeAsync(200)
    fireAction('Mark as unread')
    inPane.rerender(tree(unseen())) // the optimistic apply lands
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 4)
    expect(seenIntents()).toEqual([false])
  })

  it('arms for an unread message opened right after a READ one (navigation)', async () => {
    // The wave-4 transition-cancel effect regressed the commonest reading sequence there is: open a
    // read message, then open an unread one. Both effects re-run in that ONE commit — the arming
    // effect because `email.id` changed (it correctly arms for the new message), the transition
    // effect because `$seen` went true → false across the boundary — and the cancel, running last,
    // killed the arm it had no business seeing. `$seen` fell from true to false because the MESSAGE
    // changed, not because anyone marked anything unread, so the new message was never auto-marked
    // read at all. FR-RD-07 stopped working for every reader who opens a read message first.
    //
    // The transition effect therefore has to know WHICH message its previous `$seen` belonged to; a
    // bare boolean cannot tell a mark-unread from a navigation. Both message rows are seeded so the
    // sequence is the one the app produces: the list hands `MessageView` a new `email` prop.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    await putEmailBody(db, textBodyRow('e2', 'body'))
    vi.useFakeTimers()
    const { rerender } = renderView(seen())
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS / 3)
    rerender(tree(toEmailRow('a', email('e2', { keywords: {} }))))
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 2)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setKeywords',
        keyword: '$seen',
        value: true,
        emailIds: ['e2'],
      }),
      expect.anything(),
    )
    // …and exactly once: the arm belongs to the opening of `e2` and nothing re-arms behind it.
    expect(seenIntents()).toEqual([true])
  })

  // ---- the `l` chord's label picker (M3.2 / M3.8) ----

  /** Invoke the `l` chord exactly as `shortcuts/registry.ts` does: through the published handlers. */
  function pressLabelChord(): void {
    act(() => {
      useReadingStore.getState().handlers?.openLabels()
    })
  }

  it('the `l` chord opens the picker against whatever control currently owns Label', async () => {
    // Label sits in the `⋯` menu now (it is past PRIMARY_ACTIONS), so the control a mouse user
    // would reach for is the overflow trigger. The chord has to anchor to the same thing —
    // `labelAnchorRef` falls back to it precisely so this stays one picker with one state.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    const anchor = await screen.findByRole('button', { name: 'More actions' })
    pressLabelChord()
    expect(await screen.findByRole('menu', { name: 'Apply labels' })).toBeInTheDocument()
    expect(anchor).toBeInstanceOf(HTMLButtonElement)
  })

  it('returns focus to the picker\u2019s anchor when Escape closes it', async () => {
    // The picker used to be anchored to the `role="toolbar"` div, which has no tabIndex — so
    // `anchorRef.current?.focus()` was a no-op and the keyboard user landed on <body>.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    const anchor = await screen.findByRole('button', { name: 'More actions' })
    pressLabelChord()
    await screen.findByRole('menu', { name: 'Apply labels' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(anchor).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('returns focus to the picker\u2019s anchor when Tab dismisses it', async () => {
    // fireEvent, not user-event: user-event would ALSO move focus itself for a Tab key, which would
    // mask whether the picker's own close path restored it.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    const anchor = await screen.findByRole('button', { name: 'More actions' })
    pressLabelChord()
    const menu = await screen.findByRole('menu', { name: 'Apply labels' })
    fireEvent.keyDown(menu, { key: 'Tab' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(anchor).toHaveFocus()
  })

  // ---- header details (M3.9, FR-RD-06) ----

  async function openDetails(
    row: EmailRow,
    body?: EmailBodyRow & { authResults: string[] },
  ): Promise<HTMLElement> {
    await putEmailBody(db, body ?? textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(row)
    await user.click(await screen.findByRole('button', { name: 'Details' }))
    return screen.getByRole('article')
  }

  it('shows Bcc, the Message-ID and a differing Reply-To in the details', async () => {
    const details = await openDetails(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        replyTo: [{ name: null, email: 'list@x.test' }],
        messageId: ['<m-42@x.test>'],
      }),
      { ...textBodyRow('e1', 'body'), bcc: [{ name: null, email: 'secret@x.test' }] },
    )
    expect(within(details).getByText('Reply-To')).toBeInTheDocument()
    expect(within(details).getByText('list@x.test')).toBeInTheDocument()
    expect(within(details).getByText('Bcc')).toBeInTheDocument()
    expect(within(details).getByText('secret@x.test')).toBeInTheDocument()
    expect(within(details).getByText('Message-ID')).toBeInTheDocument()
    expect(within(details).getByText('<m-42@x.test>')).toBeInTheDocument()
  })

  it('hides a Reply-To that merely repeats From — noise, not information', async () => {
    const details = await openDetails(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        // Same mailbox, different display name and casing: still the same address.
        replyTo: [{ name: 'Alice Smith', email: 'ALICE@x.test' }],
      }),
    )
    expect(within(details).queryByText('Reply-To')).not.toBeInTheDocument()
  })

  it('names the Sender as acting on behalf of From', async () => {
    const details = await openDetails(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }), {
      ...textBodyRow('e1', 'body'),
      sender: [{ name: 'Mailer', email: 'bounce@list.test' }],
    })
    expect(within(details).getByText(/on behalf of/)).toBeInTheDocument()
    expect(within(details).getByText(/bounce@list\.test/)).toBeInTheDocument()
  })

  it('shows Sent separately only when it diverges from the received time', async () => {
    const near = await openDetails(
      seen({ receivedAt: '2026-07-01T12:00:00Z', sentAt: '2026-07-01T11:58:00Z' }),
    )
    expect(within(near).queryByText('Sent')).not.toBeInTheDocument()
    cleanup()
    await db.emailBodies.clear()

    const far = await openDetails(
      seen({ receivedAt: '2026-07-01T12:00:00Z', sentAt: '2026-06-28T09:00:00Z' }),
    )
    expect(within(far).getByText('Sent')).toBeInTheDocument()
  })

  it('renders NO authentication block when the message carries no such header', async () => {
    const details = await openDetails(seen(), { ...textBodyRow('e1', 'body'), authResults: [] })
    expect(within(details).queryByText('Authentication')).not.toBeInTheDocument()
  })

  it('quotes the TOPMOST report and names who reported it — with no verdict', async () => {
    // The whole point of `:asText:all` + [0]: the forged report a phishing message carries is the
    // LAST one; our MTA's is the first. This asserts the fail, the authserv-id, and the absence of
    // any verdict styling.
    const details = await openDetails(seen(), {
      ...textBodyRow('e1', 'body'),
      authResults: [
        'mx.stalwart.test; dkim=fail header.d=paypal.test; dmarc=fail header.from=paypal.test',
        'mx.paypal.test; dkim=pass header.d=paypal.test; dmarc=pass header.from=paypal.test',
      ],
    })
    expect(within(details).getByText('Authentication')).toBeInTheDocument()
    expect(within(details).getByText(/Reported by mx\.stalwart\.test/)).toBeInTheDocument()
    expect(within(details).getByText(/dkim=fail · dmarc=fail/)).toBeInTheDocument()
    expect(within(details).queryByText(/dmarc=pass/)).not.toBeInTheDocument()
    expect(within(details).getByText(/cannot be verified/)).toBeInTheDocument()
  })

  it('renders no authentication block for a body row written before M3.9', async () => {
    // `authResults: undefined` is exactly "this row predates M3.9" — the engine re-fetches it, and
    // until it lands the details must simply omit the block rather than invent one.
    const details = await openDetails(seen(), textBodyRow('e1', 'body'))
    expect(within(details).queryByText('Authentication')).not.toBeInTheDocument()
  })

  // ---- overflow menu (M3.9) ----

  it('offers View source / Save as .eml from the overflow menu', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'View source' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Save as .eml' })).toBeInTheDocument()
  })

  it('does not mount the source dialog until View source is chosen', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await screen.findByText('Alice')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'View source' }))
    expect(await screen.findByRole('dialog', { name: 'Message source' })).toBeInTheDocument()
  })

  // ---- phishing friction (M3.9, FR-RD-08) ----

  /**
   * Click a link inside the real body frame — no mock anywhere in the path: MessageView renders
   * MailBodyFrame, which mounts the real `mountMailFrame`, whose real listener resolves the target
   * and calls back into `useLinkOpener`.
   *
   * Two things a browser does that jsdom does not, done by hand: fire `load` for an assigned
   * `srcdoc`, and parse it into the child document. Everything downstream is production code, and
   * the click is dispatched from the FRAME's realm — the only way this reaches the app at all
   * (see the cross-realm note in `@waxwing/mail-html`'s `frame.ts`).
   */
  async function clickBodyLink(href: string, text: string): Promise<void> {
    const frame = (await screen.findByTitle(/^Message:/)) as HTMLIFrameElement
    // The iframe being IN the DOM does not mean it has been mounted: `mountMailFrame` runs in a
    // passive effect, and findByTitle's MutationObserver can resolve before React flushes it. An
    // assigned srcdoc is the observable proof that it ran — and therefore that the click listener
    // this whole helper depends on exists. (Without this wait the tests pass or fail on tick
    // alignment; they were doing exactly that.)
    await waitFor(() => expect(frame.srcdoc).not.toBe(''))
    await act(async () => {
      frame.dispatchEvent(new Event('load'))
    })
    const doc = frame.contentDocument
    if (doc === null) throw new Error('no contentDocument')
    doc.body.innerHTML = `<a href="${href}">${text}</a>`
    const link = doc.querySelector('a')
    const view = doc.defaultView
    if (link === null || view === null) throw new Error('no link')
    await act(async () => {
      link.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('opens a benign link straight away, with no dialog and no opener handle', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://bank.test/login', 'bank.test')
    expect(openSpy).toHaveBeenCalledWith('https://bank.test/login', '_blank', 'noopener,noreferrer')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('raises the interstitial for a link whose text names a different host', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog', { name: 'This link may not be genuine' })
    // Both hosts named, and nothing opened while the reader decides.
    expect(within(dialog).getByText('bank.test')).toBeInTheDocument()
    expect(within(dialog).getByText('paypa1-secure.ru')).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('raises the interstitial for a protocol-relative href, through the real frame (D1)', async () => {
    // End-to-end proof of the base fix: nothing mocked between the click and the verdict. The href
    // never parses on its own, and `window.open` would resolve it against the app document and land
    // on evil.tld — the same destination `https://evil.tld/steal` has always warned about.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('//evil.tld/steal', 'bank.test')
    const dialog = await screen.findByRole('dialog', { name: 'This link may not be genuine' })
    expect(within(dialog).getByText('evil.tld')).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('raises the interstitial for a host hidden behind display:none markup (D3)', async () => {
    // The sanitizer keeps `display:none` on purpose, so the reader sees exactly `bank.test` while
    // `textContent` is `!bank.test`. Driven through the real frame, which is what reads textContent.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://evil.tld/', '<span style="display:none">!</span>bank.test')
    const dialog = await screen.findByRole('dialog', { name: 'This link may not be genuine' })
    expect(within(dialog).getByText('bank.test')).toBeInTheDocument()
    expect(within(dialog).getByText('evil.tld')).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('Cancel does NOT open the link', async () => {
    // The single most important assertion in this file: the friction has to actually stop it.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(openSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('focuses Cancel when the interstitial opens, and Escape backs out without opening', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    await user.keyboard('{Escape}')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('Open anyway opens the link the reader was warned about, and only that link', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Open anyway' }))
    expect(openSpy).toHaveBeenCalledExactlyOnceWith(
      'https://paypa1-secure.ru/login',
      '_blank',
      'noopener,noreferrer',
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('offers no way to stop being asked — the friction cannot be trained away', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }))
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/don't ask|do not ask|always|trust/i)).not.toBeInTheDocument()
  })

  it('opens a mailto: link normally — there is no host to compare', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('mailto:support@bank.test', 'bank.test')
    expect(openSpy).toHaveBeenCalledWith(
      'mailto:support@bank.test',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no a11y violations on the interstitial', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    await screen.findByRole('dialog')
    // Dialog portals to document.body, outside the RTL container — scan the default root.
    await expectNoA11yViolations(undefined, { iframes: false })
  })

  // ---- the sender's real address (M3.9, FR-RD-08) ----

  it('shows the real address next to the display name, always — no hover involved', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }))
    const header = (await screen.findByText('Alice')).closest('header')
    expect(header).not.toBeNull()
    // Present in the DOM without a pointer ever touching it, and not the details disclosure —
    // that is still collapsed.
    expect(within(header as HTMLElement).getByText('alice@x.test')).toBeInTheDocument()
    expect(screen.queryByText('Message-ID')).not.toBeInTheDocument()
  })

  it('does not repeat the address when it IS the display name', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: null, email: 'alice@x.test' }] }))
    const header = (await screen.findByText('alice@x.test')).closest('header')
    expect(within(header as HTMLElement).getAllByText('alice@x.test')).toHaveLength(1)
  })

  it('marks a display name that impersonates a different address', async () => {
    // From: "security@bank.test" <attacker@evil.tld> — the trick no hover affordance catches on a
    // touch screen, which is why the marker is always on.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'security@bank.test', email: 'attacker@evil.tld' }] }))
    expect(
      await screen.findByText("The name shown is not the sender's real address"),
    ).toBeInTheDocument()
    expect(screen.getByText('attacker@evil.tld')).toBeInTheDocument()
  })

  it('does NOT mark an ordinary sender', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }))
    await screen.findByText('Alice')
    expect(
      screen.queryByText("The name shown is not the sender's real address"),
    ).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    await putEmailBody(db, textBodyRow('e1', 'accessible body'))
    const { container } = renderView(seen({ subject: 'A11y' }))
    await screen.findByText('Alice')
    // Wait for the body frame so the full reading chrome is scanned, not the loading spinner.
    await screen.findByTitle(/^Message:/)
    // Do not descend into the sandboxed body iframe: axe cannot postMessage into a sandboxed
    // srcdoc frame under jsdom (it throws "Respondable target must be a frame"), and the frame's
    // internal a11y is the @waxwing/mail-html package's concern. This scans the MessageView
    // chrome — header, action bar, banner, attachments.
    await expectNoA11yViolations(container, { iframes: false })
  })

  /*
   * B49 — the bar keeps what fits and the ⋯ menu gains the rest.
   *
   * jsdom has no layout, so `useActionOverflow` normally answers "show everything" and every other
   * test in this file sees the full row. Here width is supplied through prototype getters. The
   * numbers are chosen for THIS environment: CSS Modules are stubbed to empty under jsdom, so the
   * bar's `column-gap` computes to 0 and 224px of bar at 44px a control fits five — four actions
   * and the trigger. In the browser the same arithmetic runs against a real gap; the E2E suite is
   * where the real pane is measured.
   */
  describe('the action bar overflow (B49)', () => {
    const widthGetter = (px: number) => ({ configurable: true, get: () => px })

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthGetter(224))
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthGetter(44))
      window.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    })

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
    })

    const toolbarNames = async (): Promise<string[]> => {
      const toolbar = await screen.findByRole('toolbar', { name: 'Message actions' })
      return within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
    }

    it('keeps reply, reply-all, forward and delete beside the trigger', async () => {
      await putEmailBody(db, textBodyRow('e1', 'body'))
      renderView(seen())
      expect(await toolbarNames()).toEqual([
        'Reply',
        'Reply all',
        'Forward',
        'Move to Trash',
        'More actions',
      ])
    })

    // The half that makes hiding them legitimate. A button removed from the bar and not added to the
    // menu is an action the reader can no longer reach at all, which is why this is not a CSS rule.
    it('makes every displaced action reachable in the menu', async () => {
      await putEmailBody(db, textBodyRow('e1', 'body'))
      renderView(seen())
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'More actions' }))
      const menu = await screen.findByRole('menu')
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '')
      for (const displaced of ['Archive', 'Move to…', 'Label', 'Mark as junk', 'Flag']) {
        expect(items.some((item) => item.startsWith(displaced))).toBe(true)
      }
      // And what was always in the menu is still there, below them.
      expect(items.some((item) => item.startsWith('Print'))).toBe(true)
    })
  })
})
