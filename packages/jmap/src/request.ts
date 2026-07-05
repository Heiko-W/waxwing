import { isMethodError, JmapMethodError } from './errors'
import type {
  CreationId,
  ExtendedJSONPointer,
  Invocation,
  MethodErrorObject,
  ResultReference,
} from './types/core'

/**
 * Handle to a queued method call, returned by {@link RequestBuilder.call}. Use
 * {@link CallHandle.ref} to build a back-reference from a later call to this one's result.
 */
export class CallHandle {
  constructor(
    /** The `methodCallId` assigned to this call. */
    readonly callId: string,
    /** The method name (e.g. `"Email/query"`). */
    readonly name: string,
  ) {}

  /**
   * Builds a {@link ResultReference} into this call's response, for use as the value of a
   * `#`-prefixed argument on a later call (RFC 8620 §3.7). E.g. chaining `Email/query` →
   * `Email/get`: `builder.call('Email/get', { accountId, '#ids': query.ref('/ids') })`.
   */
  ref(path: ExtendedJSONPointer): ResultReference {
    return { resultOf: this.callId, name: this.name, path }
  }
}

/** Builds a creation-id reference value (`#<creationId>`) for use inside a `/set` (RFC 8620 §5.3). */
export function creationRef(creationId: CreationId): string {
  return `#${creationId}`
}

/**
 * A typed JMAP method: its wire `name` branded with the argument type `A` and response
 * type `R`. Pass one to {@link RequestBuilder.invoke} for a fully typed call whose response
 * is inferred by {@link MethodResponses.get}. See `methods.ts` for the ready-made registry.
 */
export interface MethodDef<A, R> {
  readonly name: string
  /** Phantom markers; never present at runtime. */
  readonly __args?: A
  readonly __response?: R
}

/** Defines a {@link MethodDef} for a JMAP method name, binding its argument and response types. */
export function defineMethod<A, R>(name: string): MethodDef<A, R> {
  return { name }
}

/**
 * Optional back-reference substitutions (RFC 8620 §3.7): alongside a method's own arguments,
 * any `#<argName>` key may carry a {@link ResultReference} that the server resolves before the
 * method runs (e.g. `'#ids'` replacing `ids`). {@link RequestBuilder.invoke} accepts these on
 * top of the typed argument object.
 */
export type BackReferenceArgs = { [K in `#${string}`]?: ResultReference }

/**
 * A {@link CallHandle} that additionally remembers its response type `R`, so
 * {@link MethodResponses.get} can infer the result without an explicit type argument.
 * Returned by {@link RequestBuilder.invoke}. The `__response` marker is type-only.
 */
export interface TypedCallHandle<R> extends CallHandle {
  readonly __response?: R
}

/**
 * Accumulates method calls into a JMAP request. Client-side `methodCallId`s are assigned
 * automatically (`c0`, `c1`, …) unless supplied. Obtain one from {@link JmapClient.request}
 * and `await builder.send()`, or read {@link RequestBuilder.invocations} to execute yourself.
 */
export class RequestBuilder {
  private readonly calls: Invocation[] = []
  private seq = 0

  constructor(private readonly executor?: (builder: RequestBuilder) => Promise<MethodResponses>) {}

  /** Queues a method call and returns its {@link CallHandle}. */
  call<A>(name: string, args: A, methodCallId?: string): CallHandle {
    const id = methodCallId ?? `c${this.seq++}`
    this.calls.push([name, args, id])
    return new CallHandle(id, name)
  }

  /**
   * Queues a typed method call from a {@link MethodDef}, returning a {@link TypedCallHandle}
   * whose response type is inferred by {@link MethodResponses.get}. Back-reference arguments
   * (`#<argName>`, a {@link ResultReference}) may be supplied alongside the typed arguments.
   * Prefer this over {@link RequestBuilder.call} for the methods in the `Methods` registry.
   */
  invoke<A, R>(
    method: MethodDef<A, R>,
    args: A & BackReferenceArgs,
    methodCallId?: string,
  ): TypedCallHandle<R>
  invoke<A, R>(method: MethodDef<A, R>, args: A, methodCallId?: string): TypedCallHandle<R>
  invoke<A, R>(method: MethodDef<A, R>, args: A, methodCallId?: string): TypedCallHandle<R> {
    return this.call(method.name, args, methodCallId) as TypedCallHandle<R>
  }

  /** The queued invocations, in order. */
  get invocations(): Invocation[] {
    return [...this.calls]
  }

  /** The method-name → callId map for the queued calls (used for error attribution). */
  get names(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [name, , id] of this.calls) map.set(id, name)
    return map
  }

  /** Executes the request through the owning client. Throws if the builder was created standalone. */
  send(): Promise<MethodResponses> {
    if (!this.executor)
      throw new Error('This RequestBuilder is not bound to a client; use JmapClient.request()')
    return this.executor(this)
  }
}

/**
 * A view over a batch's reassembled method responses (RFC 8620 §3.4). Responses are
 * indexed by `methodCallId`; a single call may yield several responses.
 */
export class MethodResponses {
  private readonly byId = new Map<string, Invocation[]>()

  constructor(
    /** The reassembled response invocations, in logical order. */
    readonly responses: Invocation[],
    /** The session state reported by the (last) HTTP response. */
    readonly sessionState: string,
    /** Merged `createdIds` map, if the request used one. */
    readonly createdIds: Record<CreationId, string> | undefined,
    private readonly names: Map<string, string> = new Map(),
  ) {
    for (const response of responses) {
      const bucket = this.byId.get(response[2]) ?? []
      bucket.push(response)
      this.byId.set(response[2], bucket)
    }
  }

  /** All response invocations echoing `callId`. */
  all(callId: string): Invocation[] {
    return this.byId.get(callId) ?? []
  }

  /**
   * Returns the arguments of the first response for a {@link TypedCallHandle} (response type
   * inferred), a {@link CallHandle}, or a raw `callId`. Throws {@link JmapMethodError} if that
   * response is a method-level error.
   */
  get<R>(call: TypedCallHandle<R>): R
  get<T = unknown>(call: string | CallHandle): T
  get(call: string | CallHandle): unknown {
    const callId = typeof call === 'string' ? call : call.callId
    const first = this.all(callId)[0]
    if (!first) throw new Error(`No response for method call "${callId}"`)
    if (isMethodError(first)) {
      throw new JmapMethodError(first[1] as MethodErrorObject, callId, this.names.get(callId))
    }
    return first[1]
  }

  /** Every method-level error in the batch, as thrown-ready {@link JmapMethodError}s. */
  methodErrors(): JmapMethodError[] {
    const errors: JmapMethodError[] = []
    for (const response of this.responses) {
      if (isMethodError(response)) {
        errors.push(new JmapMethodError(response[1], response[2], this.names.get(response[2])))
      }
    }
    return errors
  }
}
