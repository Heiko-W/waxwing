/**
 * A streaming Server-Sent Events wire parser (WHATWG HTML §9.2 "Parsing an event stream").
 *
 * Native `EventSource` cannot send an `Authorization` header, and Stalwart's SSE endpoint
 * accepts *only* header auth (SP.3 probe), so Waxwing reads the stream with `fetch` +
 * `ReadableStream` and parses the wire format itself. This parser therefore handles every
 * case the browser's built-in parser would, fed decoded text in arbitrary chunks:
 *
 *  - multi-line `data:` (joined with `\n`), `event:`, `id:`, `retry:` fields,
 *  - comment lines (a leading `:`),
 *  - `\n`, `\r\n` and lone `\r` line terminators, including a `\r\n` split across chunks,
 *  - a frame split across read() chunks,
 *  - a single leading UTF-8 BOM.
 */

/** A dispatched SSE event (produced on a blank line after at least one `data:` field). */
export interface SseEvent {
  /** The `event:` type, defaulting to `'message'` (HTML §9.2). */
  type: string
  /** The accumulated `data:` payload with the joining/trailing `\n` handling applied. */
  data: string
  /** The stream's last-seen event id (persists across events until changed). */
  lastEventId: string
}

/** Side-channel fields that update parser state without dispatching an {@link SseEvent}. */
export interface SseStreamState {
  /** Last `retry:` value parsed (ms), or `undefined` if the server never sent one. */
  retry: number | undefined
  /** Current last-event-id, echoed to the server via `Last-Event-ID` on reconnect. */
  lastEventId: string
}

const LF = '\n'
const CR = '\r'
const BOM = '﻿'

/**
 * Incremental SSE parser. Feed it decoded text with {@link SseParser.feed}; it returns the
 * events completed by that chunk. `retry:` and `id:` updates are readable via
 * {@link SseParser.streamState}.
 */
export class SseParser {
  /** Text seen but not yet terminated by a line ending. */
  private pending = ''
  /** Accumulated `data:` lines for the event under construction. */
  private dataBuffer: string[] = []
  /** `event:` type for the event under construction (empty ⇒ default `message`). */
  private eventType = ''
  private lastEventId = ''
  private retry: number | undefined
  private bomStripped = false

  /** The current stream-level state (last event id + last retry hint). */
  get streamState(): SseStreamState {
    return { retry: this.retry, lastEventId: this.lastEventId }
  }

  /** Feeds a decoded text chunk and returns any events it completed. */
  feed(chunk: string): SseEvent[] {
    this.pending += chunk
    if (!this.bomStripped) {
      if (this.pending.length === 0) return []
      if (this.pending.startsWith(BOM)) this.pending = this.pending.slice(BOM.length)
      this.bomStripped = true
    }

    const events: SseEvent[] = []
    for (const line of this.takeCompleteLines()) {
      const event = this.processLine(line)
      if (event) events.push(event)
    }
    return events
  }

  /**
   * Splits {@link SseParser.pending} into complete lines, retaining any trailing partial
   * line (and a trailing lone `\r`, which may become a `\r\n` once more bytes arrive) in the
   * buffer for the next {@link SseParser.feed}.
   */
  private takeCompleteLines(): string[] {
    const lines: string[] = []
    const s = this.pending
    let start = 0
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === LF) {
        lines.push(s.slice(start, i))
        i += 1
        start = i
      } else if (c === CR) {
        if (i + 1 < s.length) {
          lines.push(s.slice(start, i))
          i += s[i + 1] === LF ? 2 : 1
          start = i
        } else {
          // Trailing lone CR: defer — the next chunk may start with LF (a split CRLF).
          break
        }
      } else {
        i += 1
      }
    }
    this.pending = s.slice(start)
    return lines
  }

  /** Applies one line per HTML §9.2; returns a dispatched event on a blank line, else null. */
  private processLine(line: string): SseEvent | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null // comment

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1) // strip a single leading space

    switch (field) {
      case 'event':
        this.eventType = value
        break
      case 'data':
        this.dataBuffer.push(value)
        break
      case 'id':
        // HTML §9.2: ignore an id containing a NUL; otherwise set the last event id.
        if (!value.includes('\0')) this.lastEventId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value)
        break
      default:
        break // unknown field — ignore
    }
    return null
  }

  /**
   * Dispatches the buffered event (HTML §9.2 "dispatch the event"): if no `data:` was seen,
   * nothing is emitted but the field buffers still reset; otherwise the data lines are joined
   * with `\n` (a single trailing `\n` is dropped) and the event type defaults to `message`.
   */
  private dispatch(): SseEvent | null {
    const hadData = this.dataBuffer.length > 0
    const data = this.dataBuffer.join(LF)
    const type = this.eventType === '' ? 'message' : this.eventType
    this.dataBuffer = []
    this.eventType = ''
    if (!hadData) return null
    return { type, data, lastEventId: this.lastEventId }
  }
}
