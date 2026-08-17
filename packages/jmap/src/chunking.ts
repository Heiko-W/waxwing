import { isMethodError, JmapError } from './errors'
import type { Invocation } from './types/core'

/**
 * Auto-chunking of a JMAP request against the session limits (FR-SRV-03, RFC 8620 §3.4).
 *
 * A logical batch of method calls is split into one or more physical HTTP requests so
 * that no request violates `maxObjectsInGet`, `maxObjectsInSet`, `maxCallsInRequest` or
 * `maxSizeRequest`, then the physical responses are re-assembled so callers see exactly
 * the responses they would have got from a single unlimited request.
 *
 * Constraints honoured:
 *  - A `/get` with a literal `ids` array longer than `maxObjectsInGet` is split into
 *    several `/get` calls and its `list`/`notFound` are concatenated on the way back.
 *    NOTE: the `maxObjectsInGet` guarantee holds only for gets with a *literal* `ids`
 *    array. A `/get` that takes its ids from a back-reference (`#ids` → a preceding
 *    query's result) cannot be bounded here — its id count is unknown until the server
 *    resolves it — so callers chaining `query → get` MUST cap the driving query's `limit`
 *    at `maxObjectsInGet`, else the server may reject the get with `requestTooLarge`.
 *  - A `/set` whose create+update+destroy count exceeds `maxObjectsInSet` is split and
 *    its result maps merged (only when it carries no `ifInState` guard and no intra-set
 *    creation-id reference — see below). Such a split `/set` is NON-ATOMIC: the chunks run
 *    as independent method calls, so a method-level failure on one chunk does not roll back
 *    the others. On a partial failure the merged response still reports every succeeded
 *    object in `created`/`updated`/`destroyed` and folds each failed chunk's objects into
 *    `notCreated`/`notUpdated`/`notDestroyed`, so a caller never loses track of what the
 *    server actually applied (and never blindly retries the whole batch, duplicating it).
 *  - Calls linked by back-references (`ResultReference`) or creation-id refs (`#id`) are
 *    kept together in one physical request, because the server resolves both only within
 *    a single request. Such linked calls are never id/set-split.
 */

/** The subset of session limits that drive chunking (RFC 8620 core capability). */
export interface ChunkLimits {
  maxObjectsInGet: number
  maxObjectsInSet: number
  maxCallsInRequest: number
  maxSizeRequest: number
}

/**
 * Conservative fallback limits, used for any limit a server omits — or advertises as a value that
 * cannot be honoured (see {@link sanitizeLimits}). Real numbers are always read from the Session.
 */
export const FALLBACK_LIMITS: ChunkLimits = {
  maxObjectsInGet: 128,
  maxObjectsInSet: 128,
  maxCallsInRequest: 16,
  maxSizeRequest: 1_000_000,
}

/**
 * Replaces every limit that is not a finite integer > 0 with its {@link FALLBACK_LIMITS} value.
 *
 * Zero or negative is not a *stricter* limit, it is an unusable one, and each of the four fails
 * differently: `maxObjectsInSet: 0` made {@link splitSet}'s `i += max` loop never advance and
 * allocate chunk objects until the tab was OOM-killed — hit on the first write of a session
 * (mark-as-read, move, send), so a server advertising it let you connect and read and then froze
 * the main thread, every restart. `maxCallsInRequest`/`maxSizeRequest` of 0 are merely
 * unsatisfiable (every unit throws {@link JmapError}), which is a truthful failure but still an
 * app that cannot send a single request. RFC 8620 §2 requires positive integers here; JSON
 * guarantees nothing, and `session.ts`'s core-capability probe only tests `typeof === 'number'`,
 * which 0, -1, 1.5 and NaN all pass. Callers' explicit overrides are sanitized too — a limit is
 * not more trustworthy for having come from application code.
 */
