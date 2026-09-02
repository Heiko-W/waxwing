/**
 * "Is any tab going to raise the LIVE banner for this delivery?" — the worker's question, and the
 * shapes it travels in (R-42). Pure and DOM-free, because `src/sw/sw.ts` imports it: that program
 * compiles with `lib: WebWorker` and `types: []`, so nothing here may touch `window` or React.
 *
 * ## Why a question rather than a rule
 *
 * Two channels can banner the same message. The live channel (`sync/engine`) banners when no tab is
 * in the FOREGROUND; Web Push banners when no tab is VISIBLE. An open but covered tab satisfies
 * both, the two banners carry different tags so neither replaces the other, and the reader gets the
 * arrival twice — once richly, from the leader, and once as "New message" from the worker.
 * ADR-017 decision 3 states the intent ("the two must not double-notify"); the mechanism it names,
 * "suppress when a client is visible", simply does not cover the covered tab.
 *
 * The obvious repair — "the worker stays silent whenever any client exists" — is a REGRESSION, and
 * that is why it is not what this does. A background tab on a phone shows up in `clients.matchAll`
 * long after the browser has frozen or throttled it: it cannot run a sync pass and cannot raise
 * anything, so treating its existence as a promise of a banner loses the notification entirely,
 * exactly on the platform where background delivery matters most.
 *
 * So the worker ASKS, and only an answer counts. A leader whose live channel is armed and connected
 * replies within the deadline; a frozen tab, a follower, and a tab whose engine has not caught up
 * yet all say nothing, and silence means "banner it". The precedent is the engine's own cross-tab
 * foreground probe (`isAppInForeground` / `FOREGROUND_ACK_MS`): a query with a bounded wait beats a
 * heartbeat, because there is no TTL to tune and nothing that can go stale.
 *
 * Unifying the two TAGS instead was considered and is not possible: the push carries no message id
 * (ADR-017 amendment, decision 7), so it cannot compute the live channel's `waxwing:<acc>:mail:<id>`.
 */

/** SW → page: "would you raise the live banner for a delivery right now?" */
export const LIVE_BANNER_PROBE = 'LIVE_BANNER_PROBE'

export interface LiveBannerProbeMessage {
  readonly type: typeof LIVE_BANNER_PROBE
}

/** page → SW, over the probe's own `MessagePort`. Only `true` is load-bearing. */
export interface LiveBannerProbeReply {
  readonly type: typeof LIVE_BANNER_PROBE
  readonly live: boolean
}

/**
 * How long the worker waits for an answer.
 *
 * The same 100 ms the engine allows its foreground probe, and for the same reason: it is the cost
 * paid on a delivery that is about to raise a banner anyway, it is far below the threshold at which
 * a notification feels late, and it has to be a real timer — a worker that waited for an answer
 * that is never coming would hold `event.waitUntil` open for nothing.
 */
export const LIVE_PROBE_ACK_MS = 100

export function isLiveBannerProbeMessage(value: unknown): value is LiveBannerProbeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === LIVE_BANNER_PROBE
  )
}

export function isLiveBannerProbeReply(value: unknown): value is LiveBannerProbeReply {
  if (!isLiveBannerProbeMessage(value)) return false
  return typeof (value as { live?: unknown }).live === 'boolean'
}

/** The slice of a `WindowClient` the probe uses — so a test can pass a plain object. */
export interface LiveProbeTarget {
  postMessage(message: unknown, transfer: Transferable[]): void
}

/**
 * Ask every app client and answer within {@link LIVE_PROBE_ACK_MS}.
 *
 * `true` on the FIRST tab that says yes — one live banner is enough to make a second one wrong.
 * `false` when the deadline passes, when every client has answered no, and immediately when there
 * is no client at all (the app is closed, which is the ordinary case for a background push).
 *
 * A `MessageChannel` per client rather than one shared reply route: the worker has no listener of
 * its own on the page's messages, and a port handed out with the question is the only way to know
 * that an answer belongs to THIS question and not to a stale one from a previous push.
 */
export async function anyClientRaisesLiveBanner(
  clients: readonly LiveProbeTarget[],
  timeoutMs: number = LIVE_PROBE_ACK_MS,
): Promise<boolean> {
  if (clients.length === 0) return false

  return await new Promise<boolean>((resolve) => {
    const ports: MessagePort[] = []
    let answered = 0
    let settled = false

    const finish = (live: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const port of ports) port.close()
      resolve(live)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    for (const client of clients) {
      const channel = new MessageChannel()
      ports.push(channel.port1)
      channel.port1.onmessage = (event: MessageEvent) => {
        const reply: unknown = event.data
        if (!isLiveBannerProbeReply(reply)) return
        if (reply.live) {
          finish(true)
          return
        }
        answered += 1
        // Every client has spoken and none of them will banner — no reason to hold the worker for
        // the rest of the deadline.
        if (answered === clients.length) finish(false)
      }
      const message: LiveBannerProbeMessage = { type: LIVE_BANNER_PROBE }
      try {
        client.postMessage(message, [channel.port2])
      } catch {
        // A client that went away between `matchAll` and here simply never answers.
      }
    }
  })
}
