/**
 * Settings → Notifications (M3.6). The permission API is injected — jsdom has no `Notification` —
 * and so is the RFC 9749 capability, so the honest "not with this server" note can be asserted both
 * ways without inventing a server that does not exist.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import {
  coerceNotificationPrefs,
  NOTIFY_PREF_KEY,
  type NotificationPermissionApi,
  type NotificationPermissionState,
} from '../notify'
import { getPref, putMailboxes, type ReplicaDb, ReplicaProvider, setPref } from '../sync'
import { freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { NotificationsSection } from './NotificationsSection'

const ACC = 'a'
const INBOX = 'mb-inbox'
const ARCHIVE = 'mb-archive'

let db: ReplicaDb

function permissionApi(
  state: NotificationPermissionState,
  request?: () => Promise<NotificationPermissionState>,
): NotificationPermissionApi {
  return { state, request: request ?? (async () => state) }
}

function renderSection(props: { permission: NotificationPermissionApi; backgroundPush?: boolean }) {
  return render(
    <ConfigProvider config={DEFAULT_CONFIG}>
      <ToastProvider>
        <ReplicaProvider accountId={ACC} db={db}>
          <NotificationsSection
            permission={props.permission}
            backgroundPush={props.backgroundPush ?? false}
          />
        </ReplicaProvider>
      </ToastProvider>
    </ConfigProvider>,
  )
}

const prefs = async () => coerceNotificationPrefs(await getPref(db, ACC, NOTIFY_PREF_KEY))

const masterSwitch = () => screen.getByRole('switch', { name: /notify me about new mail/i })

beforeEach(async () => {
  db = freshDb()
  await putMailboxes(db, ACC, [
    mailbox(INBOX, { name: 'Inbox', role: 'inbox' }),
    mailbox(ARCHIVE, { name: 'Archive', role: 'archive' }),
  ])
})

describe('NotificationsSection — permission', () => {
  it('asks the browser only when the user turns the switch ON, and seeds the Inbox on a grant', async () => {
    // The prompt must follow a user gesture: an unsolicited one is auto-denied, and that denial sticks
    // to the origin forever. So it may not happen on mount — only here.
    const request = vi.fn(async (): Promise<NotificationPermissionState> => 'granted')
    const api: NotificationPermissionApi = { state: 'default', request }
    renderSection({ permission: api })

    expect(request).not.toHaveBeenCalled()

    await userEvent.click(masterSwitch())

    expect(request).toHaveBeenCalledTimes(1)
    await waitFor(async () => {
      const stored = await prefs()
      expect(stored.enabled).toBe(true)
      // Inbox only: it is the one folder whose arrivals are unfiled new mail.
      expect(stored.mailboxIds).toEqual([INBOX])
    })
  })

  it('seeds the Inbox even when the mailbox liveQuery has NOT resolved yet', async () => {
    // The regression this pins: the seed used to read the rendered `useMailboxByRole` value, which is
    // `undefined` for the first frames of a cold Settings screen. A user who flipped the switch inside
    // that window got permission granted, the switch on — and an EMPTY folder list. Nothing would ever
    // have notified them, and nothing would have said so. The seed now reads the replica directly.
    const request = vi.fn(async (): Promise<NotificationPermissionState> => 'granted')
    renderSection({ permission: { state: 'default', request } })

    // Click immediately, before any liveQuery has had a chance to settle.
    await userEvent.click(masterSwitch())

    await waitFor(async () => expect((await prefs()).mailboxIds).toEqual([INBOX]))
  })

  it('writes nothing when the user dismisses or denies the prompt', async () => {
    const api = permissionApi('default', async () => 'denied')
    renderSection({ permission: api })

    await userEvent.click(masterSwitch())

    expect((await prefs()).enabled).toBe(false)
  })

  it('a DISMISSED prompt says so — a switch that silently springs back reads as broken', async () => {
    // Dismissing the browser prompt (the X, or Escape) leaves the permission at `default`. Without a
    // word from us the switch just bounces off again and the app appears to have ignored the click.
    // The browser WILL ask again, so the message says how to get the prompt back.
    renderSection({ permission: permissionApi('default', async () => 'default') })

    await userEvent.click(masterSwitch())

    expect(await screen.findByText(/Turn the switch on again to be asked once more/i)).toBeVisible()
    expect(masterSwitch()).not.toBeChecked()
    expect((await prefs()).enabled).toBe(false)
  })

  it('a DENIED permission disables the switch and says so — there is no way back from in-app', async () => {
    // No API can re-prompt or open browser settings, so the section offers nothing clickable and tells
    // the user the truth instead of pretending a toggle would help.
    renderSection({ permission: permissionApi('denied') })

    expect(masterSwitch()).toBeDisabled()
    expect(screen.getByText(/blocking notifications for this site/i)).toBeInTheDocument()
  })

  it('a browser with no Notification API is `unsupported`, not `denied`', async () => {
    renderSection({ permission: permissionApi('unsupported') })

    expect(masterSwitch()).toBeDisabled()
    expect(screen.getByText(/does not support notifications/i)).toBeInTheDocument()
  })

  it('turning it OFF never claims to revoke the browser permission', async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, {
      enabled: true,
      mailboxIds: [INBOX],
      quietHours: null,
      preview: true,
      sound: true,
    })
    const request = vi.fn(async (): Promise<NotificationPermissionState> => 'granted')
    renderSection({ permission: { state: 'granted', request } })

    await userEvent.click(await screen.findByRole('switch', { name: /notify me about new mail/i }))

    await waitFor(async () => expect((await prefs()).enabled).toBe(false))
    expect(request).not.toHaveBeenCalled() // switching off asks the browser nothing
  })
})

describe('NotificationsSection — the preferences', () => {
  beforeEach(async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, {
      enabled: true,
      mailboxIds: [INBOX],
      quietHours: null,
      preview: true,
      sound: true,
    })
  })

  const granted = () => permissionApi('granted')

  it('per-folder checkboxes write the enabled mailboxes', async () => {
    renderSection({ permission: granted() })

    const archive = await screen.findByRole('checkbox', { name: 'Archive' })
    expect(archive).not.toBeChecked()
    expect(await screen.findByRole('checkbox', { name: 'Inbox' })).toBeChecked()

    await userEvent.click(archive)
    await waitFor(async () => expect((await prefs()).mailboxIds).toEqual([INBOX, ARCHIVE]))

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Inbox' }))
    await waitFor(async () => expect((await prefs()).mailboxIds).toEqual([ARCHIVE]))
  })

  it('quiet hours seed 22:00–07:00 and round-trip through the time fields', async () => {
    renderSection({ permission: granted() })

    await userEvent.click(await screen.findByRole('switch', { name: /quiet hours/i }))

    await waitFor(async () =>
      expect((await prefs()).quietHours).toEqual({ fromMinutes: 22 * 60, toMinutes: 7 * 60 }),
    )
    const from = await screen.findByLabelText('From')
    expect(from).toHaveValue('22:00')
    expect(await screen.findByLabelText('To')).toHaveValue('07:00')

    // A range that crosses midnight is legitimate and must survive a write. (jsdom does not implement
    // the time input's segment editing, so the change event is driven directly — what is under test is
    // the handler, not the browser's own widget.)
    fireEvent.change(from, { target: { value: '23:30' } })
    await waitFor(async () => expect((await prefs()).quietHours?.fromMinutes).toBe(23 * 60 + 30))
    expect((await prefs()).quietHours?.toMinutes).toBe(7 * 60) // still crossing midnight
  })

  it('a CLEARED time field is ignored rather than written as midnight', async () => {
    renderSection({ permission: granted() })
    await userEvent.click(await screen.findByRole('switch', { name: /quiet hours/i }))
    const from = await screen.findByLabelText('From')

    fireEvent.change(from, { target: { value: '' } })

    // 00:00 would be a silent, wrong window the user never asked for.
    await waitFor(async () => expect((await prefs()).quietHours?.fromMinutes).toBe(22 * 60))
  })

  it('the preview and sound switches write their preferences', async () => {
    renderSection({ permission: granted() })

    await userEvent.click(await screen.findByRole('switch', { name: /show sender and subject/i }))
    await waitFor(async () => expect((await prefs()).preview).toBe(false))

    await userEvent.click(await screen.findByRole('switch', { name: /play a sound/i }))
    await waitFor(async () => expect((await prefs()).sound).toBe(false))
  })

  it('hides the details until the master switch is actually on', async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, {
      enabled: false,
      mailboxIds: [],
      quietHours: null,
      preview: true,
      sound: true,
    })
    renderSection({ permission: granted() })

    expect(screen.queryByRole('checkbox', { name: 'Inbox' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /quiet hours/i })).not.toBeInTheDocument()
  })
})

describe('NotificationsSection — the honest capability note (ADR-010)', () => {
  it('says plainly that this server cannot notify while the app is closed', async () => {
    // The server does not advertise RFC 9749. Promising it and silently not delivering is exactly
    // the failure NFR-PRIV-02 exists to forbid.
    renderSection({ permission: permissionApi('default'), backgroundPush: false })

    expect(screen.getByText(/not available with this server/i)).toBeInTheDocument()
    expect(screen.getByText(/RFC 9749/)).toBeInTheDocument()
  })

  /**
   * **This assertion was inverted by M4.0, deliberately and on the record.**
   *
   * Until 2026-07-23 it demanded the note admit "Waxwing does not deliver them yet", and it was
   * right to: no subscribe flow existed. Owner decision D6a built one (ADR-017), so the honest
   * sentence changed — and the guard has to change WITH the code rather than be deleted. What it
   * now protects is the thing that can still go wrong: the good news appearing on its own.
   *
   * A closed-app banner names no sender and no subject, the folder list on this very screen does not
   * apply to it, and the subscription lapses after seven days without a visit. A user who reads only
   * "this server can also notify you while it is closed" would believe three things the code does
   * not do.
   */
  it('with a capable server, says it works AND names all three limits', async () => {
    renderSection({ permission: permissionApi('default'), backgroundPush: true })

    expect(screen.getByText(/can also notify you while/i)).toBeInTheDocument()
    // No sender, no subject.
    expect(screen.getByText(/never the sender or the subject/i)).toBeInTheDocument()
    // The folder setting above does not reach the closed-app banner (`EmailDelivery` names no mailbox).
    expect(screen.getByText(/folder setting above does not apply/i)).toBeInTheDocument()
    // Seven days, and only a running app can renew.
    expect(screen.getByText(/once a week/i)).toBeInTheDocument()
    expect(screen.queryByText(/not available with this server/i)).not.toBeInTheDocument()
  })

  /**
   * The surviving half of the old "never claims background push works" guard, re-aimed. The claim is
   * allowed now; what is forbidden is making it ALONE. Deleting a caveat is a one-line change that
   * looks like tidying, and this is the test that makes it fail.
   */
  it('never states the good news without its limits', () => {
    const view = renderSection({ permission: permissionApi('default'), backgroundPush: true })
    const text = view.container.textContent ?? ''
    expect(text).toMatch(/can also notify you while/i)
    expect(text).toMatch(/never the sender or the subject/i)
    expect(text).toMatch(/folder setting above does not apply/i)
    expect(text).toMatch(/once a week/i)
    view.unmount()
  })

  it('claims nothing at all about background push when the server cannot sign one', () => {
    const view = renderSection({ permission: permissionApi('default'), backgroundPush: false })
    expect(view.container.textContent).not.toMatch(/can also notify you while/i)
    view.unmount()
  })

  it('shows the note whatever the switch says — it is a fact about the SERVER, not a setting', async () => {
    renderSection({ permission: permissionApi('denied'), backgroundPush: false })
    expect(screen.getByText(/not available with this server/i)).toBeInTheDocument()
  })
})

describe('NotificationsSection — a11y', () => {
  it('has no violations with the details expanded', async () => {
    await setPref(db, ACC, NOTIFY_PREF_KEY, {
      enabled: true,
      mailboxIds: [INBOX],
      quietHours: { fromMinutes: 22 * 60, toMinutes: 7 * 60 },
      preview: true,
      sound: true,
    })
    const { container } = renderSection({ permission: permissionApi('granted') })

    // wait for the replica-backed controls to appear before scanning
    await screen.findByRole('checkbox', { name: 'Inbox' })
    const group = within(container).getByRole('group', { name: /notify for these folders/i })
    expect(group).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })
})