export function sanitizeLimits(
  limits: {
    [K in keyof ChunkLimits]?: number | undefined
  },
): ChunkLimits {
  return {
    maxObjectsInGet: usable(limits.maxObjectsInGet, FALLBACK_LIMITS.maxObjectsInGet),
    maxObjectsInSet: usable(limits.maxObjectsInSet, FALLBACK_LIMITS.maxObjectsInSet),
    maxCallsInRequest: usable(limits.maxCallsInRequest, FALLBACK_LIMITS.maxCallsInRequest),
    maxSizeRequest: usable(limits.maxSizeRequest, FALLBACK_LIMITS.maxSizeRequest),
  }
}

/** `value` if it is a limit that can actually be honoured (integer > 0), else `fallback`. */
function usable(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
}

interface LogicalCall {
  /** Original `methodCallId`; also the physical id when the call is not split. */
  id: string
  name: string
  args: Record<string, unknown>
  /** Position in the original batch, used to keep output ordering stable. */
  index: number
}

interface LogicalPlan {
  id: string
  name: string
  kind: 'single' | 'get' | 'set'
  /** Physical `methodCallId`s that make up this logical call, in order. */
  chunkIds: string[]
}

/** A ready-to-execute chunking plan: the physical requests plus reassembly instructions. */
export interface ChunkPlan {
  /** Each entry is one HTTP request's `methodCalls`. */
  requests: Invocation[][]
  /** Reassembly instructions, one per logical call, in original order. */
  logical: LogicalPlan[]
}

/**
 * Builds a {@link ChunkPlan} for `calls` under `rawLimits` (run through {@link sanitizeLimits}
 * first, so a server-advertised 0/-1/NaN cannot reach the splitters). `using` is included in size
 * estimates; pass `createdIds` (the seed `createdIds` map the request will carry, RFC 8620
 * §5.8) so the size check accounts for the envelope the client actually POSTs.
 */
export function planRequest(
  calls: Invocation[],
  using: string[],
  rawLimits: ChunkLimits,
  createdIds?: Record<string, string>,
): ChunkPlan {
  const limits = sanitizeLimits(rawLimits)
  const logical: LogicalCall[] = calls.map((call, index) => ({
    id: call[2],
    name: call[0],
    args: isPlainObject(call[1]) ? call[1] : {},
    index,
  }))

  const { groupOf, componentSize } = analyseLinks(logical)

  // Expand each logical call into physical invocations. Only calls that are NOT linked to
  // any other call (their dependency component has size 1) may be id/set-split: splitting
  // a call that references or is referenced by another would break the reference.
  const plans: LogicalPlan[] = []
  const byRoot = new Map<number, { index: number; physical: Invocation[] }[]>()

  for (const call of logical) {
    const root = groupOf.get(call.id) ?? call.index
    const canSplit = (componentSize.get(root) ?? 1) === 1
    const { kind, physical } = expandCall(call, limits, canSplit)
    plans.push({ id: call.id, name: call.name, kind, chunkIds: physical.map((p) => p[2]) })

    const bucket = byRoot.get(root) ?? []
    bucket.push({ index: call.index, physical })
    byRoot.set(root, bucket)
  }

  // Build packing units. A multi-call dependency component is ONE glued unit (its calls
  // must share a request, ordered so referenced calls precede referrers). A lone call's
  // physical chunks are independent units that may be spread across requests.
  const units: { order: number; sub: number; calls: Invocation[] }[] = []
  for (const members of byRoot.values()) {
    members.sort((a, b) => a.index - b.index)
    const first = members[0]
    if (first === undefined) continue
    if (members.length > 1) {
      units.push({ order: first.index, sub: 0, calls: members.flatMap((m) => m.physical) })
    } else {
      first.physical.forEach((call, k) => {
        units.push({ order: first.index, sub: k, calls: [call] })
      })
    }
  }
  units.sort((a, b) => a.order - b.order || a.sub - b.sub)

  const requests = binPackUnits(units, using, limits, createdIds)
  return { requests, logical: plans }
}

