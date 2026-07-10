/**
 * Cross-tab engine bus (M1.3). Dexie's liveQuery already propagates replica changes across tabs,
 * so this channel carries only the ENGINE STATUS the leader computes (syncing/offline/error, push
 * transport) — the one thing that is not in the replica. Followers render the leader's status.
 * The `BroadcastChannel` is injected via {@link BroadcastChannelLike} so it can be faked in tests.
 */

import type { EngineStatus } from './types'

export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export type EngineBusMessage = { readonly type: 'status'; readonly status: EngineStatus }

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
      if (message?.type === 'status') {
        for (const listener of this.listeners) listener(message)
      }
    }
  }

  postStatus(status: EngineStatus): void {
    this.channel.postMessage({ type: 'status', status } satisfies EngineBusMessage)
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
