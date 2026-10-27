# 048 — Stalwart 1.0 is a second baseline, and the seam translates

- **Status:** accepted
- **Date:** 2026-10-27
- **Work package:** Stalwart 1.0 readiness
- **Relates to:** NFR-COMPAT-02 (the baseline clause this fulfils), ADR-006 (OAuth token posture),
  ADR-020 (no send-as from a delegated account), ADR-025 (the calendar wire format is the server's),
  ADR-046 (a shared account syncs what it serves), `packages/jmap/src/filenode-wire.ts`,
  `apps/web/src/auth/controller.ts` (`clientFor`), `apps/web/src/sync/engine/calendar-window.ts`

## Context

NFR-COMPAT-02 said it in advance: *"If the upcoming Stalwart v1.0 ships changes Waxwing needs, the
baseline is raised to v1.0; otherwise v0.16 remains the supported minimum."* Stalwart 1.0.0 shipped on
2026-10-26. Its release notes call out "multiple breaking changes and a new database layout" and say
nothing of what a **client** sees. So the question was put to the server: the same fixture, the same
suites, 0.16.27 beside 1.0.0.

Eight things broke or changed, and four of them are not the kind a changelog lists:

| | 0.16.27 | 1.0.0 | Effect on Waxwing |
| --- | --- | --- | --- |
| **Application bundle** | `index.html` is enough | `stalwart-app.json` is mandatory | the 0.25.1 zip cannot be installed; `UpdateApps` still reports success |
| **OAuth client** | any `client_id` | "Unknown client id" | **sign-in with OAuth — the primary button — stopped working** |
| `FileNode` | `nodeType`, `type`, nulls | `@type`, `mediaType`, absent values, a seventh right | Files unusable: creating a folder or file is refused |
| Expanded calendar query | `AND`/`OR` filter accepted | a single condition only | "The calendar could not be loaded" for every user |
| Shared account, `Identity/get` | `forbidden` | `accountNotSupportedByMethod` | a shared address book or calendar never arrives |
| Directory queries | on | **off** (`Sharing.allowDirectoryQueries`) | every share dialog finds nobody |
| Application fields | `enabled`, `autoUpdateFrequency` | `enable`, `autoUpdateInterval` | the documented install command is refused |
| Contact photo | stored as `uri` | stored as `blobId` | none in the app (it renders either); one test assumed the old form |

None of these is in the 1.0.0 release notes except the Application renames, and those only as a line
in a separate schema document. The self-service registry the Security section uses (`x:AppPassword`,
`x:AccountSettings`, …) is unchanged.

## Decision

**Waxwing supports Stalwart 0.16.27 and 1.0.0, and the end-to-end suites are the proof for both.** The
baseline is not *raised* to 1.0, as the clause allowed, because the server in production use is 0.16
today and migrating it is a one-way, data-copying operation (Stalwart's `stalwart-migrate`) that the
operator should be free to schedule. A client that forces the order would force that schedule.

Where the two disagree, **the difference is translated once, at the seam, and nothing downstream
learns there are two**:

- `FileNode` is normalised where it enters the app (`normalizeFileNode`, applied by the files client
  and by the sync port) and written in the dialect the account's own capability announces
  (`supportedNodeTypes` is present on 1.0 only). The Files screen still reads `node.nodeType`.
- The expanded calendar query is split into one single-condition query per calendar
  (`expandedQueries`). Both servers accept that form; the operator form is kept for the unexpanded
  companion query, where both accept it too.
- A refusal on a shared account counts as one permanent refusal whichever of its two names the server
  uses.
- The OAuth client is chosen **after** discovery, from what the server says about itself
  (`client_id_metadata_document_supported`), not from a version number: on 1.0 the app's own
  `oauth-client.json` URL, on 0.16 the old free-form id. A deployment that registered a client of its
  own is never second-guessed.

The release bundle gains `stalwart-app.json` and `oauth-client.json`. Both are harmless on 0.16 (it
serves them as two unremarkable static files), so **one zip serves both servers** and an installation
that auto-updates keeps working through its server's migration.

## Consequences

- **Order of operations for an operator:** upgrade Waxwing first, migrate Stalwart second. A server
  migrated while it still holds the 0.25.1 bundle comes up with no webmail until the next fetch.
- **OAuth sessions end at the migration.** Stalwart does not migrate tokens, so users sign in once
  more; the app already turns a terminal refresh rejection into the sign-in screen.
- **ADR-006 is half-superseded.** 1.0 advertises a `revocation_endpoint`, and the hook that ADR left
  in place (`revokeToken` fires iff discovery lists one) now fires: signing out against 1.0 revokes the
  refresh token on the server. On 0.16 it remains a local wipe. The ADR's consequence list should be
  read with that in mind; the statement that a leaked token cannot be cut short is true of 0.16 only.
- **ADR-020 stands, for a better reason.** 1.0 no longer *advertises* `submission` on a shared
  account, so the "advertised but forbidden" trap it describes is closed on the server's side. The
  integration test now reports the advertisement and asserts the refusal, which holds on both.
- **A new failure mode, and a new message:** with directory queries off, the people search in a share
  dialog says so instead of "failed", and the deployment guide tells an operator which switch to
  flip. The composer's suggestions degrade silently, as before.
- **The fixture is a pin plus a lesson.** `docker-compose.yml` pins one version at a time; the
  other is reached with `WAXWING_STALWART_TAG` (see `e2e/stalwart/README.md`). A fixture that
  trails upstream hides exactly this kind of break — the compose file's own history (finding I-1, and
  the language spelling that changed in 0.16.20) says the same.
- **Not done here, deliberately:** nothing in Waxwing uses JMAP Object Metadata, connected
  applications or attachment search yet. They are available on 1.0 and are separate decisions.