/**
 * Re-assembles the physical method responses (concatenated across all HTTP requests, in
 * order) into the logical responses described by `plan`, relabelled to the original
 * `methodCallId`s.
 *
 * For an un-split call (`single`) or a split `/get`, a method-level error on any chunk
 * surfaces as the logical response. A split `/set` is non-atomic (see the module header):
 * only if EVERY chunk failed does the whole logical `/set` become a method-level error;
 * a partial failure is merged, with each failed chunk's objects folded into the
 * `notCreated`/`notUpdated`/`notDestroyed` maps so no succeeded id is ever lost.
 */
export function reassembleResponses(
  plan: ChunkPlan,
  physicalResponses: Invocation[],
): Invocation[] {
  const byId = new Map<string, Invocation[]>()
  for (const response of physicalResponses) {
    const bucket = byId.get(response[2]) ?? []
    bucket.push(response)
    byId.set(response[2], bucket)
  }
  // Which objects each physical chunk carried, so a failed chunk's objects can be attributed
  // back to notCreated/notUpdated/notDestroyed on a partial split-/set failure.
  const requestArgsById = new Map<string, Record<string, unknown>>()
  for (const request of plan.requests) {
    for (const call of request) if (isPlainObject(call[1])) requestArgsById.set(call[2], call[1])
  }

  const out: Invocation[] = []
  for (const entry of plan.logical) {
    const chunks = entry.chunkIds.flatMap((id) => byId.get(id) ?? [])

    if (entry.kind === 'set') {
      const setChunks: SetChunk[] = chunks.map((chunk) => ({
        response: isPlainObject(chunk[1]) ? chunk[1] : {},
        request: requestArgsById.get(chunk[2]) ?? {},
        isError: isMethodError(chunk),
      }))
      const allFailed = setChunks.length > 0 && setChunks.every((c) => c.isError)
      const firstError = chunks.find((c) => isMethodError(c))
      if (allFailed && firstError) {
        out.push(['error', firstError[1], entry.id])
      } else {
        out.push([entry.name, mergeSetResponses(setChunks), entry.id])
      }
      continue
    }

    const firstError = chunks.find((c) => isMethodError(c))
    if (firstError) {
      out.push(['error', firstError[1], entry.id])
      continue
    }
    if (entry.kind === 'single') {
      for (const chunk of chunks) out.push([chunk[0], chunk[1], entry.id])
    } else {
      out.push([entry.name, mergeGetResponses(chunks), entry.id])
    }
  }
  return out
}

// ── Link analysis (back-references + creation-id refs) ─────────────────────────────

function analyseLinks(logical: LogicalCall[]): {
  groupOf: Map<string, number>
  componentSize: Map<number, number>
} {
  const idToIndex = new Map<string, number>()
  for (const call of logical) idToIndex.set(call.id, call.index)

  // creationId → logical id of the call that creates it.
  const creationOwner = new Map<string, string>()
  for (const call of logical) {
    const create = call.args.create
    if (isPlainObject(create))
      for (const creationId of Object.keys(create)) creationOwner.set(creationId, call.id)
  }

  const uf = new UnionFind(logical.length)
  for (const call of logical) {
    for (const targetId of collectReferences(call.args, creationOwner)) {
      if (targetId === call.id) continue
      const targetIndex = idToIndex.get(targetId)
      if (targetIndex === undefined) continue
      uf.union(call.index, targetIndex)
    }
  }

  const groupOf = new Map<string, number>()
  const componentSize = new Map<number, number>()
  for (const call of logical) {
    const root = uf.find(call.index)
    groupOf.set(call.id, root)
    componentSize.set(root, (componentSize.get(root) ?? 0) + 1)
  }
  return { groupOf, componentSize }
}

/**
 * Walks a value tree collecting the logical ids it back-references or creation-id-references.
 *
 * A creation-id reference (`#<id>`) is recognised both as a string VALUE (e.g.
 * `emailId: '#draft'`) and as an object KEY (the canonical `mailboxIds: { '#newFolder': true }`
 * pattern, RFC 8620 §5.3) — missing the key form would let the creating and referencing calls
 * be bin-packed into different physical requests, silently breaking the reference.
 *
 * Heuristic constraint: any `#`-prefixed string/key whose suffix matches a known creation id is
 * treated as a reference, regardless of where it sits in the args tree. A data value that merely
 * happens to equal `#<someCreationId>` therefore falsely links two calls — but that only
 * over-constrains packing (keeps calls together), it never breaks a real reference.
 */
