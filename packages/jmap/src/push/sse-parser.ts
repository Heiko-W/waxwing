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
 *
 * Unlike the browser's parser it is fed by an authenticated stream that a hostile server (or
 * anything that can inject into it) controls completely, so it is bounded: the unterminated tail
 * and the accumulated `data:` payload are each capped at {@link MAX_SSE_BUFFER_CHARS} and the
 * `retry:` hint at {@link MAX_RETRY_HINT_MS}. Line scanning carries a cursor across feeds, so a
 * stream that never sends a terminator cannot be made quadratic by re-scanning the same tail.
 */

import { JmapError } from '../errors'
import { MAX_RETRY_HINT_MS } from './reconnect'

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
  /**
   * Last `retry:` value parsed (ms), clamped to {@link MAX_RETRY_HINT_MS}, or `undefined` if the
   * server never sent a well-formed one.
   */
  retry: number | undefined
  /** Current last-event-id, echoed to the server via `Last-Event-ID` on reconnect. */
  lastEventId: string
}

/**
 * Ceiling (1 MiB, counted in UTF-16 code units) for BOTH the unterminated tail and the joined
 * `data:` payload of one event. Neither has an inherent bound: a stream that opens with `data: `
 * and then sends bytes forever, or that never sends a line terminator at all, would otherwise grow
 * a string in the tab until it dies — no request, no timeout and no error, just a page that stops
 * responding. Exceeding it discards the partial event and ends the connection with an error, which
 * the reconnect loop then backs off and retries; a well-behaved server never approaches it (a JMAP
 * StateChange is a few hundred bytes).
 */
export const MAX_SSE_BUFFER_CHARS = 1_048_576

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
  /**
   * How much of {@link SseParser.pending} has already been scanned for a line terminator and is
   * known not to contain one. Without it every feed re-scanned the whole tail, so a stream that
   * withholds terminators costs O(n²) as well as O(n) memory.
   */
  private scanned = 0
  /** Accumulated `data:` lines for the event under construction. */
  private dataBuffer: string[] = []
  /** Length {@link SseParser.dataBuffer} will have once joined — the bound is checked on this. */
  private dataLength = 0
  /** `event:` type for the event under construction (empty ⇒ default `message`). */
  private eventType = ''
  private lastEventId = ''
  private retry: number | undefined
  private bomStripped = false

  /** The current stream-level state (last event id + last retry hint). */
  get streamState(): SseStreamState {
    return { retry: this.retry, lastEventId: this.lastEventId }
  }

  /**
   * Feeds a decoded text chunk and returns any events it completed.
   *
   * Throws a {@link JmapError} when the chunk pushes an unterminated line or an event's `data:`
   * past {@link MAX_SSE_BUFFER_CHARS}. The parser resets itself first, but the caller is expected
   * to drop the connection: the stream is either broken or hostile, and events completed earlier
   * in the same chunk are discarded along with it.
   */
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
    if (this.pending.length > MAX_SSE_BUFFER_CHARS) {
      this.overflow(`${this.pending.length} characters without a line terminator`)
    }
    return events
  }

  /**
   * Splits {@link SseParser.pending} into complete lines, retaining any trailing partial
   * line (and a trailing lone `\r`, which may become a `\r\n` once more bytes arrive) in the
   * buffer for the next {@link SseParser.feed}. Scanning resumes at
   * {@link SseParser.scanned} — the prefix left over from earlier feeds is terminator-free by
   * construction, except for a deferred trailing CR, which is deliberately re-examined.
   */
  private takeCompleteLines(): string[] {
    const lines: string[] = []
    const s = this.pending
    let start = 0
    let i = this.scanned
    let deferredCr = false
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
          deferredCr = true
          break
        }
      } else {
        i += 1
      }
    }
    this.pending = s.slice(start)
    this.scanned = deferredCr ? this.pending.length - 1 : this.pending.length
    return lines
  }

  /** Resets every buffer and reports the overrun to the caller as a fatal stream error. */
  private overflow(what: string): never {
    this.pending = ''
    this.scanned = 0
    this.dataBuffer = []
    this.dataLength = 0
    this.eventType = ''
    throw new JmapError(
      `SSE stream exceeded the ${MAX_SSE_BUFFER_CHARS}-character parse buffer (${what}); dropping the connection.`,
    )
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
        // +1 for the LF `dispatch()` joins with — count what the payload will actually cost.
        this.dataLength += value.length + LF.length
        if (this.dataLength > MAX_SSE_BUFFER_CHARS) {
          this.overflow(`${this.dataLength} characters of data: in one event`)
        }
        this.dataBuffer.push(value)
        break
      case 'id':
        // HTML §9.2: ignore an id containing a NUL; otherwise set the last event id.
        if (!value.includes('\0')) this.lastEventId = value
        break
      case 'retry':
        // HTML §9.2 accepts any digit string, but this value becomes a FLOOR on the reconnect
        // delay, so an unbounded one is a remote off-switch (or, past 2^31-1, a hot loop when the
        // host timer overflows). Clamped here, at the wire, as well as in the reconnect loop.
        if (/^\d+$/.test(value)) this.retry = Math.min(Number(value), MAX_RETRY_HINT_MS)
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
    this.dataLength = 0
    this.eventType = ''
    if (!hadData) return null
    return { type, data, lastEventId: this.lastEventId }
  }
}
