/**
 * RFC 8621 §8 — VacationResponse (the "out of office" auto-responder).
 *
 * It is a **singleton**: exactly one object per account, whose id is always `"singleton"`. It is
 * never created and never destroyed — only fetched and updated. That is why {@link
 * VacationResponseSetRequest} deliberately has no `create`/`destroy`: a server MUST reject them
 * (RFC 8621 §8.2), and a type that offers them invites a call that can only fail.
 *
 * Capability: `urn:ietf:params:jmap:vacationresponse`.
 */

import type { GetRequest, GetResponse, Id, PatchObject, SetResponse, UTCDate } from './core'

/** The one and only VacationResponse id (RFC 8621 §8). */
export const VACATION_SINGLETON_ID = 'singleton'

export interface VacationResponse {
  /** Always {@link VACATION_SINGLETON_ID}. */
  id: Id
  /** Whether the responder is armed at all. Even when `true`, the dates below still gate it. */
  isEnabled: boolean
  /** UTC date-time the responder starts sending; `null` = no start bound (i.e. immediately). */
  fromDate: UTCDate | null
  /** UTC date-time it stops; `null` = no end bound (i.e. until switched off). */
  toDate: UTCDate | null
  /** `null` lets the server pick a subject (RFC 8621 §8.1). */
  subject: string | null
  textBody: string | null
  htmlBody: string | null
}

export type VacationResponseGetRequest = GetRequest
export type VacationResponseGetResponse = GetResponse<VacationResponse>

/** `/set` on a singleton: update only (RFC 8621 §8.2). */
export interface VacationResponseSetRequest {
  accountId: Id
  ifInState?: string | null
  update?: Record<Id, PatchObject> | null
}

export type VacationResponseSetResponse = SetResponse<VacationResponse>