function collectReferences(value: unknown, creationOwner: Map<string, string>): Set<string> {
  const found = new Set<string>()
  const addIfCreationRef = (raw: string): void => {
    if (!raw.startsWith('#')) return
    const owner = creationOwner.get(raw.slice(1))
    if (owner) found.add(owner)
  }
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      addIfCreationRef(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (isPlainObject(node)) {
      if (isResultReference(node)) found.add(node.resultOf)
      for (const [key, item] of Object.entries(node)) {
        addIfCreationRef(key)
        visit(item)
      }
    }
  }
  visit(value)
  return found
}

function isResultReference(
  value: Record<string, unknown>,
): value is { resultOf: string; name: string; path: string } {
  return (
    typeof value.resultOf === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string'
  )
}

// ── Per-call expansion ─────────────────────────────────────────────────────────────

function expandCall(
  call: LogicalCall,
  limits: ChunkLimits,
  canSplit: boolean,
): { kind: LogicalPlan['kind']; physical: Invocation[] } {
  if (canSplit && call.name.endsWith('/get')) {
    const ids = call.args.ids
    if (Array.isArray(ids) && limits.maxObjectsInGet > 0 && ids.length > limits.maxObjectsInGet) {
      const groups = chunk(ids, limits.maxObjectsInGet)
      return {
        kind: 'get',
        physical: groups.map((slice, k) => [
          call.name,
          { ...call.args, ids: slice },
          chunkId(call.id, k),
        ]),
      }
    }
  }

  // The `> 0` mirrors the /get twin above. {@link planRequest} already sanitizes, so this can
  // only bite a future direct caller — but the failure it prevents is {@link splitSet} looping
  // forever on `i += max`, which costs the whole tab, so the second door stays shut too.
  if (
    canSplit &&
    call.name.endsWith('/set') &&
    limits.maxObjectsInSet > 0 &&
    countSetObjects(call.args) > limits.maxObjectsInSet
  ) {
    if (typeof call.args.ifInState === 'string') {
      throw new JmapError(
        `Cannot auto-chunk ${call.name} (${countSetObjects(call.args)} objects > maxObjectsInSet ${limits.maxObjectsInSet}) while ifInState is set: splitting would break the state guard.`,
      )
    }
    // A `/set` whose own `create` values reference its own creation ids (RFC 8620 §5.3, e.g.
    // creating a parent and a child that points at `#parent`) must NOT be object-split: the
    // server resolves such a reference only within one create. Keep it whole (non-split);
    // it may exceed maxObjectsInSet on the wire, but that is preferable to a broken reference.
    if (isPlainObject(call.args.create) && hasIntraSetCreationRef(call.args.create)) {
      return { kind: 'single', physical: [[call.name, call.args, call.id]] }
    }
    return { kind: 'set', physical: splitSet(call, limits.maxObjectsInSet) }
  }

  return { kind: 'single', physical: [[call.name, call.args, call.id]] }
}

/**
 * `true` if a `/set` `create` map contains a reference to one of its OWN creation ids — a
 * `#<id>` string value or object key where `<id>` is a sibling `create` key. Such a set is
 * indivisible: the intra-set reference (RFC 8620 §5.3) resolves only within one create, so
 * the referrer and its referent must stay in the same physical call.
 */
function hasIntraSetCreationRef(create: Record<string, unknown>): boolean {
  const ownIds = new Set(Object.keys(create))
  const refsOwnId = (raw: string): boolean => raw.startsWith('#') && ownIds.has(raw.slice(1))
  const scan = (node: unknown): boolean => {
    if (typeof node === 'string') return refsOwnId(node)
    if (Array.isArray(node)) return node.some(scan)
    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (refsOwnId(key) || scan(value)) return true
      }
    }
    return false
  }
  // Scan the created objects (create values), not the top-level creation-id keys themselves.
  return Object.values(create).some(scan)
}

