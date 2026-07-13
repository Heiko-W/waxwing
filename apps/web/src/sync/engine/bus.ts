/**
 * Cross-tab engine bus (M1.3). Dexie's liveQuery already propagates replica changes across tabs, so
 * this channel carries only what is NOT in the replica:
 *  - `status` — the ENGINE STATUS the leader computes (syncing/offline/error, push transport, queue
 *    counts); followers render it.
 *  - `wake` — a FOLLOWER's "I queued something, replay it now" (M3.3, defect D7). Without it a
 *    follower's action — including a SEND — sat in the outbox until the leader's next push event or
 *    its 60 s safety sweep.
 *  - `foreground?` / `foreground!` — M3.6's cross-tab foreground probe. Leadership is per-ORIGIN (the
 *    first tab to win the Web Lock keeps it), but "is the user looking at us?" is per-TAB. Without
 *    this, a hidden leader banners mail the user is watching land in the focused tab next door. The
 *    leader asks; any tab that is itself visible+focused answers. It is a QUERY, not a heartbeat:
 *    a crashed tab simply does not reply, so there is no TTL to get wrong and no state to go stale.
 *
 * `BroadcastChannel` never delivers a message to the sender, so a leader's own post cannot loop back
 * (which is exactly why the leader cannot answer its own `foreground?` — it checks itself locally
 * first). The channel is injected via {@link BroadcastChannelLike} so it can be faked in tests.
 */

import type { EngineStatus } from './types'

export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export type EngineBusMessage =
  | { readonly type: 'status'; readonly status: EngineStatus }
  | { readonly type: 'wake'; readonly reason: 'outbox' }
  | { readonly type: 'foreground?' }
  | { readonly type: 'foreground!' }

const BUS_MESSAGE_TYPES: ReadonlySet<string> = new Set<EngineBusMessage['type']>([
  'status',
  'wake',
  'foreground?',
  'foreground!',
])

export const ENGINE_CHANNEL = 'waxwing-engine'

/** Real `BroadcastChannel` factory (structurally compatible with {@link BroadcastChannelLike}). */
export function defaultBroadcast(name: string = ENGINE_CHANNEL): BroadcastChannelLike {
  return new BroadcastChannel(name) as unknown as BroadcastChannelLike
}

export class EngineBus {
  private readonly listeners = new Set<(message: EngineBusMessage) => void>()

  constructor(private readonly channel: BroadcastChannelLike) {
    channel.onmessage = (event) => {
      const message = event.data as EngineBusMessage | null
      if (message === null || !BUS_MESSAGE_TYPES.has(message.type)) return
      for (const listener of this.listeners) listener(message)
    }
  }

  postStatus(status: EngineStatus): void {
    this.channel.postMessage({ type: 'status', status } satisfies EngineBusMessage)
  }

  /** Ask the leader (whichever tab that is) to replay the outbox now. */
  postWake(reason: 'outbox'): void {
    this.channel.postMessage({ type: 'wake', reason } satisfies EngineBusMessage)
  }

  /** M3.6: "is ANY tab of this app in the foreground?" — asked by the leader before it banners. */
  postForegroundQuery(): void {
    this.channel.postMessage({ type: 'foreground?' } satisfies EngineBusMessage)
  }

  /** The answer, sent by any tab that is itself visible and focused. Silence means "no". */
  postForegroundAck(): void {
    this.channel.postMessage({ type: 'foreground!' } satisfies EngineBusMessage)
  }

  onMessage(listener: (message: EngineBusMessage) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    this.listeners.clear()
    this.channel.onmessage = null
    this.channel.close()
  }
}
