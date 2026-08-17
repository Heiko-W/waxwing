/**
 * `fetch` for the E2E fixture, with a bounded retry on 429.
 *
 * ## Why this exists
 * The suites drive Stalwart hard and in bursts. The read suite alone reseeds before EVERY test —
 * thirty-odd times per run, each a session fetch, three blob uploads, an `Email/set` and an
 * `Email/import` — and the gate then runs five more suites against the same server without pausing.
 * Stalwart applies its default request throttle to all of it, and on a slow two-core CI runner the
 * burst crosses it. The suite then fails with `HTTP 429` from the FIXTURE, which reads like a
 * product defect in the report and is not one: the seeders are scaffolding, not the thing under
 * test, and a red run that means "the test rig was impatient" costs more than it can ever catch.
 *
 * ## Why retrying, and not a more permissive fixture
 * Raising Stalwart's limit would be the shorter change and the wrong one. The throttle is the
 * server's real behaviour; an application that trips it has to cope with it, and a fixture tuned
 * looser than production hides exactly the class of bug worth finding. So the SEEDERS wait — the
 * app under test does not get this treatment and still meets the real limit.
 *
 * ## What this deliberately does NOT do
 * It does not retry anything but 429. A 5xx, a 401 or a malformed response is a result, and
 * swallowing it behind a retry loop would turn a broken fixture into a slow one. Five attempts is
 * the ceiling; past that the failure is real and belongs in the report.
 */

/** Attempts after the first, and the base delay when the server sends no `Retry-After`. */
const MAX_RETRIES = 5
const BASE_DELAY_MS = 250

/**
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @param {number} [attempt]
 * @returns {Promise<Response>}
 */
export async function fetchThrottled(url, init, attempt = 0) {
  const response = await fetch(url, init)
  if (response.status !== 429 || attempt >= MAX_RETRIES) return response
  // Honour `Retry-After` when it is sent; otherwise back off 250ms, 500ms, 1s, 2s, 4s.
  const header = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
  const waitMs = Number.isFinite(header) ? header * 1000 : BASE_DELAY_MS * 2 ** attempt
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return fetchThrottled(url, init, attempt + 1)
}