function splitSet(call: LogicalCall, max: number): Invocation[] {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(call.args)) {
    if (key !== 'create' && key !== 'update' && key !== 'destroy') base[key] = value
  }
  const create = isPlainObject(call.args.create) ? Object.entries(call.args.create) : []
  const update = isPlainObject(call.args.update) ? Object.entries(call.args.update) : []
  const destroy = Array.isArray(call.args.destroy) ? call.args.destroy : []

  const items: (['create' | 'update', string, unknown] | ['destroy', unknown])[] = [
    ...create.map(([k, v]) => ['create', k, v] as ['create', string, unknown]),
    ...update.map(([k, v]) => ['update', k, v] as ['update', string, unknown]),
    ...destroy.map((id) => ['destroy', id] as ['destroy', unknown]),
  ]

  const out: Invocation[] = []
  for (let i = 0, k = 0; i < items.length; i += max, k++) {
    const slice = items.slice(i, i + max)
    const args: Record<string, unknown> = { ...base }
    const creates: Record<string, unknown> = {}
    const updates: Record<string, unknown> = {}
    const destroys: unknown[] = []
    for (const item of slice) {
      if (item[0] === 'create') creates[item[1]] = item[2]
      else if (item[0] === 'update') updates[item[1]] = item[2]
      else destroys.push(item[1])
    }
    if (Object.keys(creates).length > 0) args.create = creates
    if (Object.keys(updates).length > 0) args.update = updates
    if (destroys.length > 0) args.destroy = destroys
    out.push([call.name, args, chunkId(call.id, k)])
  }
  return out.length > 0 ? out : [[call.name, call.args, call.id]]
}

// ── Bin-packing groups into physical requests ──────────────────────────────────────

