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
 * Raising Stalwart's limit for the SEEDERS would be the shorter change and the wrong one: they are
 * scaffolding, they burst by nature, and waiting costs nothing but seconds. So the seeders wait.
 *
 * The APP's side of that sentence used to read "and still meets the real limit" — it no longer
 * does, and the correction is worth stating rather than quietly editing away. The limit is per
 * AUTHENTICATED ACCOUNT (1000/min), and the suite drives one account through 108 sign-ins in five
 * minutes where a real client's entire sign-in is fourteen requests. What the app met was therefore
 * not the server's real behaviour but a budget the previous hundred tests had spent, at random,
 * about one run in three. `fixture.mjs#RATE_LIMIT_PER_MINUTE` now lifts that ceiling for the
 * fixture and explains the whole measurement; read it before changing either file.
 *
 * The original argument was not wrong, and it paid off before it was retired: the 429s it let
 * through exposed a genuine defect (a pass that failed after committing mail swallowed its
 * notification for good — engine.ts#mailDeltaRan). That behaviour is now asserted where a test can
 * assert it deterministically, in unit tests that inject the 429 on purpose, instead of depending
 * on the fixture happening to be exhausted.
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