function binPackUnits(
  units: { order: number; sub: number; calls: Invocation[] }[],
  using: string[],
  limits: ChunkLimits,
  createdIds?: Record<string, string>,
): Invocation[][] {
  const requests: Invocation[][] = []
  let current: Invocation[] = []

  for (const unit of units) {
    if (unit.calls.length === 0) continue
    // A unit is indivisible: it is either a single call or a glued back-reference group.
    if (unit.calls.length > limits.maxCallsInRequest) {
      throw new JmapError(
        `A back-referenced call group needs ${unit.calls.length} method calls but maxCallsInRequest is ${limits.maxCallsInRequest}; it cannot be split without breaking references.`,
      )
    }
    const unitSize = requestByteSize(using, unit.calls, createdIds)
    if (unitSize > limits.maxSizeRequest) {
      throw new JmapError(
        `A single method call serializes to ${unitSize} bytes but maxSizeRequest is ${limits.maxSizeRequest}; it cannot be chunked further.`,
      )
    }
    const candidate = [...current, ...unit.calls]
    const fitsCount = candidate.length <= limits.maxCallsInRequest
    const fitsSize = requestByteSize(using, candidate, createdIds) <= limits.maxSizeRequest
    if (current.length > 0 && (!fitsCount || !fitsSize)) {
      requests.push(current)
      current = [...unit.calls]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) requests.push(current)
  return requests
}

// ── Response merging ───────────────────────────────────────────────────────────────

function mergeGetResponses(chunks: Invocation[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const list: unknown[] = []
  const notFound: unknown[] = []
  chunks.forEach((chunk, i) => {
    const args = isPlainObject(chunk[1]) ? chunk[1] : {}
    if (i === 0) {
      if ('accountId' in args) merged.accountId = args.accountId
      if ('state' in args) merged.state = args.state
    }
    // Appended element-wise for the same reason as in `JmapClient.call`: `push(...serverArray)`
    // is a RangeError waiting for a server that answers with a few hundred thousand objects.
    if (Array.isArray(args.list)) appendAll(list, args.list)
    if (Array.isArray(args.notFound)) appendAll(notFound, args.notFound)
  })
  merged.list = list
  merged.notFound = notFound
  return merged
}

/** One chunk of a split `/set`: its response args, the request args it was sent with, and whether it errored. */
interface SetChunk {
  response: Record<string, unknown>
  request: Record<string, unknown>
  isError: boolean
}

/**
 * Merges the chunks of a split `/set`. Succeeded chunks contribute their
 * `created`/`updated`/`destroyed` and `not*` maps; a failed chunk (method-level error)
 * contributes its request objects to `notCreated`/`notUpdated`/`notDestroyed` as per-object
 * {@link SetError}s, so callers see exactly which objects were NOT applied and never retry the
 * whole batch. `oldState` comes from the first succeeded chunk, `newState` from the last.
 */
function mergeSetResponses(chunks: SetChunk[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const objectFields = ['created', 'updated', 'notCreated', 'notUpdated', 'notDestroyed'] as const
  const accumulators: Record<string, Record<string, unknown>> = {}
  const destroyed: unknown[] = []
  let sawDestroyed = false
  let firstSuccessSeen = false

  const foldInto = (field: string, key: string, error: Record<string, unknown>): void => {
    const acc = accumulators[field] ?? {}
    acc[key] = error
    accumulators[field] = acc
  }

  for (const chunk of chunks) {
    if (chunk.isError) {
      const error = setErrorFromMethodError(chunk.response)
      const { create, update, destroy } = chunk.request
      if (isPlainObject(create))
        for (const k of Object.keys(create)) foldInto('notCreated', k, error)
      if (isPlainObject(update))
        for (const k of Object.keys(update)) foldInto('notUpdated', k, error)
      if (Array.isArray(destroy))
        for (const id of destroy) foldInto('notDestroyed', String(id), error)
      continue
    }
    const args = chunk.response
    if (!firstSuccessSeen) {
      firstSuccessSeen = true
      if ('accountId' in args) merged.accountId = args.accountId
      merged.oldState = 'oldState' in args ? args.oldState : null
    }
    if ('newState' in args) merged.newState = args.newState
    for (const field of objectFields) {
      const value = args[field]
      if (isPlainObject(value))
        accumulators[field] = Object.assign(accumulators[field] ?? {}, value)
    }
    if (Array.isArray(args.destroyed)) {
      sawDestroyed = true
      appendAll(destroyed, args.destroyed)
    }
  }

  for (const field of objectFields) merged[field] = accumulators[field] ?? null
  merged.destroyed = sawDestroyed ? destroyed : null
  return merged
}

/** Represents a chunk's method-level error as a per-object {@link SetError} for the `not*` maps. */
function setErrorFromMethodError(error: Record<string, unknown>): Record<string, unknown> {
  return {
    type: typeof error.type === 'string' ? error.type : 'serverFail',
    description: typeof error.description === 'string' ? error.description : null,
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────────────

class UnionFind {
  private parent: number[]
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
  }
  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root] as number
    let node = x
    while (this.parent[node] !== root) {
      const next = this.parent[node] as number
      this.parent[node] = root
      node = next
    }
    return root
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

function countSetObjects(args: Record<string, unknown>): number {
  const create = isPlainObject(args.create) ? Object.keys(args.create).length : 0
  const update = isPlainObject(args.update) ? Object.keys(args.update).length : 0
  const destroy = Array.isArray(args.destroy) ? args.destroy.length : 0
  return create + update + destroy
}

function requestByteSize(
  using: string[],
  methodCalls: Invocation[],
  createdIds?: Record<string, string>,
): number {
  const body = createdIds ? { using, methodCalls, createdIds } : { using, methodCalls }
  return new TextEncoder().encode(JSON.stringify(body)).length
}

function chunkId(id: string, index: number): string {
  return index === 0 ? id : `${id}~${index}`
}

/** Appends every element of `items` to `target`. The spread form has an argument-count ceiling. */
function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
