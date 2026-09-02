# Code Review Waxwing — 01.09.2026

**Commit:** `e78e32b` (v0.22.0, `main` — Merge von PR #54, Branch `fix/code-review-2026-08`)

**Geprüfte Bereiche:**
- **Mail** — `apps/web/src/mail/**` (inkl. `cleanup/`, `labels/`, `pinned/`, `search/`)
- **Compose / Outbox / Sharing** — `apps/web/src/compose/**`, `apps/web/src/outbox/**`, `apps/web/src/sharing/**`
- **PIM** — `apps/web/src/calendar/**`, `apps/web/src/contacts/**`, `apps/web/src/files/**`
- **Sync** — `apps/web/src/sync/**` (`engine/`, `repo.ts`, `db.ts`, `react.tsx`), `apps/web/src/quota/**`
- **App** — `apps/web/src/app/**`, `apps/web/src/auth/**`, `apps/web/src/settings/**` (inkl. `sieve/`), `apps/web/src/pwa/**`, `apps/web/src/sw/sw.ts`, `apps/web/src/main.tsx`, `apps/web/index.html`, `apps/web/public/*`, `apps/web/vite.config.ts`
- **Lib** — `packages/jmap/src/**`, `packages/jscontact/src/**`, `packages/mail-html/src/**`
- **UI** — `apps/web/src/ui/**`, `apps/web/src/shortcuts/**`, `apps/web/src/notify/**`, `apps/web/src/i18n/**`, `apps/web/src/demo/**`, CSS-Tokens
- **Infra** — `e2e/**`, `scripts/**`, `.github/workflows/*.yml`, Root- und Paketkonfiguration, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/deployment.md`, `docs/configuration.md`, `docs/theming.md`

**Methodik:** 8 parallele Prüfdimensionen (mail, compose, pim, sync, app, lib, ui, infra), je Bereich ein
Agent; anschließend unabhängige adversariale Gegenprüfung jedes einzelnen Befunds — jede Fundstelle wurde
am Commit nachgelesen (Zeilennummern korrigiert, wo sie abwichen), und wo möglich wurde das Fehlverhalten
reproduziert (temporäre Vitest-Dateien unter Node 24, jsdom, fake-indexeddb, der Fake-Port und die
Fake-Lock-Queue der Sync-Suite, Node-Skripte gegen die gebauten Pakete, `git log -S`/`git show` für
Historienfragen, RFC-Texte lokal geladen). Befunde, deren Schadensbild sich in der Gegenprüfung nicht
halten ließ, wurden herabgestuft oder verworfen; die Korrekturen sind in den Einträgen eingearbeitet.
Baseline: `pnpm typecheck`, `pnpm lint`, `pnpm test` grün mit 336 Dateien / 5304 Tests unter Node 24.

**Abgrenzung zum Review vom 29.08.2026:** Das Vorgänger-Review
(`docs/reviews/2026-08-29-security-code-review.md`) hatte Security-Schwerpunkt; alle 40 Befunde
W-01…W-40 sind in `1eb3789..e78e32b` behoben. Dieses Review prüft Korrektheit, React-Semantik,
Robustheit gegen fehlerhafte Server und Umgebungen, Performance, a11y/i18n, Testqualität und
Betreiber-Dokumentation — und die Fix-Commits `1eb3789..e78e32b` auf Regressionen und unvollständige
Reste. Befunde, die einen Rest oder eine Regression zu einem W-Befund darstellen, tragen den Verweis im
Titel oder ersten Satz („vgl. W-xx“ bzw. „Regression aus W-xx“), so wie die Gegenprüfer sie eingeordnet
haben.

| Severity | Anzahl |
| --- | --- |
| critical | 0 |
| high | 6 |
| medium | 39 |
| low | 67 |
| **Summe** | **112** |

Ausgangsbasis waren 115 bestätigte Einzelbefunde aus den acht Bereichsberichten; drei Paare beschreiben
dieselbe Ursache aus zwei Bereichen und sind hier zu je einem Eintrag zusammengefasst (R-03 aus
COMP-02 + APP-02, R-21 aus PIM-11 + COMP-12, R-25 aus SYNC-01 + COMP-03; alle Fundstellen sind genannt).
Zwei Kandidaten wurden bereits in der Gegenprüfung verworfen (PIM-22 als Duplikat von SYNC-08, UI-08 als
unbegründet) und stehen nur im Anhang. Genau eine Regression aus den Fix-Commits ist belegt (R-05, W-18);
die übrigen W-Bezüge sind unvollständige Fixes oder neue Stellen bekannter Muster.

## Zusammenfassung

Die schwersten Befunde liegen in drei Ecken. Erstens im Composer: Der Plain-Text-Modus ist reiner
Editor-Zustand, kein Tastendruck erreicht den Store — gesendet, gespeichert und beim Schließen behalten
wird der HTML-Body von vor dem Umschalten, der getippte Text ist weg (R-02). Und der modulweite
Composer-Store überlebt den Sign-out: Entwürfe der vorherigen Person erscheinen beim nächsten Konto am
selben Tab und werden beim ersten Tab-Wechsel in dessen Server-Drafts geschrieben, auch im
Public-Computer-Modus (R-03). Zweitens im Kalender: Jede Bearbeitung eines Termins fremder Zeitzone
überschreibt dessen Zone mit der des Lesers und verschiebt ihn um Stunden (R-04); die Bearbeitung einer
einzelnen Occurrence friert `start`, `alerts` und `recurrenceRule` im Override ein (R-06); und der neue
W-18-Fenster-Reaper löscht ein beobachtetes Kalenderfenster samt Occurrences, das der Sweep nie
zurückholt — dauerhafter Spinner (R-05, die einzige belegte Regression aus PR #54). Drittens in der
Mailliste: Nach einem Ordnerwechsel ist das Nachladen tot, sobald der neue Ordner dieselbe Fensterlänge
hat wie der zuletzt gepagte — Mail 51+ ist nur über die Suche erreichbar (R-01).

Drei Themen ziehen sich durch mehrere Bereiche. (1) **Entwurfs-Lebenszyklus**: Aus fünf verschiedenen
Ursachen bleiben Geister- oder Doppelentwürfe im Server-Ordner — eingefrorene Server-Id beim Einreihen
während eines laufenden Autosaves (R-25), ein Discard, der den pendenten Autosave stehen lässt (R-29),
die Signatur, die jeden Entwurf „nicht leer“ macht (R-12), `close()` eines geleerten Entwurfs (R-15) und
der Re-Send nicht-idempotenter Creates nach verlorener Antwort (R-27). (2) **Stille Fehler**: Dispatches
ohne `catch` in Snooze und Labels (R-10, Rest von W-10), Anhänge, die offline stumm scheitern (R-11,
Rest von W-11), ein toter Retry für Kontakt-Dead-Letters (R-26), eine nie ausgewertete
`PushSubscription/set`-Antwort (R-41) und ein Polling-Kanal, der nach einem `TypeError` „open“ meldet
und nie wieder pollt (R-91). (3) **Reste der Fix-Commits**: W-10, W-11, W-13 (R-25, R-69), W-14 (R-70),
W-15 (R-28), W-16 (R-94), W-25 (R-91), W-28 (R-57) und W-05 (R-77, R-79) wurden jeweils nur an den im
alten Review genannten Stellen behoben, nicht an den gleichartigen daneben. Dazu kommen fehlende
IME-Guards in Empfängerfeld, Dialog und Palette (R-14, R-40), eigene Datumsarithmetik, die an DST-Tagen
falsch rechnet (R-16, R-17, R-62), Serverdaten, die ungeprüft in Render-Pfade laufen (R-09, R-57, R-92,
R-95), quadratisches Regex-Backtracking im Link-Trimmer (R-36) und Tests, die ihren Namen nicht
einlösen (R-38, R-44, R-76, R-93, R-104). Auf der Betreiberseite fehlen in den Reverse-Proxy-Rezepten
die OAuth-Pfade, womit der primäre „Sign in“-Button auf diesem Deployment-Pfad tot ist (R-45).

Gut gelöst ist die Architektur unter den Befunden: pure, DOM-freie Modelle mit gezielten Tests
(Selection-Reducer, Ordnerbaum, Search-Parser, Sieve-Round-Trip); das `list-store`-Anchoring per Id, das
ein Server-Delta während einer Auswahl nie zu falschen Aktionszielen führen lässt; das konsequente
Claim-Muster in der Outbox mit `rw`-Transaktion und Re-Read (plus W-32, das das in R-25 vorgeschlagene
Umschreiben gefahrlos macht) und ein Fake-Port samt Fake-Lock-Queue, mit dem sich jedes Outbox-Rennen in
Minuten deterministisch nachstellen lässt; ein Sanitizer, an dem 25 Bypass-Sonden scheiterten, und ein
Chunking, das die Nicht-Atomarität gesplitteter `/set`s korrekt merged; ein `AuthController` mit
Generation-Guard und Single-Flight; Workflows mit SHA-gepinnten Actions und fail-safe invertierte Regeln
in `.size-limit.js`; ein Locale-Gate mit `Intl.PluralRules`; und ehrliche Kommentare, ADRs und
Testbeschreibungen, die bekannte Grenzen benennen — der E2E-Offline-Tripwire ist das Musterbeispiel.

## Befunde

### R-01 — [HIGH] Infinite Scroll ist nach einem Ordnerwechsel tot, sobald der neue Ordner dieselbe Fensterlänge hat wie der zuletzt nachgeladene

**Status:** [x] erledigt
Stempel-Variante umgesetzt (`windowKey:ids.length`), zusammen mit R-51 in einem Commit: derselbe
Guard, und ohne die Freigabe bei einem gescheiterten Nachladen wäre der Fix nur halb wirksam.

**Kategorie / Bereich:** correctness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/MessageList.tsx:417` (`requestedAtRef = useRef(-1)`), `apps/web/src/mail/MessageList.tsx:418-428` (Effekt mit Guard `requestedAtRef.current !== ids.length`, nie zurückgesetzt)
- `apps/web/src/app/shell/MailScreen.tsx:371` (`<MessageList>` ohne `key`, bleibt beim Ordnerwechsel gemountet; `MessageList.tsx:112` sagt das selbst)
- `apps/web/src/sync/engine/backfill.ts:44` (`DEFAULT_LIMIT = 50`), `apps/web/src/sync/engine/delta.ts:78` (`DEFAULT_WINDOW_LIMIT = 50`), `apps/web/src/mail/use-message-list.ts:52` (`PAGE_SIZE = 50`), `apps/web/src/mail/use-message-list.ts:121-123` (`loadMore`)

**Problem:** Der Guard merkt sich nur die Fensterlänge, bei der zuletzt nachgeladen wurde. Ein Wechsel
des `windowKey` (Ordner, Sortierung, Suche) setzt ihn nicht zurück. Nach dem ersten Nachladen in
irgendeinem Ordner steht `requestedAtRef.current = 50`; jeder danach geöffnete, noch nicht gepagte
Ordner mit > 50 Nachrichten hat `ids.length === 50` und kommt am Guard nicht vorbei. Die Sperre löst
sich erst, wenn irgendein Ordner bei einer anderen Länge nachlädt (z. B. der Posteingang bei 100), dann
ist umgekehrt jeder Ordner mit genau dieser Länge gesperrt. Deterministisch: jeder frische Ordner
beginnt bei 50.

**Auswirkung:** Posteingang öffnen, ans Ende scrollen (lädt nach, Ref = 50), „Archiv“ (300 Nachrichten)
öffnen, ans Ende scrollen: nichts wird nachgeladen, die Liste endet nach 50 Zeilen ohne Hinweis,
`aria-rowcount` behauptet 300. Mail 51+ ist nur über die Suche erreichbar. Tritt in normaler Nutzung mit
mehreren Ordnern > 50 Mails ständig auf.

**Lösungsansatz:** Guard an das Fenster binden statt an die Länge allein:
```ts
const requestedAtRef = useRef('')
// …
const stamp = `${windowKey}:${ids.length}`
if (… && requestedAtRef.current !== stamp) { requestedAtRef.current = stamp; loadMore() }
```
`windowKey` ist in `MessageList` bereits im Scope (`:181`). Die Alternative (`useEffect(() => {
requestedAtRef.current = -1 }, [windowKey])` vor dem Lade-Effekt) hängt an der Effekt-Reihenfolge; die
Stempel-Variante vorziehen. Zusätzlich den Stempel freigeben, wenn das `loadMore`-Promise ohne
Fensterwachstum settled (R-51). Regressionstest: zwei Ordner à 20/100 nacheinander per `rerender`
öffnen, `loadMoreFor` muss für beide Keys gerufen werden.

**Aufwand:** S

**Verifikation:** Probe wiederholt (`zz-verify-list.test.tsx`, „MAIL-01“): Inbox 20/100 lädt nach,
`rerender` auf Archiv 20/100 → `loadMoreFor`-Aufrufe nach dem Wechsel `[]`, Gegenkontrolle mit 21/100
lädt. Bestehende Tests (`MessageList.test.tsx:586-605`) prüfen nur, dass ein zurückgezogenes Fenster
NICHT pagt; der Guard über Fenstergrenzen hinweg ist ungetestet. Gegenprüfung: bestätigt, Severity
unverändert.

(Quelle: MAIL-01)

### R-02 — [HIGH] Im Plain-Text-Modus erreicht kein Tastendruck den Store: Senden, Autosave und Schließen verwenden den alten Rich-Text-Body

**Status:** [x] erledigt
Variante (b) umgesetzt: `plainText` liegt jetzt in `DraftWindow`/`SerializedDraft`, `RichTextEditor` ist
darauf kontrolliert, und `toEmailCreate` sendet bei gesetztem Flag nur den `text/plain`-Teil. Zusätzlich
ist `updateBody` bei identischem Body ein No-op — der Moduswechsel emittiert, und das hätte sonst jeden
Wechsel als Tastendruck gezählt.

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/RichTextEditor.tsx:308-317` (Textarea-`onChange` → nur `setPlainValue` + `onPlainTextChange?.()`)
- `apps/web/src/compose/RichTextEditor.tsx:219-230` (`flush()` ohne Engine = No-op), `apps/web/src/compose/RichTextEditor.tsx:115-160` (Engine nur im Rich-Modus)
- `apps/web/src/compose/RichTextEditor.tsx:282-296` (`togglePlainText`: Emission erst beim Zurückschalten; Seiteneffekte im `setMode`-Updater)
- `apps/web/src/compose/ComposerWindow.tsx:514-522` (keine `plainText`-/`onPlainTextChange`-Prop), `apps/web/src/compose/ComposerWindow.tsx:273-287` (`requestSend` = `flush()` + Store lesen)
- `apps/web/src/compose/RichTextEditor.test.tsx:175-185` (einziger Plain-Test prüft nur das Seeding der Textarea, nicht die Emission; die Suite ist mit dem Fehler grün)

**Problem:** Der Plain-Text-Modus ist reiner Editor-Zustand. `draft.body` im Store bleibt der HTML-Stand
vom Moment des Umschaltens (genauer: der zuletzt debounced emittierte Stand). Weder `flush()` noch die
Autosave-Subscription (kein Store-Write → kein `arm`) noch `close()` sehen den getippten Text.
`onPlainTextChange` hat außerhalb der Tests keinen Aufrufer; einen zweiten Weg in den Store gibt es nicht
(grep `plainText|onPlainTextChange|togglePlainText`: kein `useEffect`, kein Umschalten beim Senden;
erst `togglePlainText` zurück nach Rich emittiert). Da der Modus nicht im Store liegt, sendet
`toEmailCreate` zudem immer `multipart/alternative` mit HTML — „plain-text-only“ (FR-CMP-01) existiert
nur optisch.

**Auswirkung:** „Plain text“ klicken, Nachricht schreiben, Senden (Button oder ⌘Enter): versendet wird
der Body von *vor* dem Umschalten — bei einer neuen Nachricht die leere Signatur, bei einer Antwort nur
das Zitat. Der Text ist weg (Fenster geschlossen; Undo bringt den alten Body zurück). Gleiches beim
Schließen (Draft ohne Text) und bei Tab-Crash (Autosave hat nie gefeuert).

**Lösungsansatz:** (a) Minimal: `ComposerWindow` übergibt `onPlainTextChange`, der — wie der Rich-Pfad
mit 200 ms — debounced `updateBody(draft.id, plainTextToHtml(text))` ruft, und `flush()` emittiert im
Plain-Modus `plainTextToHtml(plainValue)` sofort. (b) Sauber: `plainText: boolean` in
`DraftWindow`/`SerializedDraft`, `RichTextEditor` kontrolliert (`plainText`-Prop + `onPlainTextToggle`),
`toEmailCreate` emittiert bei `plainText` nur `textBody`. In beiden Fällen die Seiteneffekte aus dem
`setMode`-Updater ziehen (Updater laufen unter StrictMode doppelt; hier idempotent, aber ein Muster, das
beim nächsten Umbau bricht). Test: `RichTextEditor.test.tsx` um „Plain-Tastendruck → `onChange`“ und
„`flush()` im Plain-Modus emittiert“ ergänzen.

**Aufwand:** M

**Verifikation:** Reproduktion (Editor mit `onChange`-Spy, „Plain text“ geklickt, Textarea auf
`old NEW TEXT`, `ref.flush()`): `onChange` nie aufgerufen. Gegenprüfung: bestätigt, Kette und grep nach
zweitem Pfad negativ.

(Quelle: COMP-01)

### R-03 — [HIGH] Composer-Store, Upload-Registry und Inline-Bild-Registry überleben den Sign-out: Entwürfe des vorherigen Kontos erscheinen in der nächsten Sitzung und werden per Autosave in dessen Server-Drafts geschrieben

**Status:** [x] erledigt
Umgesetzt wie vorgeschlagen. Der Flush wird ABSICHTLICH vor `goToLogin` gestartet (danach ist der
`ReplicaProvider` weg und `flushActiveDraft` ein No-op) und im Teardown mit 1-s-Deadline abgewartet,
bevor `resetComposer()` den Store leert. Abdeckung ergänzt: Unit in `SessionProvider.test.tsx` für
BEIDE Modi plus ein E2E in `public-computer.spec.ts` (Entwurf überlebt den Sign-out nicht in die
nächste Sitzung).

**Kategorie / Bereich:** security, correctness / Compose + App (Session)

**Fundstelle(n):**
- `apps/web/src/compose/composer-store.ts:142` (modulweiter Zustand-Store; Aufrufer außerhalb `compose/`: `openDraft` in `shortcuts/use-shortcut-context.ts:144`, `mail/MessageView.tsx:197`, `app/shell/use-mailto-handler.ts:48-52`, `pwa/use-update-prompt.ts:78`)
- `apps/web/src/compose/ComposerHost.tsx:66-77` (Unmount mit offenen Entwürfen wird ausdrücklich als „shell being torn down (sign-out, a remount)“ behandelt — und bewusst nichts getan)
- `apps/web/src/app/shell/AppShell.tsx:54`, `apps/web/src/app/shell/AppShell.tsx:198-202` (`hasDrafts`-Gate mountet den `ComposerHost` in der nächsten Sitzung sofort wieder)
- `apps/web/src/app/session/SessionProvider.tsx:635-769` (`endSession`: ruft `resetStorageFull`, `resetDispatchFailure`, `resetMailScopedStores` (`:728`), `useActiveAccountStore.reset` (`:731`), `resetReplica`, `reloadAccountRegistry` — keinen Composer-Reset, keinen Flush; kein `location.reload()` auf diesem Pfad)
- `apps/web/src/mail/active-account.ts:99-103` (`resetMailScopedStores`: nur List-, Reading-, Palette-Store)
- `apps/web/src/compose/use-draft-autosave.ts:50-56` (`visibilitychange` flusht *jeden* Entwurf), `apps/web/src/compose/use-draft-sync.ts:141-177`, `:230` (`flushDraft(db, accountId, …)` mit der `accountId` des *aktuellen* Providers: `putDraft` durable + `saveDraft`-Dispatch)
- `apps/web/src/compose/use-attachment-upload.ts:83` (`pending`-Map mit `File`-Objekten), `apps/web/src/compose/inline-image-registry.ts:9` (Blob-URLs) — modulweit, nur je Entwurf bei Discard/Cancel geleert
- `apps/web/src/app/shell/AccountMenu.tsx:61`, `:70` („Wechseln zu …“ und „Konto hinzufügen“ rufen `signOut()`)

**Problem:** Nach Sign-out bleibt jeder offene Entwurf (Empfänger, Betreff, Body, Anhangsreferenzen,
gepastete Bilder als Blob-URL) im Speicher; ein `resetAllStores` existiert nicht, ein React-`key`-Wechsel
wäre für den modulweiten Store wirkungslos. Meldet sich am selben Tab ein anderes Konto an
(Public-Computer-Modus FR-AUTH-09, „Konto hinzufügen“, oder ein zweites Konto per Registry), rendert
`AppShell` die Fenster sofort; der nächste Tab-Wechsel oder Tastendruck flusht sie unter der *neuen*
`accountId` in die Replica und dispatcht `saveDraft` an die Engine des neuen Kontos
(`getEngineFor('b')`, `engine.ts:1942-1947`) → `Email/set` in den Drafts-Ordner des fremden Postfachs.
Der `fromIdentityId` von A findet im Konto B keine Identität → `from: null`, der Save läuft trotzdem.
Zusätzlich gehen A die letzten ≤ 3 s Eingaben vor dem Sign-out verloren, weil `endSession` nicht flusht.
Beide Berichte beschreiben denselben Defekt: der Compose-Bericht ergänzt Upload- und
Inline-Bild-Registry, der App-Bericht den Bedienpfad über das Account-Menü und den fehlenden Flush.
Kein Duplikat und keine Regression zu W-05/W-23 (die betreffen `localStorage` bzw. die Wipe-Reihenfolge
im Controller); es ist das Muster, das `endSession` für den Listen-Store selbst beschreibt und behebt
(`SessionProvider.tsx:721-728`), an einer dort fehlenden Stelle.

**Auswirkung:** Alice schreibt auf einem geteilten Rechner eine vertrauliche Mail, meldet sich ab (auch
„Abmelden & Daten entfernen“ — der Wipe trifft IndexedDB, nicht den Speicher). Bob meldet sich an, sieht
Alices Entwurf als Fenster; nach dem ersten Tab-Wechsel liegt er in Bobs Drafts-Ordner auf dem Server.
Bei einer Person mit zwei Konten: ein Entwurf im falschen Postfach. Kein Test (unit oder e2e) deckt
Sign-out mit offenen Entwürfen ab.

**Lösungsansatz:** In `compose/` eine `resetComposer()` exportieren (Store leeren, alle
`pending`-Uploads abbrechen, `revokeInlineObjectUrls` für alle Cids) und in `endSession` **vor**
`goToLogin` aufrufen — davor offene Drafts mit Deadline flushen (`flushOpenDrafts`-Muster aus
`pwa/use-update-prompt.ts:74`, `flushActiveDraft` ist der vorhandene Seam). Der Aufruf gehört neben
`resetMailScopedStores()` (dann greift er auch beim Account-Switch); dort dokumentieren, warum der
Composer beim M4.4-Kontowechsel *nicht* geleert wird (bleibt bewusst am Primärkonto). Test:
`SessionProvider.test.tsx:288` („resets the module-scoped keyboard state on sign-out“) um
„Composer-Store leer, keine `pending`-Uploads“ erweitern — in beiden Modi (durable und
Public-Computer).

**Aufwand:** S–M

**Verifikation:** Zwei unabhängige Reproduktionen: (1) Entwurf mit Betreff/Empfänger von A im Store,
`useDraftAutosave` unter `ReplicaProvider accountId="b"`, `visibilitychange` (hidden) → `drafts`-Zeile
`['b', id]` mit A-Inhalt, `dispatch({kind:'saveDraft', localId})`; (2) Basic-Login,
`openDraft({subject:'private to alice'})`, `signOut()` → `drafts.size === 1`, Login als `bob` → Store
enthält weiterhin `['private to alice']`; identisch im Public-Computer-Modus. Gegenprüfung beider
Berichte: bestätigt, Severity high.

(Quelle: COMP-02, APP-02)

### R-04 — [HIGH] Jede Bearbeitung eines zeitgebundenen Termins überschreibt dessen Zeitzone mit der des Lesers und verschiebt ihn dadurch um Stunden

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/EventDialog.tsx:203-205` (`timeZone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone` — unabhängig davon, ob ein bestehender Termin bearbeitet wird; der Kommentar denkt nur an „neuer Termin“)
- `apps/web/src/calendar/EventDialog.tsx:145-147` (`start` wird 1:1 aus `existing.start` übernommen — die Wanduhrzeit der *gespeicherten* Zone, ohne Zonenhinweis im Dialog)
- `apps/web/src/calendar/calendar-client.ts:426` (`draftToEvent`: `timeZone: draft.allDay ? null : draft.timeZone`, in jedem Update-Patch)
- `apps/web/src/calendar/event-recurrence.ts:273-284` (`overrideFromDraft` schreibt eine abweichende Zone auch in den Override einer Occurrence)

**Problem:** Der Dialog zeigt `start` als Wanduhrzeit des Termins in dessen Zone (10:00), während das
Raster denselben Termin korrekt bei 16:00 Berlin zeichnet (`placeEvent` → `localToInstant(start,
timeZone)`). Beim Speichern schreibt er die Browserzone zurück: `10:00 America/New_York` wird zu
`10:00 Europe/Berlin`, sechs Stunden früher. Es gibt keinen Pfad, der die gespeicherte Zone bewahrt: der
Dialog hält `timeZone` in keinem State, `draftToEvent` schreibt sie bei jedem Update. Kein ADR deckt
das; RFC 8984 §4.7.1 / jscalendarbis §3.6.1 definieren `timeZone` als optional. Der RSVP-Pfad
(`rsvpPatch`, `calendar-client.ts:915-921`) ist nicht betroffen — nur eine echte Bearbeitung (Titel,
Beschreibung, Erinnerung, Dauer).

**Auswirkung:** Einladung eines Kollegen aus einer anderen Zone, auf Reisen angelegter Termin, Termin aus
einem geteilten Kalender → Erinnerung oder Titel ändern → Speichern → der Termin rutscht stillschweigend
um die Zonendifferenz; für Teilnehmer der Einladung kostet das Zeit (ADR-025 nennt genau das als teuerste
Fehlerklasse). Der Zonenhinweis in der Agenda (`CalendarPage.tsx:1474`, `zoneDiffersFromLocal`)
verschwindet danach, weil die Zone jetzt „stimmt“.

**Lösungsansatz:** Kleinste Änderung: `timeZone` im Dialog aus `existing?.timeZone ?? readerZone`
initialisieren (`useState`) und durchreichen; bei abweichender Zone neben dem Datumsfeld anzeigen
(`zoneDiffersFromLocal` existiert). Alternative mit gleicher Wirkung auf dem Wire: `draftToEvent`
`timeZone` nur senden, wenn der Draft sie ausdrücklich setzt (`undefined` = unangetastet, wie
`alerts`/`repeat`) — dann bleibt bei jedem Update die gespeicherte Zone. Ein Zonen-Picker ist ein eigenes
Feature.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt (`zz-verify-pim-dialog.test.tsx`, `TZ=Europe/Berlin`): Termin
mit `timeZone: 'America/New_York'`, Titel ergänzt, Save → Draft `start: '2026-08-20T10:00:00'`,
`timeZone: 'Europe/Berlin'`. `calendar-write.test.ts:105` prüft nur, dass die Draft-Zone durchgereicht
wird; kein bestehender Test bearbeitet einen Termin fremder Zone. Gegenprüfung: bestätigt.

(Quelle: PIM-01)

### R-05 — [HIGH] Regression aus W-18: Der Fenster-Reaper löscht das beobachtete Kalenderfenster samt Occurrences, und der Engine-Sweep holt es nie zurück

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender) — Fixstellen in Sync (`maintenance.ts`, `engine.ts`)

**Fundstelle(n):**
- `apps/web/src/sync/engine/maintenance.ts:277-290` (Kalender-/Kontaktfenster mit `EMPTY_WATCHED` gereapt; Kommentar Z. 278-280 behauptet, beide stempelten `lastUsedAt` „on every read of the view that draws them“ — für Kalender falsch, für Kontakte richtig)
- `apps/web/src/sync/engine/maintenance.ts:292-307` (1c: alle `occurrence: true`-Zeilen ohne überlebendes Fenster werden gelöscht)
- `apps/web/src/sync/engine/delta.ts:939` (einziger regulärer Schreiber von `lastUsedAt` eines Kalenderfensters, `fullRequeryCalendar`), `apps/web/src/sync/engine/delta.ts:885-886` (`reconcileCalendarQuery`: nicht stale → Return, kein Stempel)
- `apps/web/src/sync/engine/engine.ts:880-883` (`backfillCalendarQueryIfAbsent`: vorhandenes Fenster → sofortiges Return), `apps/web/src/sync/engine/engine.ts:899` (leerer Offline-Platzhalter, zweiter Schreiber), `apps/web/src/sync/engine/engine.ts:1834` (`reconcileWatchedCalendars`: `if (!row) continue` — vor dem `reconcileCalendarQuery`, also auch im `forceFull`-Sweep), `apps/web/src/sync/engine/engine.ts:162`, `:1352-1353` (`FULL_SWEEP_EVERY = 5`), `:1034` (Maintenance höchstens alle 5 min, beim ersten Pass nach Leader-Übernahme immer), `:1546`
- `apps/web/src/sync/engine/eviction.ts:45`, `:253-261` (`QUERY_WINDOW_TTL_MS` = 2 Tage)
- `apps/web/src/sync/react.tsx:313` (fehlende Zeile → `null`), `apps/web/src/calendar/use-calendar-events.ts:113-116`, `apps/web/src/calendar/CalendarPage.tsx:996-999` (`null` → `events: undefined` → Spinner)

**Problem:** Ein Kalenderfenster, dessen `lastUsedAt` älter als 48 h ist, wird vom Reaper gelöscht —
auch wenn es gerade beobachtet wird — mitsamt der Occurrences, die nur dieses Fenster nennt. Danach
überspringt `reconcileWatchedCalendars` den Key für immer (`continue`), `backfillCalendarQueryIfAbsent`
läuft nur beim `watch`, und der Key ändert sich nicht. `grep -rn lastUsedAt apps/web/src/sync` zeigt für
`calendarQueryCache` genau zwei Schreiber (`delta.ts:939`, `engine.ts:899`); weder `watchCalendarQuery`
noch `backfillCalendarQueryIfAbsent` noch `reconcileCalendarQuery` stempeln. Regression: der gesamte
Reap-Block 1b/1c ist im Diff `1eb3789..e78e32b` neu; `git show 1eb3789:…/maintenance.ts | grep -i
calendar` ist leer — vor dem W-18-Fix wurde kein Kalenderfenster gereapt, ein beliebig alter Monat
renderte aus der Replica. Kein Duplikat von R-72/R-73 (SYNC-08/-09): derselbe Block, andere Defekte.

**Auswirkung:** Die Gegenprüfung hat das Szenario eingegrenzt: In einem aktiven Leader-Tab
re-materialisiert jeder fünfte Sweep (≈ alle 5 min) das Fenster und stempelt es, ein offener Kalender
altert also nicht. Der Fehler trifft, wenn der Kalender **während** eines Wartungspasses beobachtet wird
und das Fenster > 48 h alt ist, ohne dass ein Delta es `stale` markiert hat: (a) Browser-/PWA-Restore
oder Reload direkt auf der Kalenderroute nach ≥ 48 h ohne Änderung in diesem Monat (Wochenende) — der
erste Pass nach Leader-Übernahme wartet immer, `watch` ist beim Mount längst registriert; (b) Gerät im
Ruhezustand mit offenem Kalender-Tab (Freitag zu, Montag auf: der nächste Sweep ist mit
Wahrscheinlichkeit 4/5 kein `forceFull`, die Wartung läuft); (c) Kalender in einem Follower-Tab, dessen
Fenster der Leader nach 48 h reapt (die `watched*`-Sets sind pro Tab). Ergebnis: der Monat wird aus der
Replica gezeichnet und kippt vor den Augen der Leserin in einen **dauerhaften Spinner**; erst ein
Monatswechsel hin und zurück (unwatch/watch → Backfill) oder ein Reload materialisiert neu. Startet die
App auf einer anderen Route, reapt der erste Pass das Fenster, bevor der Kalender es beobachtet, und der
Backfill heilt es — daher zeitabhängig und schwer zu melden.

**Lösungsansatz:** (1) `runMaintenance` die beobachteten Kalender- und Kontakt-Keys mitgeben
(`watchedCalendars`/`watchedContacts` analog zu `this.watched`) und in `planWindowReap` ausnehmen — die
Semantik, die `watchedKeys` für Mail hat; (2) `lastUsedAt` bei `watchCalendarQuery` /
`backfillCalendarQueryIfAbsent` stempeln (`db.calendarQueryCache.update(key, { lastUsedAt })`), damit
ein kürzlich angesehener Monat den TTL überlebt (die 48 h stammen aus dem Mail-Suchfenster; ob sie für
Monate offline passen, ist eine Produktentscheidung, kein Bug); (3) `reconcileWatchedCalendars` bei
fehlender Zeile mit `forceFull` materialisieren statt `continue` — die Selbstheilung, die Mail über
`backfillQueryIfAbsent` hat. Kommentar `maintenance.ts:278-280` korrigieren. Regressionstest: „ein
beobachtetes Fenster überlebt den Reap“ in `maintenance.test.ts` (dort wird bei `:607` nur ein
*unbeobachtetes* Fenster geprüft). Zusammen mit R-72 und R-73 angehen, die denselben Block ändern.

**Aufwand:** M

**Verifikation:** Reproduktion wiederholt (`zz-verify-pim-maint.test.ts`, Engine-Harness mit
virtueller Uhr): Fenster beobachtet und materialisiert; +2 d +1 min; ein Pass → `window REAPED,
occurrence REAPED`; nächster Sweep → `window STILL ABSENT, materializations since: 0`. Gegenprüfung:
bestätigt (Szenario präzisiert), Regression durch Diff gegen `1eb3789` belegt.

(Quelle: PIM-02)

### R-06 — [HIGH] Die Bearbeitung einer einzelnen Occurrence schreibt `start`, `alerts` und `recurrenceRule` in den Override, obwohl die Leserin nur den Titel geändert hat

**Status:** [ ] offen

**Kategorie / Bereich:** correctness, tests / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/calendar-client.ts:852-863` (Master wird mit Signatur-Properties + `description`, `timeZone`, `alerts` gelesen — ohne `recurrenceRule`)
- `apps/web/src/calendar/calendar-client.ts:875-879` (`overrideFromDraft(master, draftToEvent(draft, master))`)
- `apps/web/src/calendar/event-recurrence.ts:273-284` (`overrideFromDraft` vergleicht jeden Draft-Member mit dem **Master**), `apps/web/src/calendar/event-recurrence.ts:297-304` (`sameAsMaster`: `JSON.stringify`-Vergleich, schlüsselreihenfolge-sensitiv; Sonderfall nur `duration`)
- `apps/web/src/calendar/EventDialog.tsx:206-209` (`alerts` und `repeat` stehen in **jedem** Draft), `apps/web/src/calendar/event-alerts.ts:181-203` (`alertsToPatch` vergibt neue Keys `w1…`), `apps/web/src/calendar/event-recurrence.ts:149-160` (`ruleToWrite` ergänzt `until: null, count: null` — weicht vom gespeicherten Master ab)
- `apps/web/src/calendar/event-recurrence.test.ts:227-249` (Test prüft einen handgebauten Patch mit Master-Titel und verschobenem `start`, nie den Draft, den `EventDialog` erzeugt — grün trotz defektem Pfad)

**Problem:** (a) `start` — der Draft trägt den Start der Occurrence (14.9. 09:00), der Master den der
ersten Instanz (7.9. 09:00); der Vergleich müsste gegen den aus `recurrenceId` abgeleiteten Start gehen.
(b) `alerts` — Alarme unter Server-Keys (`a1`) werden unter `w1` neu geschrieben; selbst bei gleichem Key
kippt die Member-Reihenfolge den `JSON.stringify`-Vergleich. (c) `recurrenceRule` — Master ohne Regel
gelesen bzw. Regel mit anderen Membern (`until/count: null`); im Override laut Spec zu ignorieren
(jscalendarbis-18 §3.3.4 „MUST be ignored“), also toter Ballast, keine Ablehnung — die
Ablehnungshypothese des Erstberichts bleibt unbelegt, der Befund wird dadurch nicht schwerer. RFC 8984
§4.3.5 erlaubt `start` im Override ausdrücklich; das Problem ist, dass er *unverändert* geschrieben wird.

**Auswirkung:** Genau der Fehler, den der Kommentar `event-recurrence.ts:263-268` verhindern will: die
Occurrence wird gegen spätere Serienänderungen eingefroren. „Serie eine Stunde später legen“ lässt jede
einmal umbenannte Occurrence bei 09:00 zurück; „Erinnerung der Serie ändern“ erreicht sie nicht mehr.
Unsichtbar am Tag der Bearbeitung, sichtbar Wochen später.

**Lösungsansatz:** In `updateOccurrence` den Master ohne `properties` (oder mit `recurrenceRule`,
`alerts`, `participants`, `locations`) lesen; `overrideFromDraft` eine Sperrliste geben
(`recurrenceRule`, `recurrenceRules`, `recurrenceOverrides`, `method`, `uid`, `recurrenceId`, `relatedTo`
— die Liste aus jscalendarbis §3.3.4) und `start` gegen den Start der Occurrence (`recurrenceId` bzw.
Master-Start mit Occurrence-Datum) vergleichen; `sameAsMaster` reihenfolge-unabhängig (`deepEqual`
existiert in `contact-card-mapping.ts`); `alerts` nach Offset statt Key vergleichen. Test:
„Titeländerung an Occurrence 2 mit dem Draft des Dialogs erzeugt Override mit genau `title`“.

**Aufwand:** M

**Verifikation:** Reproduktion wiederholt (`zz-verify-pim-calendar.test.ts`, `TZ=Europe/Berlin` und
`TZ=America/New_York`): für einen Master mit Alarm `a1` und wöchentlicher Regel liefert
`overrideFromDraft(master, draftToEvent(dialogDraft, master))` die Member
`['title','start','alerts','recurrenceRule']`, mit vollständig wie mit „lean“ gelesenem Master.
Gegenprüfung: bestätigt, Spec-Abgleich ergänzt.

(Quelle: PIM-03)

### R-07 — [MEDIUM] Das Kontextmenü bietet Archivieren und Papierkorb an, wo die Aktion nichts tut, und kein „Löschen“ im Papierkorb

**Status:** [x] erledigt
Wie vorgeschlagen umgesetzt (Archive- und Trash-Arm nach dem Muster des Junk-Arms, im Papierkorb
stattdessen „Endgültig löschen" über `requestDestroy`). Abweichung: `archiveId`/`trashId` kommen aus
der bereits vorhandenen `useMailboxes()`-Abfrage derselben Komponente statt aus zusätzlichen
`useMailboxByRole`-Aufrufen — genau der Grund, aus dem B24 den Junk-Arm dort abgreift: zwei weitere
liveQueries könnten auf einem anderen Tick auflösen als die, gegen die die Swipe-Ziele entschieden
werden. Der Delete-Arm prüft `reason('destroy')`, nicht `removeReason`: Zerstören quantifiziert über
alle Postfächer der Nachricht, nicht über den betrachteten Ordner.

**Kategorie / Bereich:** correctness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/MessageList.tsx:650-657` (Eintrag `archive` — nur an `removeReason` gebunden, nicht an `archiveId`/Quellordner)
- `apps/web/src/mail/MessageList.tsx:694-700` (Eintrag `trash` — im Papierkorb ein Selbst-Move; kein `requestDestroy`-Eintrag)
- Kontrast: `apps/web/src/mail/MessageList.tsx:667-687` (Junk-Arm, `junkId !== undefined && junkId === sourceMailboxId`), `apps/web/src/mail/use-triage.ts:116` (`moveWithUndo` weist `to === from` und `to === undefined` mit `false` ab, ohne Toast), Bulk-Bar `MessageList.tsx:1509-1514` (`canMoveTo(archive?.id)`), `:1551-1569` (Delete-Swap `inTrash`), Reading-Pane `apps/web/src/mail/MessageView.tsx:826` (`disabled: archiveBox === undefined || inArchive`)

**Problem:** Die Menü-Regel ist „omit, never dim“ (`:612-616`). Für `archive` und `trash` fehlt das
Gate, das Bulk-Bar und Reading-Pane anwenden. Konto ohne Archive-Rolle → „Archivieren“ wird angeboten;
im Archiv → „Archivieren“; im Papierkorb → „In den Papierkorb“, und „Endgültig löschen“ (das Bulk-Bar
und `#` dort anbieten) fehlt. `useTriage` weist alle drei Fälle mit `false` ab — ohne Dispatch, Toast,
Undo. Der bestehende Test `MessageList.test.tsx` (~2417, „offers no junk entry at all…“) pinnt nur das
Junk-Gate.

**Auswirkung:** Rechtsklick im Papierkorb → „In den Papierkorb“ → nichts passiert, keine Rückmeldung.
Dasselbe Fehlerbild, das B24 für Junk bereits geschlossen hat.

**Lösungsansatz:** Die Einträge wie den Junk-Arm bauen: `archive` nur wenn `archiveId !== undefined &&
archiveId !== sourceMailboxId`; `trash` nur wenn `trashId !== undefined && trashId !== sourceMailboxId`,
bei `trashId === sourceMailboxId` stattdessen `{ id: 'delete', label: t('list.actions.delete'),
destructive: true, onSelect: () => requestDestroy(target) }` (Verzweigung wie `BulkBar`, `:1551`).
`archiveId`/`trashId` per `useMailboxByRole` holen, wie `junkId`. Die drei Probenfälle als
Regressionstests übernehmen.

**Aufwand:** S

**Verifikation:** Drei Proben wiederholt (`zz-verify-list.test.tsx`, „MAIL-02“: im Archiv, im
Papierkorb, ohne Archive-Rolle): Eintrag vorhanden, Klick → kein `dispatch`, kein Undo-Toast; im
Papierkorb kein „Delete“. Gegenprüfung: bestätigt.

(Quelle: MAIL-02)

### R-08 — [MEDIUM] „Alle auswählen“ wählt nur das geladene 50er-Fenster, zeigt die Kopf-Checkbox aber als vollständig gesetzt — Bulk-Aktionen erfassen den Rest des Ordners nicht

**Status:** [x] erledigt — Stufe 1
Stufe 1 (ehrliche Oberfläche) ist umgesetzt: `allSelected` verlangt zusätzlich, dass das Fenster die
ganze Trefferliste ist, sonst zeigt die Kopf-Checkbox `indeterminate` und der Zähler den neuen Key
`list.selectedOfTotal` („20 von 300 ausgewählt", 14 Bundles). Kommentar in `message-selection.ts`,
Plan-Zeilen 165/973 und der Perf-Test sind korrigiert; der Perf-Test prüft jetzt beide Zahlen statt
`/\d+ selected/`. Zwei Ergänzungen über den Lösungsansatz hinaus: der Klick auf die Kopf-Checkbox
wird aus dem Zustand statt aus `event.target.checked` entschieden (eine `indeterminate`-Box meldet
beim Klick `checked: true` und hätte nur erneut alles ausgewählt, statt zu leeren), und `Checkbox`
spiegelt `indeterminate` jetzt nach jedem Commit statt nur bei Änderung des Props — ein nativer Klick
löscht die Eigenschaft, und bis hierher blieb kein Aufrufer über einen Klick hinweg gemischt.

**Stufe 2 bleibt offen:** „Alle {{total}} auswählen" über alle Treffer (FR-LST-04 Must). Als
Backlog-Eintrag in `docs/implementation-plan.md` §11 aufgenommen, mit dem Paginierer
(`collectMatchingIds`) und der Account-Floor-Klausel als benanntem Ausgangspunkt.

**Kategorie / Bereich:** correctness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/MessageList.tsx:546-551` (Ctrl/⌘+A mit `ordered: ids`), `:815` (Bulk-Bar „Select all“), `:721-722` (`allSelected = selection.selected.size === ids.length`), `:1659-1663` (Checkbox `checked={allSelected}`)
- `apps/web/src/mail/use-message-list.ts:120-131` (`ids` = `queryCache`-Fenster), `apps/web/src/sync/engine/backfill.ts:44` und `apps/web/src/sync/engine/delta.ts:78` (Fenster startet bei 50, wächst nur durch `loadMore`)
- `apps/web/src/mail/message-selection.ts:1-5` (Kopfkommentar „FULL ordered id-set of the query (not just the loaded/visible rows)“), `:63-66` (`selectAll`)
- Anspruch: `docs/functional-specification.md:193` (FR-LST-04 Must „select-all-in-folder“), `docs/implementation-plan.md:973` („id-set on the query, not just loaded rows“), `docs/implementation-plan.md:165` („select-all over 100 000 **9 ms**“ — gemessen wurde ein 50er-Fenster), `e2e/tests/perf-large.spec.ts:119-139` (prüft nur `/\d+ selected/`)

**Problem:** Das „query id-set“ ist das geladene Fenster (50 Ids plus gepagte Seiten), nicht der Ordner.
`allSelected` vergleicht gegen `ids.length`, nicht gegen `total`; die Kopf-Checkbox erscheint
vollständig gesetzt, der Zähler sagt „50 selected“, `aria-rowcount` daneben 300. Spec, Plan, Kommentar
und der Titel des Perf-Tests beschreiben ein Verhalten, das der Code nicht hat. Die Gegenprüfung hat
zusätzlich die Delta-Frage geprüft: eine während der Auswahl eintreffende Id wird NICHT mitselektiert,
die Checkbox wird `indeterminate`, Archive trifft weiterhin exakt die 20; eine entfernte Id wird aus der
Selektion geprunt (`list-store.ts:114-126`). Aktionen haben also nie falsche Ziele — der Defekt ist die
falsche „alles“-Anzeige plus die unerfüllte Must-Anforderung.

**Auswirkung:** Ordner mit 300 Mails → „Alle auswählen“ → „Archivieren“: 50 werden archiviert, 250
bleiben, die Kopf-Checkbox hatte „alles“ signalisiert. Kein falsches Ziel, aber ein falsches Versprechen;
Abweichung von FR-LST-04 (Must).

**Lösungsansatz:** Zwei Stufen. (1) Ehrliche UI sofort: `allSelected` nur wenn zusätzlich
`total === undefined || ids.length >= total`; sonst `indeterminate` und Zähler „50 von 300 ausgewählt“
(neuer Key in 14 Locales); Kommentar in `message-selection.ts`, Plan-Zeilen 165/973 und den Perf-Test
(Zahl prüfen) korrigieren. (2) FR-LST-04 erfüllen: nach Select-all über ein unvollständiges Fenster eine
Schaltfläche „Alle {{total}} auswählen“ in der Bulk-Bar (Gmail-Muster), die die restlichen Ids per
`Email/query` (nur Ids, `limit`-Chunks — `collectMatchingIds` in der Engine ist der vorhandene
Paginierer) in die Selektion holt; `rights.ts:222-228` (Account-Floor-Klausel) ist dafür vorbereitet.

**Aufwand:** S für (1), M für (2)

**Verifikation:** `zz-verify-selectall.test.tsx`, drei Tests (Grundfall 20 von 100: „20 selected“,
`checked === true`, `indeterminate === false`, Archive dispatcht genau 20; Delta mit neuer Id; Delta
mit Entfernung): alle grün. Gegenprüfung: bestätigt, Severity bleibt medium.

(Quelle: MAIL-04)

### R-09 — [MEDIUM] Ein ungültiges `receivedAt` vom Server wirft beim Rendern und reißt Liste und Lesebereich in die Error-Boundary — dauerhaft, weil die Zeile in der Replica liegt

**Status:** [x] erledigt
Beide vorgeschlagenen Teile umgesetzt und beide Fehlerklassen behandelt — nachgeprüft: `undefined`,
`''`, Nicht-ISO und außerhalb des Bereichs werfen; `null` und blanke Zahlen werden still zur Epoche.
`parseReceivedAt` (in `mail/format-message-time.ts`) weist beide zurück und ist die eine Definition,
die auch `toEmailRow` benutzt — statt der im Lösungsansatz vorgeschlagenen zweiten Prüfung inline in
`db.ts`, die mit der Anzeige hätte auseinanderlaufen können. Abweichung beim Fallback an der Grenze:
`''` statt `new Date(0).toISOString()` — Letzteres wäre genau das stille „1. Januar 1970", das der
Befund benennt; `''` ist ein gültiger IndexedDB-Schlüssel, sortiert vor jedem echten Zeitstempel und
lässt eine undatierte Nachricht ans Ende eines Fensters statt an den Anfang rutschen. Im Render-Pfad
liefert `formatMessageTime` jetzt `null` statt zu werfen, und die drei Aufrufer zeichnen dann eine
Textzeile mit `list.noDate` (14 Bundles) statt eines `<time>` mit unlesbarem `datetime`.

**Kategorie / Bereich:** robustness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/format-message-time.ts:12-21` (`new Date(iso)` ohne Prüfung → `formatDate`/`formatRelativeTime`), `apps/web/src/i18n/formatters.ts:59-64` (`Intl.DateTimeFormat.format` wirft `RangeError` bei `Invalid Date`)
- Aufrufer: `apps/web/src/mail/MessageRow.tsx:237-239`, `apps/web/src/mail/MessageView.tsx:540-543`, `apps/web/src/mail/Conversation.tsx:199-201`
- Keine Validierung an der Grenze: `apps/web/src/sync/engine/port.ts:198`, `:287` (`response.list as unknown as EmailEnvelopeInput[]`), `apps/web/src/sync/db.ts:1000-1011` (`toEmailRow` spreizt durch); `packages/jmap/src/types/mail.ts:315` (`receivedAt: UTCDate` nur als Typ)
- Auffangen: `apps/web/src/app/shell/AppShell.tsx:166` (`ChunkErrorBoundary resetKey={route.id}`), `apps/web/src/pwa/ChunkErrorBoundary.tsx:84-86` (`getDerivedStateFromError` unbedingt — Fallback für die ganze Route)

**Problem:** RFC 8621 macht `receivedAt` zur Pflicht-`UTCDate`, aber der Client übernimmt den Wert
ungeprüft in IndexedDB und formatiert ihn im Render-Pfad mit Funktionen, die bei `Invalid Date` werfen.
`message-body.ts:205-219` ist für Adressen bewusst defensiv („a throw costs the whole app“) — das Datum
ist die verbliebene ungeschützte Stelle. Korrektur aus der Gegenprüfung: `null` wirft NICHT
(`new Date(null)` = Epoche → still „Jan 1, 1970“); werfen tun fehlendes Feld (`undefined`), leerer
String, Nicht-ISO-Strings und Werte außerhalb des Bereichs (`2026-13-45…`). Keine Laufzeitvalidierung in
`packages/jmap`.

**Auswirkung:** Ein nicht konformer oder fehlerhafter Server (ein fehlendes Feld oder ein
Nicht-ISO-String in einem einzigen Envelope) → beim Scrollen zu dieser Zeile wirft `MessageRow`, die
Mail-Route landet im Fehler-Fallback; Reload hilft nicht, weil die Zeile in der Replica bleibt — der
Ordner ist unbenutzbar, bis die Zeile evictet wird.

**Lösungsansatz:** (a) An der Grenze normalisieren: in `toEmailRow`
`Number.isNaN(Date.parse(String(email.receivedAt)))` → Fallback auf die Sync-Zeit oder
`new Date(0).toISOString()`, damit Index `[accountId+receivedAt]` und Anzeige konsistent bleiben.
(b) Formatter härten: `formatMessageTime` und die beiden `formatDate`-Aufrufer bei
`Number.isNaN(date.getTime())` einen Platzhalter liefern (`t('list.noDate')`, 14 Locales). (a) allein
reicht nicht für Zeilen, die schon in der Replica liegen.

**Aufwand:** S

**Verifikation:** `zz-verify-misc.test.tsx` „MAIL-05“: `formatMessageTime('not-a-date')` →
`RangeError`; `formatDate(new Date('x'), …)` → `RangeError`; `render(<MessageRow
…receivedAt:'garbage'>)` → wirft. Node-Probe: `null`/`1234` → „Jan 1, 1970“;
`undefined`/`''`/`'garbage'`/`'2026-13-45T00:00:00Z'` → `RangeError`. Gegenprüfung: bestätigt mit
Korrektur zum `null`-Fall.

(Quelle: MAIL-05)

### R-10 — [MEDIUM] Zwei weitere Dispatch-Stellen ohne Fehlerbehandlung — Rest des W-10-Fixes in `use-snooze.ts` und `labels/use-labels.ts` (vgl. W-10)

**Status:** [x] erledigt
Alle drei Stellen wie vorgeschlagen: `use-snooze.ts` über `dispatchOrReport`, `stripKeyword` mit
`try/catch` je Chunk und weiterlaufender Schleife plus `catch` am Aufruf (der Read, der die Schleife
füttert, liegt außerhalb des Chunk-`catch`), `LabelMenu` schluckt still. Abweichung bei `LabelMenu`:
statt `.catch(() => undefined)` das Wrap-Muster aus `usePrefetchBodies`
(`Promise.resolve().then(…).catch(…)`) — ein blankes `.catch()` fängt nur ein REJECTED Promise, und
ein synchroner Wurf (Engine mitten im Handover, unvollständiges Fake) wäre genau die unbehandelte
Rejection, die die Zeile verhindern soll. Die bestehenden `LabelMenu`-Tests haben das sofort gezeigt:
ihr Engine-Stub gibt `undefined` zurück.

**Kategorie / Bereich:** correctness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/use-snooze.ts:47-50` (`engine.dispatch(…)` in `setKeyword`, weder `void` noch `catch`; genutzt von `snooze` und `wake`), `apps/web/src/mail/use-snooze.ts:87-99` (`useSnoozeWaker` — automatisch, einmal pro Minute)
- `apps/web/src/mail/labels/use-labels.ts:91-97` (`stripKeyword`: `await engine.dispatch` in einer Chunk-Schleife), `apps/web/src/mail/labels/use-labels.ts:137` (`void stripKeyword(…)` ohne `catch`)
- Nebenstelle (kein Dispatch, gleiche Klasse): `apps/web/src/mail/labels/LabelMenu.tsx:64-66` (`void engine?.fetchEnvelopes(ids)`, offline → unbehandelte Rejection; `useEnsureEnvelopes` in `useMessageBody.ts:94-102` fängt denselben Aufruf)
- Vorbild: `apps/web/src/mail/use-message-actions.ts:61`, `apps/web/src/mail/use-folder-actions.ts:43`, `apps/web/src/sync/dispatch-failure.ts:60-64`

**Problem:** W-10 nannte nur `use-message-actions`, `use-folder-actions` und die Compose-Pfade; der Fix
(`dispatchOrReport`) blieb auf diese beschränkt, obwohl W-10 „kein einziger Aufrufer“ als Problem
beschreibt. `engine.dispatch` (`engine.ts:475-485`) awaitet `stateGuard`, `enqueueAction` und
`refreshQueueCounts` — alles IndexedDB-Writes, die werfen können. Grep über `apps/web/src/mail` findet
genau diese beiden ungeschützten `.dispatch(`-Stellen. Bei `stripKeyword` bricht ein fehlgeschlagener
Chunk die Schleife ab: Registry-Eintrag ist weg, ein Teil der Nachrichten trägt das Keyword noch, nichts
meldet das.

**Auswirkung:** Volle Platte beim Snoozen: `enqueueAction` wendet die optimistische Mutation zuerst an
(W-31) und scheitert am Outbox-Put — die Mail verschwindet optimistisch, der nächste Reload bringt sie
zurück, die Weckzeit steht im Pref; der Waker dispatcht später ein wirkungsloses Wecken und räumt das
Pref ab. Beim automatischen Wecken umgekehrt: Pref geräumt, `$snoozed` bleibt, die Mail bleibt aus jedem
Ordnerfenster gefiltert (`backfill.ts:57`). Beim Label-Strip: Rejection in der Konsole, Teil-Strip ohne
Hinweis.

**Lösungsansatz:** `use-snooze.ts`: `dispatchOrReport(engine.dispatch(…))`. `use-labels.ts`:
`stripKeyword` in `try/catch` mit `reportDispatchFailure(error)` und weiterlaufender Schleife (oder
Abbruch mit Meldung — nicht still); Aufruf `void stripKeyword(…).catch(reportDispatchFailure)`.
`LabelMenu`: `.catch(() => undefined)` wie in `usePrefetchBodies`. Test: Engine-Stub mit gespiontem
`catch`.

**Aufwand:** S

**Verifikation:** `zz-verify-misc.test.tsx` „MAIL-06“: (1) `catch`-Spy: snooze 0×, Kontrolle
`setSeen` 1×; (2) Label-Strip mit 600 Trägern und rejectendem `dispatch` → eine unbehandelte
Rejection, `dispatch` genau 1× bei zwei fälligen Chunks. Gegenprüfung: bestätigt, korrekt als Rest von
W-10 eingeordnet.

(Quelle: MAIL-06)

### R-11 — [MEDIUM] Anhänge: Download, Vorschau und „Alle speichern“ scheitern stumm (offline, 404, Größenlimit aus W-11) — keine Meldung, unbehandelte Rejection (vgl. W-11)

**Status:** [x] erledigt
Beide Teile umgesetzt. Fehlerbehandlung: `catch` je Aktion mit Toast (`tone: 'danger'`),
`Promise.allSettled` in `saveAll` mit Nennung der fehlenden Dateien, und `null` vom Fetcher (kein
Client) wird ebenfalls gemeldet statt still verschluckt. W-11-Rest: `BlobRef` trägt jetzt die
deklarierte `size`, und `useBlobFetcher` leitet daraus eine `maxBytes`-Grenze ab (`downloadCeiling`,
size × 2 + 1 MiB, nach oben durch `DEFAULT_MAX_DOWNLOAD_BYTES` gedeckelt). Abweichung vom
Lösungsansatz: `tooLarge` wird nicht am Fehlertext erkannt, sondern über eine neue Klasse
`BlobTooLargeError` in `@waxwing/jmap` — ein Textvergleich ist kein Vertrag, und die Klasse bleibt ein
`JmapError`, sodass jedes vorhandene `catch` unverändert greift. Die Klassifikation liegt als
`classifyBlobError` in `use-blob.ts` und baut auf `classifySourceError` auf, statt dessen Union zu
erweitern — das hätte den Quelltext-Dialog gezwungen, einen Fall zu behandeln, den er nicht auslösen
kann.

**Kategorie / Bereich:** robustness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/AttachmentList.tsx:115-133` (`saveOne`: `try/finally` ohne `catch`), `:142-171` (`saveAll`, `Promise.all`), `:173-188` (`unpack`), `:202-217` (`togglePreview`), `:276`, `:307`, `:315` (`onClick={() => void …()}`)
- `apps/web/src/mail/use-blob.ts:23-52` (`useBlobFetcher`, kein `catch`; liefert `null` nur ohne Client) → `apps/web/src/sync/blob-cache.ts:57` (`await download(ref)` außerhalb des `try`)
- `packages/jmap/src/blob.ts:92`, `:169`, `:173-177` (W-11: `DEFAULT_MAX_DOWNLOAD_BYTES = 256 MB`, `tooLarge`-`JmapError`; kein App-Aufrufer übergibt `maxBytes`/`part.size` — grep leer)

**Problem:** Die Nachbar-Oberflächen (`MessageSourceDialog`, `NestedMessageView`) klassifizieren
Fehler und zeigen sie an; die Anhangsleiste nicht. Netzfehler, 404 oder der W-11-`tooLarge`-Fehler
laufen als unbehandelte Rejection ins Leere; der Spinner geht aus (`finally`), sonst passiert nichts.
Bei `saveAll` fällt ein einzelner Fehlschlag das ganze `Promise.all`. Der W-11-Anteil (kein Aufrufer
übergibt `maxBytes`) ist ein Rest von W-11; der Kern (kein `catch`) ist davon unabhängig.

**Auswirkung:** Offline (Kernszenario dieser App) auf „Herunterladen“ eines nicht gecachten Anhangs
klicken → nichts. Vorschau → nichts. „Alle speichern“ mit einem nicht erreichbaren Blob → kein Zip,
keine Meldung. Das W-11-Limit greift, der Nutzer erfährt es nicht.

**Lösungsansatz:** In `AttachmentList` einen `catch`-Zweig je Aktion mit `useToast`
(`tone: 'danger'`) und derselben Klassifikation wie `classifySourceError` (offline / notFound / failed;
`tooLarge` aus `@waxwing/jmap` ergänzen). `saveAll`: `Promise.allSettled`, fehlende Einträge im Toast
nennen. Optional `maxBytes: part.size + Toleranz` an `download` übergeben, wie W-11 vorschlug.

**Aufwand:** S–M

**Verifikation:** `zz-verify-attach.test.tsx`, drei Tests mit rejectendem Fetcher unter
`ToastProvider`: Download → 1 unbehandelte Rejection, kein `role="alert"`; Vorschau (404) dito; „Alle
speichern“ mit einem von zwei fehlschlagenden Blobs → Rejection, kein Zip. `AttachmentList.test.tsx`
enthält keinen Fehlerpfad. Gegenprüfung: bestätigt.

(Quelle: MAIL-07)

### R-12 — [MEDIUM] Die geseedete Signatur macht jeden geöffneten Entwurf „nicht leer“: Öffnen + Schließen (oder 3 s warten) legt einen Signatur-only-Entwurf im Server-Drafts-Ordner an; jede Fensteränderung ohne Inhaltsänderung löst zusätzlich einen `create+destroy`-Roundtrip aus

**Status:** [x] erledigt
Alle drei Teile umgesetzt (Signatur-Guard, Dispatch-Skip bei unverändertem Inhalt,
Autosave armt nur auf Inhaltsfeldern). NICHT umgesetzt: die Discard-Rückfrage entfällt jetzt über
`isEmptyDraft` (Body ohne Signaturcontainer), nicht über `dirty === false` — `dirty` ist auch bei einem
aus dem Drafts-Ordner GEÖFFNETEN Entwurf `false`, und zusammen mit dem Löschpfad aus R-15 hätte
„nicht dirty = leer" Öffnen+Schließen einen echten Entwurf vernichtet.

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/FromField.tsx:46-61` (Signatur-Seed beim Laden der Identitäten, `markDirty: false`)
- `apps/web/src/compose/composer-store.ts:252-265` (`setFromIdentity` erzeugt ein neues Draft-Objekt), `apps/web/src/compose/composer-store.ts:196-202` (`setMode` ebenfalls)
- `apps/web/src/compose/use-draft-autosave.ts:40-48` (jede Objekt-Ungleichheit armt den 3-s-Timer)
- `apps/web/src/compose/use-draft-sync.ts:141-143` (`isEmptyDraft` einzige Sperre), `apps/web/src/compose/use-draft-sync.ts:157-177` (immer `putDraft` + `saveDraft`-Dispatch, kein Vergleich mit `existing.content`)
- `apps/web/src/compose/draft-email.ts:64-69` (`isEmptyDraft` ignoriert `dirty`; Signatur-Text zählt als Body)
- `apps/web/src/compose/ComposerWindow.tsx:206-209` (Discard fragt nach, weil „nicht leer“)

**Problem:** Mit konfigurierter Signatur hat jeder neue Entwurf sofort Body-Text. Nach 3 s (Autosave)
oder beim Schließen wird er lokal persistiert und per `Email/set` in Drafts geschrieben; Discard verlangt
eine Bestätigung für ein Fenster, in das nie getippt wurde. Unabhängig davon feuert jede Store-Änderung
ohne Inhaltsänderung (Minimieren, Wiederherstellen, Vollbild) den Autosave, der ohne Inhaltsvergleich
`create`+`destroy` an den Server schickt — neue Server-Id pro Fensterwechsel. Der bestehende Test
`draft-email.test.ts:93-108` prüft `isEmptyDraft` nur ohne Signatur; kein Guard, keine ADR weist den
Signatur-Entwurf als gewollt aus.

**Auswirkung:** „Neue Nachricht“ → nach 5 s per X geschlossen: ein Entwurf „(kein Betreff)“ nur mit
Signatur liegt im Drafts-Ordner (auch in anderen Clients). Ein Fenster dreimal
minimiert/wiederhergestellt = drei Server-Roundtrips mit identischem Inhalt.

**Lösungsansatz:** `isEmptyDraft` (oder `flushDraft`) wertet `dirty === false` als „leer“ (der Seed
setzt es bewusst nicht) — alternativ Body ohne `[data-waxwing-signature]`-Container (`signature.ts:14`)
bewerten. In `flushDraft` den Dispatch überspringen, wenn `existing?.status === 'synced'` und `content`
strukturell gleich `existing.content` ist (lokale Zeile darf trotzdem geschrieben werden).
`use-draft-autosave` nur auf Inhaltsfelder armen, nicht auf `mode`.

**Aufwand:** S–M

**Verifikation:** Reproduktion: `openDraft()` → `applySignature('', '<div>-- <br>Heiko</div>')` →
`setFromIdentity(…, {markDirty:false})`: `dirty === false`, `isEmptyDraft === false`;
`useDraftSync().flush(id)` schreibt die `drafts`-Zeile und dispatcht `saveDraft`; ein zweiter `flush`
mit identischem Inhalt dispatcht erneut. Gegenprüfung: bestätigt.

(Quelle: COMP-04)

### R-13 — [MEDIUM] `mailto:` dekodiert `+` als Leerzeichen — Subadressen (`bill+ietf@example.org`) werden zu ungültigen Empfängern

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/mailto.ts:36-42` (`decodeField`: `value.replace(/\+/g, ' ')` vor `decodeURIComponent`)
- `apps/web/src/compose/mailto.ts:66` (`new URLSearchParams(queryPart)` — dekodiert nach `application/x-www-form-urlencoded`, trifft `to`, `cc`, `bcc`, `subject`, `body`)
- Einspeisung: `apps/web/src/app/shell/use-mailto-handler.ts:43-58`

**Problem:** RFC 6068 §5 (Text lokal verglichen): „Current implementations encode a space as '+', but
this creates problems because such a '+' standing for a space cannot be distinguished from a real '+' in
a 'mailto' URI. When producing 'mailto' URIs, all spaces SHOULD be encoded as %20, and '+' characters
MAY be encoded as %2B. Please note that '+' characters are frequently used as part of an email address
to indicate a subaddress, as for example in <bill+ietf@example.org>.“ Der Parser tut das Gegenteil, an
zwei Stellen. `mailto.test.ts` (15 Fälle) enthält keinen `+`-Fall; nichts pinnt das aktuelle
Verhalten.

**Auswirkung:** Klick auf `mailto:bill+ietf@example.org` (registrierter Protokoll-Handler, FR-CMP-13)
öffnet den Composer mit einem rot markierten, unsendbaren Pill; `?subject=C++` wird „C  “.
Plus-Adressierung ist bei Gmail/Fastmail/Stalwart-Nutzern Alltag.

**Lösungsansatz:** Kleinster Eingriff: `+` vor dem Parsen schützen — `decodeField` ohne `replace`, und
`new URLSearchParams(queryPart.replace(/\+/g, '%2B'))` (ein `%2B` im Original bleibt `%2B` und wird
korrekt zu `+`). Alternativ Query manuell `split('&')` → `split('=', 2)` → `decodeURIComponent` beider
Hälften mit demselben try/catch. Tests mit `bill+ietf@example.org` in Pfad und Query sowie `C++`
ergänzen.

**Aufwand:** S

**Verifikation:** Reproduktion: Pfad und `?to=` → `bill ietf@example.org`, `?subject=C++` → `'C  '`;
`%2B` in Pfad und Query bleibt korrekt `+`. Gegenprüfung: bestätigt, RFC-Zitat wortgetreu.

(Quelle: COMP-05)

### R-14 — [MEDIUM] Enter/Komma während einer IME-Komposition committet den halbfertigen Text als Adresse

**Status:** [ ] offen

**Kategorie / Bereich:** a11y, i18n / Compose

**Fundstelle(n):**
- `apps/web/src/compose/RecipientField.tsx:243-257` (`onInputKeyDown`: `Enter`, `,`, `;` ohne Kompositionsprüfung)
- Vorbild: `apps/web/src/shortcuts/keys.ts:55`, `apps/web/src/shortcuts/ShortcutProvider.tsx:81` (die einzigen Stellen in `apps/web/src`, die `isComposing`/`keyCode === 229` behandeln)

**Problem:** Bei japanischer/chinesischer/koreanischer Eingabe (4 der 14 Locales) bestätigt Enter den
IME-Kandidaten. Der Handler sieht `key === 'Enter'`, ruft `preventDefault()` und `commitText(text)` —
der noch nicht konvertierte Kana-/Pinyin-Text wird als Pill übernommen (rot, unsendbar), das Feld
geleert, die Komposition abgebrochen. Kontaktsuche nach Namen (`田中`) ist per Tastatur nicht bedienbar.
`RecipientField.test.tsx` hat keinen IME-Fall. Dieselbe Lücke besteht im Escape-Koordinator und der
Palette (R-40).

**Auswirkung:** ja/zh/ko-Nutzerin tippt `たなか`, drückt Enter zur Umwandlung → Pill „たなか“ statt
Kandidatenauswahl; jeder Versuch endet gleich.

**Lösungsansatz:** Am Anfang von `onInputKeyDown`: `if (event.nativeEvent.isComposing ||
event.keyCode === 229) return` (Korrektur aus der Gegenprüfung: `isComposing` liegt auf
`event.nativeEvent`, nicht auf Reacts synthetischem Event; `onPillKeyDown` braucht nichts, ein `<button>`
hat keine Komposition). Test: `fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229
})` → kein `onChange`.

**Aufwand:** S

**Verifikation:** Reproduktion: Input auf `たなか`, `keyDown Enter` mit `isComposing: true, keyCode:
229` → `onChange([{email:'たなか'}])`, Input geleert. Gegenprüfung: bestätigt, Lösungsansatz
korrigiert.

(Quelle: COMP-06)

### R-15 — [MEDIUM] `close()` eines zuvor gespeicherten, inzwischen geleerten Entwurfs behält den alten Inhalt; ein Entwurf nur mit Anhang wird beim Schließen nicht gespeichert und beim Verwerfen ohne Rückfrage gelöscht

**Status:** [x] erledigt
Beide Fälle umgesetzt: `isEmptyDraft` zählt Anhänge, und `flushDraft` löscht bei
leerem Entwurf die vorhandene Zeile und dispatcht `discardDraft` (bzw. verwirft einen noch wartenden
Save, wenn es noch keine Server-Id gibt).

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/use-draft-sync.ts:141-143` (`flushDraft` kehrt bei `isEmptyDraft` zurück — löscht nichts), `apps/web/src/compose/use-draft-sync.ts:231-237` (`close` = `flushDraft` + Fenster zu)
- `apps/web/src/compose/draft-email.ts:64-69` (`isEmptyDraft` prüft Empfänger, Betreff, Body — nicht `attachments`)
- `apps/web/src/compose/ComposerWindow.tsx:206-209` (leer ⇒ Discard ohne Bestätigung)

**Problem:** (a) Tippen, 3 s warten (lokale Zeile + Server-Draft), alles löschen, schließen:
`flushDraft` sieht einen leeren Entwurf und tut nichts — lokale Zeile und Server-Draft mit dem alten
Inhalt bleiben. (b) Neuer Entwurf, nur eine Datei angehängt (Upload fertig), Schließen: nichts wird
gespeichert, die Anhangsreferenz ist weg — obwohl Close laut Docstring „SAVES the draft“. Discard
desselben Entwurfs löscht ohne Rückfrage. Präzisierung aus der Gegenprüfung: `useDraftRestore`
(`use-draft-restore.ts:26-29`) überspringt `synced`-Zeilen; der „Chip beim nächsten Start“ erscheint
nur, solange die Zeile noch `pending`/`error` ist. Das dauerhafte Symptom ist der Server-Entwurf im
Drafts-Ordner plus die lokale Leiche, die `getDraftByServerId` beim Öffnen aus dem Ordner wieder liefert.

**Auswirkung:** (a) ist der Normalweg „ich habe es mir anders überlegt“ (ohne Signatur) und hinterlässt
einen Zombie-Entwurf im Drafts-Ordner; (b) verliert einen 20-MB-Upload still.

**Lösungsansatz:** `isEmptyDraft` um `attachments.length === 0` erweitern. In `flushDraft` bei leerem
Entwurf und vorhandener `existing`-Zeile: `deleteDraft` + (falls `serverEmailId`)
`discardDraft`-Dispatch — das Verhalten von `discard()` ohne Fenster-Close. Tests für beide Fälle.

**Aufwand:** S

**Verifikation:** Reproduktion (a): `openDraft({subject:'Hallo'})` → `flush` → `updateSubject('')` →
`close`: Zeile behält „Hallo“, kein `discardDraft`; (b): Entwurf nur mit Anhang → `isEmptyDraft ===
true`, `close` persistiert nichts. Gegenprüfung: bestätigt, Auswirkung präzisiert.

(Quelle: COMP-07)

### R-16 — [MEDIUM] Ganztägige Termine bekommen am Tag der Sommerzeit-Umstellung einen zusätzlichen Tag

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/calendar-client.ts:539-543` (`placeEvent`: `endsAt = startsAt + durationToMs('P1D')` bzw. `+ 86_400_000` — Millisekunden über einen 23-Stunden-Tag), `apps/web/src/calendar/jscalendar-time.ts:129` (`durationToMs`)
- `apps/web/src/calendar/month-grid.ts:133-143` (`daysBetween`, halboffen: `endsAt` = 01:00 des Folgetags → Folgetag wird mitgezählt)
- `apps/web/src/calendar/week-grid.ts:39-44` (`overlapsDay`, Ganztagsband der Wochenansicht)

**Problem:** `month-grid.ts` warnt dreimal davor, Tage per `DAY_MS` zu addieren; `placeEvent` tut genau
das für ganztägige Termine. Am Umstellungstag ist Mitternacht + 24 h = 01:00 des Folgetags. Der Fehler
liegt in eigener Arithmetik, nicht in einer Bibliothek. Herbst ist korrekt (`endsAt` = 23:00 desselben
Tags, Zufall der Richtung).

**Auswirkung:** Ein eintägiger Ganztagstermin am Umstellungstag erscheint in Monatsraster, Tagesdialog
und Wochen-Ganztagsband auch am Folgetag; ein mehrtägiger Termin über die Frühjahrsumstellung ist einen
Tag zu lang. Einmal im Jahr, jeder betroffene Ganztagstermin, alle Locales.

**Lösungsansatz:** Für `allDay` das Ende über `addDays(startOfDay(start), Tage)` bilden; Tage aus der
Duration (`P1D`/`P3D`/`P1W`) zählen statt Millisekunden addieren.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt unter `TZ=Europe/Berlin` (29.3.) und `TZ=America/New_York`
(8.3.): `P1D` → `['…-03-29','…-03-30']` bzw. `['…-03-08','…-03-09']`, ohne Duration ebenso, `P3D` → 4
Tage, `overlapsDay(Folgetag)` → `true`. Gegenprüfung: bestätigt.

(Quelle: PIM-04)

### R-17 — [MEDIUM] Wochenansicht und Verfügbarkeitsbänder liegen am Umstellungstag eine Stunde falsch

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/week-grid.ts:32-36` (`minuteOfDay`: `(instant - startOfDay(day)) / 60_000`)
- `apps/web/src/calendar/availability.ts:107-119` (`busyBandsForDay`: dieselbe Rechnung)
- `apps/web/src/calendar/WeekView.tsx:49-51` (`minuteInstant` — die korrekte Variante, für die Screenreader-Beschriftung)

**Problem:** Minuten seit Mitternacht als Instant-Differenz; nach der Frühjahrsumstellung liegen
zwischen lokal 00:00 und 10:00 nur 9 Stunden, nach der Herbstumstellung 11. Grafik und
Screenreader-Beschriftung widersprechen sich.

**Auswirkung:** Am 29.3. wird ein 10:00-Termin auf der 09:00-Linie gezeichnet, am 25.10. auf der
11:00-Linie; alle Termine nach der Umstellungsstunde und die Free/Busy-Schraffur sind betroffen, während
der Chip 10:00 anzeigt.

**Lösungsansatz:** Minute aus lokalen Datumsteilen (`d.getHours() * 60 + d.getMinutes()`; vor dem Tag
beginnend → 0, nach dem Tag endend → 1440).

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt: `layoutDay` für 10:00 am 29.3. (Berlin) → `startMinute:
540`, am 25.10. → `660`; `busyBandsForDay` → `540`; identisch unter `TZ=America/New_York` an dessen
Umstellungstagen. Gegenprüfung: bestätigt.

(Quelle: PIM-05)

### R-18 — [MEDIUM] Zwei verschiedene Teilnehmeradressen kollabieren zu einem Map-Key — ein Eingeladener geht stillschweigend verloren

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/event-participants.ts:235-249` (`newParticipantRow`: `key = 'p' + address.replace(/[^a-z0-9]/g, '')`)
- `apps/web/src/calendar/event-participants.ts:209-224` (`participantsToPatch`: `map[row.key] = participant` — letzter gewinnt)
- `apps/web/src/calendar/event-participants.ts:88-94` (`normaliseAddress` senkt nur Groß-/Kleinschreibung und entfernt `mailto:`)
- `apps/web/src/calendar/EventDialog.tsx:669` (Duplikatprüfung nur über `address`)

**Problem:** `john.doe@` / `johndoe@`, `a-b@` / `ab@`, `me+cal@` / `mecal@`, `björn@` / `bjrn@`
bekommen denselben Key; die Liste zeigt zwei Zeilen (mit React-Key-Duplikat), der Patch enthält nur die
zweite. Die Duplikatprüfung im Dialog geht über `address`, lässt also beide Zeilen zu.

**Auswirkung:** Zwei Personen eingeladen, zwei Zeilen gesehen, gespeichert — auf dem Server und in der
Einladung steht nur eine. Kein Fehler, kein Hinweis.

**Lösungsansatz:** Key kollisionsfrei bilden (z. B. `p` + Hex/Base64url der normalisierten Adresse,
oder Zähler-Key plus Deduplikation über `address` wie bisher); in der `ParticipantsPage` zusätzlich über
`key` prüfen.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt:
`participantsToPatch([newParticipantRow('john.doe@example.test'),
newParticipantRow('johndoe@example.test')])` → ein Key `pjohndoeexampletest`. Gegenprüfung: bestätigt.

(Quelle: PIM-07)

### R-19 — [MEDIUM] Eine Namensänderung im Kontaktformular verwirft `sortAs`, `isOrdered` und `full` des Namens

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kontakte)

**Fundstelle(n):**
- `apps/web/src/contacts/contact-card-mapping.ts:435-461` (`formToName` baut bei jeder Änderung `{ '@type': 'Name', components }` von Grund auf)
- `packages/jscontact/src/types.ts:50-62` (`Name.full`, `sortAs`, `isOrdered`)

**Problem:** Der Dateikopf (Z. 13-18) verspricht, dass nichts Unbekanntes verworfen wird; alle anderen
Sammlungen (`formToEmails`, `formToPhones`, `formToAddresses`, `formToOrganizations`) bauen „on the
original“, `formToName` ist die verbliebene Ausnahme. Betroffen ist auch alles, was der Typ nicht
modelliert (RFC 9553 `phoneticScript`, `phoneticSystem`, `defaultSeparator`). Das Verwerfen von `full`
ist richtig (sonst zeigte `contactDisplayName` den alten Namen), sollte aber bewusst geschehen.

**Auswirkung:** Kontakt aus Apple Contacts/Thunderbird mit `SORT-AS` oder ein Name mit `isOrdered`
(Nachname-zuerst-Kulturen) → Tippfehler im Vornamen korrigiert → in den anderen Clients sortiert bzw.
ordnet der Name anschließend anders; nichts im UI deutet darauf hin.

**Lösungsansatz:** `const base = original ? { ...original } : { '@type': 'Name' }; base.components =
components; delete base.full`.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt: nach Änderung des Vornamens ist `next.name` =
`{"@type":"Name","components":[…]}`, `sortAs`/`isOrdered`/`full` fehlen. Gegenprüfung: bestätigt.

(Quelle: PIM-08)

### R-20 — [MEDIUM] Die Kontaktliste sortiert bei jedem Replica-Write und beim Tippen mit `localeCompare` und rechnet den Anzeigenamen pro Vergleich neu — 5 000 Kontakte kosten ~220 ms pro Sortierung

**Status:** [ ] offen

**Kategorie / Bereich:** performance / PIM (Kontakte)

**Fundstelle(n):**
- `apps/web/src/contacts/use-contact-search.ts:71-78` (`sortForDisplay`: `contactSortKey(a).localeCompare(contactSortKey(b), undefined, { sensitivity: 'base' })`), `apps/web/src/contacts/use-contact-search.ts:116-133` (Memo hängt an `[baseCards, serverCards, trimmed]`)
- `apps/web/src/contacts/use-contact-groups.ts:16-18` (`byDisplayName`, gleiches Muster für `selectGroups`/`selectMemberCandidates`)
- `apps/web/src/contacts/contact-fields.ts:90-146` (`contactSortKey` → `contactDisplayName`: mehrere Filter/Joins pro Aufruf)
- Vergleich: `apps/web/src/files/file-sort.ts:74` benutzt bereits einen `Intl.Collator`

**Problem:** n·log n Vergleiche × 2 Namensberechnungen × `localeCompare` ohne Collator; bei 5 000
Karten ~120 000 Namensberechnungen pro Sortierung, auf dem Main-Thread. Präzisierung: beim Tippen läuft
die Sortierung über die *gefilterte* Menge (klein, außer bei breiten Treffern); die volle Sortierung
fällt bei jedem Live-Query-Rerun (jeder Write auf `contactCards`) und beim Leeren des Suchfelds an.
NFR-PERF-02 gilt nur für Mail-Listen; für Kontakte gibt es keine Zahlenvorgabe.

**Auswirkung:** Bei jedem Sync-Write auf eine Kontaktkarte und beim Leeren des Suchfelds ~220 ms
Blockade; Eingaben „hängen“ für Tastaturnutzer.

**Lösungsansatz:** Sortierschlüssel einmal pro Karte berechnen, modulweiter `Intl.Collator(locale, {
sensitivity: 'base', numeric: true })`; sortierte Basisliste memoisieren, beim Tippen nur filtern.

**Aufwand:** S

**Verifikation:** Messung wiederholt (Node 24, synthetische Karten, `TZ=America/New_York`): `current
comparator: 220.9 ms; collator+keys: 8.2 ms` (Erstprüfung 216,6 / 6,7 ms). Gegenprüfung: bestätigt,
Skriptwert, keine Schätzung.

(Quelle: PIM-10)

### R-21 — [MEDIUM] Die Volltabellen-Live-Query über `contactCards` (inklusive eingebetteter Fotos) läuft bei jedem Write komplett neu — im Kontakte-Screen, in der Absenderkarte und je offenem Composer-Fenster

**Status:** [ ] offen

**Kategorie / Bereich:** performance / PIM (Kontakte) + Compose

**Fundstelle(n):**
- `apps/web/src/contacts/use-contact-groups.ts:21-25` (`useAccountContactCards`: `db.contactCards.where('accountId').equals(accountId).toArray()` als `useLiveQuery`)
- `apps/web/src/compose/RecipientFields.tsx:65-71` (dieselbe Query je Composer-Fenster; der Kommentar `:60-64` erklärt, warum der Composer die werfende Variante nicht nutzt), `apps/web/src/compose/contact-suggestion-source.ts:111-135` (lineare Suche über die ganze Liste)
- `apps/web/src/contacts/ContactsScreen.tsx:130-165` (vier Memos über `allCards`, darunter zwei Sortierungen — R-20)
- `apps/web/src/mail/SenderCard.tsx:56` mit `apps/web/src/mail/MessageView.tsx:1321-1322` (Vollscan pro Öffnen der Absenderkarte — nur bei Klick auf den Absender gemountet)
- `apps/web/src/contacts/contact-photo.ts:46` (Fotos inline in der Karte als `data:`-URI, `PHOTO_MAX_BYTES = 64 KB` → ~85 KB Base64), `apps/web/src/sync/db.ts:927` (`contactCards: '[accountId+id], accountId, *abk'` — kein Index nach E-Mail)
- `apps/web/src/contacts/ContactImportExportDialog.tsx:196-198` (eine Enqueue-Transaktion je Karte → ein Rerun je Karte)

**Problem:** Jede Transaktion auf `contactCards` (Delta mit Kartenänderungen, jede optimistische
Enqueue beim Import) lässt die Live-Query die komplette Tabelle inklusive Fotos deserialisieren, solange
`ContactsScreen` gemountet ist; `SenderCard` tut dasselbe einmal pro Öffnen; jedes Composer-Fenster (bis
zu drei) hält eine eigene Instanz derselben Query, und ist parallel eine Kontaktansicht offen, läuft sie
dort ein weiteres Mal. Der PIM-Bericht liefert die Messung und den Schema-Aspekt (Fotos, fehlender
E-Mail-Index), der Compose-Bericht die Vervielfachung je Fenster. Korrekturen aus der Gegenprüfung:
Tippen im Gruppen-Picker schreibt nicht in die DB (Rerun nur durch Writes); der Mail-Lesebereich zahlt
nicht „pro Nachricht“, sondern pro geöffneter Absenderkarte; „~40 GB beim Import“ war eine naive
Obergrenze (Dexie koalesziert Reruns). Der Fix „Projektion in der Query“ ist nicht umsetzbar — IndexedDB
liefert immer ganze Werte, `.each` deserialisiert genauso.

**Auswirkung:** Adressbuch mit 3 000 Karten, 1 000 Fotos: ≥ 160 ms Main-Thread pro Rerun (untere
Schranke, fake-indexeddb ohne Platte; echtes IndexedDB liegt darüber), beim Import von 500 Karten bis zu
500 Reruns; das Öffnen einer Absenderkarte kostet einen Vollscan; im Composer bei einigen tausend
Kontakten mehrere MB pro Fenster und pro Sync-Tick, spürbar auf Mobilgeräten (W-18 lässt die Tabelle
bewusst ungeprunt wachsen).

**Lösungsansatz:** `media` (oder nur `uri`) in eine eigene Tabelle/Spalte auslagern, die ausschließlich
`ContactPhoto` liest (Version-Bump mit `.upgrade()`); `SenderCard` über einen E-Mail-Index
(`*emails`-multiEntry auf der Zeile) statt Vollscan; Reruns beim Import durch `bulkAdd` in einer
Transaktion bündeln. Für den Composer eine geteilte, Provider-sichere Quelle (ein `useLiveQuery` in
einem Provider/Cache, den `useAccountContactCards` und `RecipientFields` gemeinsam nutzen), oder die
Kontaktsuche on demand in der Quelle (`where('accountId').equals(id).filter(match).limit(n)`).

**Aufwand:** M–L (Schema-Migration); Composer-Anteil M

**Verifikation:** Messung `zz-verify-pim-livequery.test.ts` (fake-indexeddb): 3 000 Karten, 1 000 mit
85-KB-Foto (≈ 84 MB) → `toArray()` 161 / 167 / 162 ms; Code gelesen (Mount-Bedingung, Rerun-Auslöser,
Composer-Query). Gegenprüfung PIM: abgeschwächt, Severity medium beibehalten; Gegenprüfung Compose:
bestätigt (Code), nicht gemessen.

(Quelle: PIM-11, COMP-12)

### R-22 — [MEDIUM] Der Object-URL-Cache der Dateiansicht ist nur nach Knoten-Id geschlüsselt — im geteilten Konto zeigt die Vorschau die Bytes der eigenen Datei

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Dateien)

**Fundstelle(n):**
- `apps/web/src/files/FilesPage.tsx:241-243` (`urlCacheRef = new Map<string, string>()`, Key `node.id`), `apps/web/src/files/FilesPage.tsx:504-512` (`objectUrl`: Treffer → kein Download), `apps/web/src/files/FilesPage.tsx:514-524` (`download` über `objectUrl`)
- `apps/web/src/files/FilesPage.tsx:569-582` (`goToAccount` setzt Pfad, Suche, Auswahl, Vorschau zurück — den Cache nicht)

**Problem:** Stalwart vergibt kurze, kontobezogene Ids; dieselbe Id existiert in fast jedem Konto. Der
Cache liefert für Konto D die URL, die für Konto B erzeugt wurde; ebenso für eine geänderte Datei
gleicher Id (neue `blobId`, alte Bytes für die Sitzung). Keine Sicherheitsrelevanz: derselbe Nutzer
sieht seine eigenen Bytes; W-17/ADR-037 ist nicht berührt.

**Auswirkung:** Eigene `photo.png` (Id `n1`) angesehen, in „Mit mir geteilt → carol“ gewechselt,
Vorschau/Download der dortigen Datei mit Id `n1` → die **eigenen** Bytes werden angezeigt bzw. unter
Carols Dateinamen heruntergeladen.

**Lösungsansatz:** Cache nach `${accountId}:${node.blobId}` schlüsseln; in `goToAccount` zusätzlich alle
URLs widerrufen und leeren.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt (`zz-verify-pim-files.test.tsx`): `download` nur für
`b:my-photo.png`, beide `<img src>` sind `blob:test/1`. Gegenprüfung: bestätigt.

(Quelle: PIM-12)

### R-23 — [MEDIUM] Die Server-Auflistung eines geteilten Kontos hat keinen Stempel — eine langsame Antwort landet in einem Ordner, den die Leserin schon verlassen hat

**Status:** [ ] offen

**Kategorie / Bereich:** react (Race) / PIM (Dateien)

**Fundstelle(n):**
- `apps/web/src/files/FilesPage.tsx:333-358` (`load`: `setRemoteNodes(listing.nodes)` ohne `live`-Guard), `apps/web/src/files/FilesPage.tsx:360-362` (Effekt ohne Cleanup)
- Muster im selben Bereich: `apps/web/src/files/FileMoveDialog.tsx:85-107` (`live`-Flag)

**Problem:** Jede Antwort des Remote-Pfads wird ungeprüft in den State geschrieben. Der Replica-Pfad
(eigenes Konto) ist immun, weil er keyed liest.

**Auswirkung:** carol → Ordner „Reports“ (langsam) → Brotkrume zur Wurzel (schnell) → die verspätete
Ordnerantwort überschreibt die Wurzelliste; Überschrift und Liste passen nicht zusammen, Bulk-Aktionen
(auch Löschen) greifen auf Knoten außerhalb des angezeigten Ordners.

**Lösungsansatz:** `live`-Flag/AbortController im Effekt und Antworten nach Cleanup verwerfen (Muster
`FileMoveDialog.tsx`), oder Ergebnis mit `{ here, query }` stempeln und beim Rendern prüfen.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt: `heading: carol@waxwing.test | inner.png shown? true |
Reports shown? false`. Gegenprüfung: bestätigt.

(Quelle: PIM-13)

### R-24 — [MEDIUM] Umbenennen, Verschieben und Löschen sind offline nicht gesperrt, der „Verschieben nach…“-Dialog liest trotz Replica über das Netz, und der Fehler heißt danach „vom Server abgelehnt“

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / PIM (Dateien)

**Fundstelle(n):**
- `apps/web/src/files/FilesPage.tsx:1112-1167` (Zeilenaktionen `rename` `:1112-1125`, `move` `:1140-1147`, `delete` `:1158-1167` mit `disabled: busy` ohne `online`/`unavailableReason`), `apps/web/src/files/FilesPage.tsx:726-744` (Gegenbeispiel: Bar-Aktionen haben es)
- `apps/web/src/files/FilesPage.tsx:486-490` (`run`: jeder Nicht-`FileSetError`, auch `TypeError: Failed to fetch`, → `files.error.rejected`)
- `apps/web/src/files/FileMoveDialog.tsx:85-107` (`client.list(here)` je Ebene; an der Wurzel laut `files-client.ts:178-192` die ungefilterte Gesamtabfrage mit bis zu `MAX_PAGES = 10` Seiten), `apps/web/src/files/FileMoveDialog.tsx:8-13` (Kopfkommentar „a file tree has no replica“ — seit D-4 falsch; `useFileNodes(parentId)` in `sync/react.tsx:334-343` existiert)

**Problem:** Der Seitenkopf verspricht „greyed out with a reason“ für alles ohne Verbindung; für die
drei Schreibaktionen der Zeile gilt das nicht, und der Move-Dialog holt jede Ebene per Round-Trip.

**Auswirkung:** Offline: „Löschen“ → Bestätigung → Toast „Der Server hat die Änderung abgelehnt“
(falsche Ursache); „Verschieben“ → Spinner → „konnten nicht geladen werden“, „Hierher verschieben“
bleibt aktiv und scheitert ebenfalls mit „abgelehnt“. Online kostet jeder Schritt im Move-Dialog an der
Wurzel die komplette Kontoabfrage.

**Lösungsansatz:** Zeilenaktionen mit `unavailableReason={online ? undefined : t('files.offline')}`;
in `run` `TypeError`/`AbortError` als Offline melden; `FileMoveDialog` für das eigene Konto aus
`useFileNodes(here)` lesen, nur für geteilte Konten den Client fragen.

**Aufwand:** M

**Verifikation:** Code gelesen (Zeilenaktionen, `run`, Move-Dialog, `useFileNodes`). Gegenprüfung:
bestätigt.

(Quelle: PIM-15)

### R-25 — [MEDIUM] W-13-Fix unvollständig: die Server-Id wird beim Einreihen eingefroren — ein Save, Discard oder Send, der während eines `inflight`-Autosaves eingereiht wird, hinterlässt einen verwaisten Server-Entwurf (vgl. W-13, W-32)

**Status:** [x] erledigt
Umgesetzt bis auf die Ergänzung „`notDestroyed[priorServerId]` für `sendEmail` auswerten“: `submitEmail`
liefert das `EmailSubmission/set`-Ergebnis zurück, dessen `notDestroyed` den Email-Id nie enthält — und eine
Bewertung als Rejection würde einen **erfolgreich versendeten** Brief dead-lettern und den Entwurf wieder
aufmachen. Bleibt als Nebenbefund offen (Port müsste `emailNotDestroyed` mitführen, wie schon `emailCreated`).

**Kategorie / Bereich:** correctness / Sync + Compose

**Fundstelle(n):**
- `apps/web/src/compose/use-draft-sync.ts:150`, `:172` (`serverEmailId`/`priorServerId` aus der drafts-Zeile zum Flush-Zeitpunkt)
- `apps/web/src/compose/use-draft-sync.ts:238-251` (`discard` liest `row.serverEmailId` zum Zeitpunkt des Klicks; reiht `discardDraft` nur bei `serverEmailId != null` ein, `:241`)
- `apps/web/src/compose/use-draft-sync.ts:317` (`db.outbox.delete([accountId, outboxId(localId)])` in `send()` — bedingungslos, auch für eine `inflight`-Zeile), `apps/web/src/compose/use-draft-sync.ts:334` (`priorServerId: existing?.serverEmailId` eingefroren)
- `apps/web/src/sync/engine/outbox.ts:2415-2429` (`reconcileDraftSave`: nur `db.drafts.update`, kein `rewriteQueued`; überschreibt `status: 'sending'` mit `'synced'`)
- `apps/web/src/sync/engine/outbox.ts:2012-2019` (`deleteIfUnchanged`, W-13: die Ersatzzeile überlebt — mit dem veralteten `priorServerId`)
- `apps/web/src/sync/engine/outbox.ts:2205-2222` (W-32: `notFound` auf `priorServerId` gilt bewusst als Erfolg — deshalb fällt der doppelte Destroy nicht auf), `apps/web/src/sync/engine/conflict.ts:85-95` (`discardDraft` ist `isDestroy` → `notFound` = `satisfied`), `apps/web/src/sync/engine/outbox.ts:2226-2230` (`sendEmail`: `notDestroyed` wird nicht ausgewertet)
- Vorbild: `apps/web/src/sync/engine/outbox.ts:2299-2310` (`rewriteQueued` für Kontakte/Adressbücher)

**Problem:** `saveDraft` ist create-new + destroy-old; welches `old` zerstört wird, steht im Intent.
Läuft Save A (`inflight`), ist dessen Server-Id `S_A` bis zur Antwort unbekannt, und
`reconcileDraftSave` schreibt keine wartende Outbox-Zeile um. Der `seq`-Vergleich in
`deleteIfUnchanged` rettet die *Zeile* eines nachfolgenden Intents, nicht deren Inhalt. Beide Berichte
beschreiben diese eine Ursache aus zwei Richtungen; zusammen ergeben sich vier Varianten:
1. **Save B** (Weitertippen, `close()`, `visibilitychange`) mit `priorServerId = null` (erster Save)
   bzw. `S_0` (Vorgänger): B überlebt den W-13-Fix, wird im nächsten Pass gesendet, zerstört nichts
   bzw. erneut `S_0` (→ `notFound` → W-32: Erfolg). `S_A` bleibt für immer in Drafts. Gilt bei JEDEM
   überlappenden Save-Paar, nicht nur beim ersten (V2).
2. **Discard mit noch unbekannter Id** (`serverEmailId === null`): kein `discardDraft` wird
   eingereiht; `reconcileDraftSave` läuft nach A ins Leere (`update` auf fehlendem Key = No-op).
   `S_A` bleibt.
3. **Discard mit bekannter Id**: Discard trägt `S1`, während der laufende Save `S1` zerstört und `S2`
   anlegt; beim Replay ist `destroy S1` → `notFound` → `satisfied` → Zeile weg, `S2` bleibt.
4. **Send**: `send()` löscht die `inflight`-Save-Zeile ohne Statusprüfung; die Antwort kommt trotzdem,
   `reconcileDraftSave` trägt `S2` ein und überschreibt dabei `sending` → `synced`; die Send-Zeile
   behält `priorServerId: S1` (bzw. `null`), ihr `destroy S1` ist ein No-op, `reconcileSend` löscht die
   lokale Zeile — `S2` bleibt als Leiche in Drafts; `submitEmail` erhält `destroyServerDraftId 'S1'`.
Zur Einordnung: Kein Duplikat von W-13 (das behob das Löschen der Ersatzzeile), und laut Gegenprüfung
keine Regression — vor dem Fix erzeugte dieselbe Überlappung eine veraltete Server-Kopie mit
fälschlichem `synced` (genau W-13), also einen anderen falschen Zustand. Verwandt, aber eigener Befund:
R-29 (`discard()` lässt einen noch `pending` Autosave stehen — race-frei).

**Auswirkung:** Nutzerin tippt, Pause ≥ 3 s → Autosave A (`use-draft-autosave.ts:16`); innerhalb des
Roundtrips (mobil 1–3 s) tippt sie weiter, schließt, verwirft oder sendet → ein dauerhafter
Doppel-/Geisterentwurf pro Vorkommen, auf allen Geräten sichtbar, nicht selbstheilend. Beim Senden geht
die Mail korrekt raus, aber eine Kopie der letzten Autosave-Version bleibt in Drafts. Auf langsamen
Verbindungen wiederholt sich das bei jedem Pausen-Autosave. Der Kommentar in `use-draft-opener.ts:54ff`
beschreibt genau diese Nutzermeldung („Ordner voller Kopien“) als bereits einmal berichteten Fehler.
Die beiden Gegenprüfer sind sich bei der Severity uneins: Sync setzt medium (Geisterentwürfe auf dem
Server, kein Verlust von Nutzertext, kein Funktionsbruch), Compose empfahl high; hier medium, weil keiner
der beiden verifizierten Berichte einen Verlust von Nutzertext belegt.

**Lösungsansatz:** In `reconcileDraftSave` nach dem `db.drafts.update` mit `rewriteQueued(db,
accountId, …)` alle wartenden Zeilen desselben `localId` umschreiben: `saveDraft.priorServerId`,
`discardDraft.serverEmailId`, `sendEmail.priorServerId` von `intent.priorServerId` (bzw. `null`) auf
`created.id` — nur wenn der alte Wert noch dem des abgeschlossenen Intents entspricht, damit eine
neuere Id nicht überschrieben wird; `rewriteQueued` überspringt `inflight` bereits. Der Rückgabewert von
`db.drafts.update` (0 = Zeile fehlt = inzwischen verworfen) löst Variante 2: dann `discardDraft` für
`created.id` einreihen (oder direkt `port.setEmails({destroy: [created.id]})`). `status` nur setzen,
wenn die Zeile nicht `sending` ist. In `send()` die Autosave-Zeile nur löschen, wenn sie `pending` ist
(rw-Transaktion mit Re-Read) — eine `inflight`-Zeile stehen lassen, der Rewrite deckt sie ab. Ergänzend
`notDestroyed[priorServerId]` für `sendEmail` wie bei `saveDraft` auswerten (ohne `notFound`). Dank
W-32 ist ein veralteter Destroy harmlos, das Umschreiben kann also nichts verschlimmern. Alternative
(größerer Eingriff): `priorServerId` erst beim Replay aus der drafts-Zeile auflösen — deckt Variante 2
nicht ab.

**Aufwand:** M

**Verifikation:** Sync: B1/B2/B3 (Scratch des Prüf-Agenten, wiederholt) und V2 (eigener Test der
Gegenprüfung: Waise auch mit bekanntem `priorServerId`) rot. Compose: T1 (Discard während
`inflight`-Save S1→S2: Port sah `destroy ['S1']` zweimal, nie `S2`; Discard-Zeile nach `notFound` weg)
und T2 (Send während `inflight`-Save: `inflight`-Zeile gelöscht, `sending`→`synced` mit `S2`,
Send-Payload `priorServerId 'S1'`) grün im Sinne des Fehlverhaltens. Gegenprüfung beider Berichte:
bestätigt, Überschneidung vermerkt.

(Quelle: SYNC-01, COMP-03)

### R-26 — [MEDIUM] `retryFailed` wirft für jeden Kontakt-/Adressbuch-Dead-Letter — `contactCards`/`addressBooks` fehlen im Transaktionsscope

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/engine.ts:551-566` (`retryFailed`: Transaktion über `outbox`, `emails`, `emailBodies`, `queryCache`, `mailboxes`)
- `apps/web/src/sync/engine/outbox.ts:1604-1652` (`applyOptimistic`: `putContactCards`/`db.contactCards`/`putAddressBooks`/`db.addressBooks` für alle sechs Kontakt-/Adressbuch-Intents), `apps/web/src/sync/engine/outbox.ts:1960-1968` (`enqueueAction` hat die Tabellen im Scope), `apps/web/src/sync/db.ts:843-844`
- `apps/web/src/outbox/use-outbox-problems.ts:113-117` (`void retry(row.id)` ohne `catch`), `apps/web/src/outbox/OutboxProblemsDialog.tsx:87`

**Problem:** `retryFailed` ruft `applyOptimistic` innerhalb einer `rw`-Transaktion auf, deren
Tabellenliste seit M4.2 unvollständig ist; Dexie weist den Zugriff auf eine nicht gelistete Tabelle in
der Transaktionszone mit `NotFoundError` ab. Für `createContactCard`/`updateContactCard`/
`deleteContactCard`/`createAddressBook`/`updateAddressBook`/`deleteAddressBook` scheitert der Retry
immer. Im Nutzerpfad wird das eine unhandled rejection, die Zeile bleibt unverändert.

**Auswirkung:** Ein abgelehnter Kontakt-Edit (`invalidProperties`, `forbidden` in einem geteilten
Buch, erschöpfte `stateMismatch`-Refreshes) landet im Problems-Dialog; „Erneut versuchen“ tut sichtbar
nichts. Der Wiederherstellungspfad ist für die ganze Intent-Familie tot.

**Lösungsansatz:** Tabellenliste an EINER Stelle definieren (z. B. `OPTIMISTIC_TABLES(db)`) und von
`enqueueAction` und `retryFailed` nutzen; Array-Form wie in `enqueueAction`. Test in
`outbox.contacts.test.ts` oder `engine.test.ts` (bisher kein Retry-Test für Kontakte).

**Aufwand:** S

**Verifikation:** C1 wiederholt: `retryFailed('i1')` wirft `NotFoundError: The operation failed because
the requested database object could not be found…`. Gegenprüfung: bestätigt.

(Quelle: SYNC-03)

### R-27 — [MEDIUM] Nicht-idempotente Creates werden nach verlorener Antwort oder Absturz erneut gesendet — Duplikate bei Drafts und Adressbüchern, falsche Fehlermeldungen bei Kontakten und Ordnern

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/outbox.ts:2647-2670` (`recoverStranded`: „Re-sending an idempotent `set` is safe → back to `pending`“ — gilt nicht für `create`)
- `apps/web/src/sync/engine/outbox.ts:2836-2842` (transienter Wurf → `pending`, erneuter Versand)
- `apps/web/src/sync/engine/conflict.ts:200-215` (`TypeError`/`JmapHttpError`/Timeout ⇒ `retry`)
- Modulkopf `apps/web/src/sync/engine/outbox.ts:1-4` („Every write … is an idempotent JMAP `set` intent“ — für die Create-Familie falsch)
- Typen vorhanden: `packages/jmap/src/types/mail.ts:540` (`EmailCreate.messageId?`), `packages/jmap/src/types/mail.ts:398` (`EmailFilter.header`)

**Problem:** Verliert der Client die Antwort auf ein `create` (Netzabbruch nach Verarbeitung, Timeout,
Tab stirbt → `recoverStranded`), sendet der nächste Pass es erneut. Das Ergebnis ist typabhängig
(Korrektur der Gegenprüfung): `saveDraft` legt einen zweiten Server-Entwurf an (die Destroy-Hälfte
trifft `notFound` → W-32: Erfolg); `createAddressBook` ein zweites Buch; `createContactCard` wird auf
Stalwart abgelehnt, weil die Karte eine clientseitige `uid` trägt (`contact-io.ts:129`), RFC 9610 zwei
Karten gleicher `uid` verbietet und Stalwart das beim Create prüft
(`crates/jmap/src/contact/set.rs`, `assert_is_unique_uid` → `invalidProperties` auf `uid`);
`createMailbox` wird wegen RFC 8621 §2 (keine Geschwister gleichen Namens) abgelehnt — in beiden Fällen
Dead Letter mit Rollback des lokalen Objekts, obwohl es auf dem Server existiert und per Delta wieder
erscheint. JMAP bietet hier KEIN Idempotenz-Mittel: Creation-Ids gelten laut RFC 8620 §5.3 nur „for the
duration of the request“; `ifInState` ist kein Ersatz (`Email/set` bleibt bewusst ungeguardet,
`outbox.ts:209-213`; bei `ContactCard/set` liefe ein `stateMismatch` in die eigene
Refresh-und-Re-Execute-Schleife, `outbox.ts:2770-2790`). Wahrscheinlichkeit: braucht einen
Verbindungsabbruch im Sub-Sekunden-Fenster zwischen Serververarbeitung und Antwort oder einen Tab-Tod
mitten in der Anfrage; der 30-s-Timeout (W-16) ist kein Regelfall. Realistisch auf instabilen
Mobilverbindungen während längerer Compose-Sitzungen, aber selten.

**Auswirkung:** Mobilverbindung bricht nach dem Upload eines Autosaves ab: ein zusätzlicher Draft,
nicht selbstheilend, keine Meldung. Bei Kontakt/Ordner: „Problem“-Hinweis mit Retry/Verwerfen für eine
gelungene Aktion, kurzes Verschwinden des Objekts.

**Lösungsansatz:** Vor dem ERNEUTEN Versand eines Create-Intents (`attempts > 0`) serverseitig prüfen
und bei Treffer als `satisfied` behandeln (inkl. Reconcile der Server-Id): Drafts über clientseitiges
`messageId` in `toEmailCreate` (Typ erlaubt es; RFC 8621 §4.1.3 führt `messageId` als `immutable`,
nicht `server-set`) + `Email/query {filter: {inMailbox: drafts, header: ['Message-ID', id]}}`; Kontakte
über `ContactCard/query {uid}` oder — billiger — die Ablehnung `invalidProperties` auf `uid` mit
„already exists with id …“ als `satisfied` werten und die Id daraus reconcilen; Adressbücher über
`AddressBook/get` + Namensvergleich; Ordner über `Mailbox/get` (Name + Parent). NICHT tragfähig ist der
im Erstbericht als „Mindestens“ genannte Fallback, Creates nach einem geworfenen Fehler zu
dead-lettern: ein `TypeError` unterscheidet nicht zwischen „nie gesendet“ und „Antwort verloren“, und
ein Dead Letter pro Verbindungsabriss würde das Offline-first-Autosave brechen. Unabhängig davon:
Modulkopf und `recoverStranded`-Kommentar korrigieren (S).

**Aufwand:** L (Kommentarkorrektur allein: S)

**Verifikation:** E1/E2 wiederholt: zweiter Pass sendet das `create` erneut (`['S1','S2']`,
`['card1','card2']` gegen den Fake-Port — E2 belegt das Duplikat also nur gegen einen nicht prüfenden
Server). RFC-/Stalwart-Fakten recherchiert. Gegenprüfung: bestätigt, Beschreibung und Lösungsansatz
korrigiert, Aufwand M → L.

(Quelle: SYNC-05)

### R-28 — [MEDIUM] W-15 nur für denselben Tab geschlossen: ein anderer Tab gewinnt den Lock im Moment des `abort()`, und die alte Engine fährt `recoverStranded` nach dem Abort weiter (vgl. W-15)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/engine.ts:435-461` (`stop()`: erst `stopController.abort()` (`:437`), dann `await activeSync`/`replaying`/`maintaining` (`:456-460`))
- `apps/web/src/sync/engine/leader.ts:49-59` (Lock-Callback resolved beim `abort` (`:57`) → Lock frei)
- `apps/web/src/sync/engine/outbox.ts:2708`, `:2747` (`recoverStranded` vor der ersten `signal`-Prüfung in der Zeilenschleife)
- `apps/web/src/sync/engine/engine.ts:1382-1410`, `:1513` (`runReplayCoalesced`/`runReplay` prüfen das Signal nicht; werden aus `runSyncPass` auch nach `stop()` erreicht)
- `apps/web/src/sync/engine/port.ts:110` (kein Abort-Signal am Port; `CallOptions.signal` in `client.ts:39` bleibt ungenutzt — siehe R-94)
- `apps/web/src/app/session/SessionProvider.tsx:67`, `:677` (`SIGN_OUT_STOP_BUDGET_MS = 5000`, `Promise.race` um `stopAllEngines()`)

**Problem:** Die W-15-Korrektur serialisiert nur den Fleet-Wechsel im SELBEN Tab (`teardownRef`-Kette).
Web Locks sind pro Origin: wartet ein zweiter Tab, bekommt er den Lock beim `abort()`, BEVOR `stop()`
den laufenden Replay-Pass abgewartet hat — die laufende Anfrage der alten Engine läuft bis zu 30 s
weiter. Sein erster Pass fährt `recoverStranded` über die Zeile, die der alte Leader noch auf der Leitung
hat → `sendEmail` wird `sendInterrupted`, der Draft `error`, während die Submission Sekunden später
erfolgreich zurückkommt. Spiegelbildlich (V3, per Test belegt): `stop()` während der Delta-Legs → die
alte Engine erreicht danach `runReplayCoalesced` → `replayOutbox` → `recoverStranded` über die
`inflight`-Zeilen des NEUEN Leaders.

**Auswirkung:** Zwei Tabs offen (üblich); im Leader-Tab Re-Auth oder Account-Wechsel (dieselben
Auslöser wie W-15), während ein Send unterwegs ist → `use-send-error-notifier.ts:64-79` zeigt „Senden
fehlgeschlagen“ und öffnet den Entwurf wieder (`openDraft`) — für eine versendete Mail, mit Risiko eines
manuellen Doppelversands. Die Dead-Letter-Zeile verschwindet später (die alte Engine löscht sie per
`deleteIfUnchanged`, `reconcileSend` löscht die drafts-Zeile), das Composer-Fenster bleibt offen.
Fenster = ein Request-Roundtrip. Severity medium wie W-15.

**Lösungsansatz:** Zweiphasiger Stop: ein separates `drainController` abortet zuerst (Replay claimt
nichts mehr), dann `await activeSync/replaying/maintaining`, erst danach `stopController.abort()`
(Lock-Freigabe). Die Wartezeit ist durch W-16 auf ≤ 30 s begrenzt und wird von `stop()` heute schon
bezahlt; für den Sign-out existiert das 5-s-Budget. Zusätzlich `replayOutbox` ganz am Anfang (vor
`recoverStranded`/`drainOwedUndos`) und `runReplay` auf `signal.aborted` prüfen.
Alternative/Ergänzung, die auch den Tab-Crash-Fall entschärft: Claim mit `claimedAt` stempeln und
`recoverStranded` nur Zeilen anfassen, deren Claim älter als `DEFAULT_REQUEST_TIMEOUT_MS` + Marge ist.

**Aufwand:** S–M

**Verifikation:** H1 wiederholt (`send:d1` während der Übergabe `error`/`sendInterrupted`, danach
kommt die Submission erfolgreich zurück); V3 (eigener Test der Gegenprüfung) für den zweiten Pfad,
gleiches Ergebnis. Gegenprüfung: bestätigt, zweiter Pfad per Test belegt.

(Quelle: SYNC-06)

### R-29 — [MEDIUM] `discard()` lässt einen noch `pending` Autosave in der Outbox stehen, wenn der Draft noch keine Server-Id hat — der verworfene Entwurf wird später trotzdem auf dem Server angelegt (race-frei)

**Status:** [x] erledigt

**Kategorie / Bereich:** correctness / Sync + Compose

**Fundstelle(n):**
- `apps/web/src/compose/use-draft-sync.ts:238-251` (`discard`: `deleteDraft`, dann NUR bei `serverEmailId != null` ein `discardDraft` — das die Zeile `draft:<localId>` ersetzen würde; sonst bleibt die alte Zeile unberührt)
- Gegenstück: `apps/web/src/compose/use-draft-sync.ts:317` (`send()` löscht `outboxId(localId)` vor dem Dispatch)
- `apps/web/src/sync/engine/outbox.ts:2120-2127` (`executeIntent` `saveDraft` prüft die drafts-Zeile nicht), `apps/web/src/sync/engine/outbox.ts:2415-2428` (`reconcileDraftSave`: `update` auf fehlender Zeile = No-op)

**Problem:** Neu in der Gegenprüfung gefunden. Ein Draft ohne Server-Id hat typischerweise genau dann
eine wartende `saveDraft`-Zeile, wenn der Server sie noch nicht bekommen hat (offline, Backoff nach
transientem Fehler, Follower-Tab, dessen Leader den Pass noch nicht gefahren hat). `discard()` löscht
die lokale drafts-Zeile, reiht nichts ein und lässt die `pending`-Save-Zeile stehen. Der nächste Replay
sendet den `create`; `reconcileDraftSave` findet keine drafts-Zeile mehr, `deleteIfUnchanged` räumt die
Outbox-Zeile weg — der Server-Entwurf bleibt. Kein Rennen nötig, anders als bei R-25; die beiden Befunde
schließen zusammen den Discard-Pfad vollständig.

**Auswirkung:** Offline tippen (Autosave nach 3 s), „Verwerfen“ klicken, später wieder online → der
verworfene Entwurf erscheint im Drafts-Ordner, auf allen Geräten, ohne Meldung. Dieselbe Folge bei jedem
Backoff-Fenster nach einem transienten Fehler. Nicht Datenverlust, aber „Verwerfen“ wirkt im
Offline-Normalfall nicht.

**Lösungsansatz:** In `discard()` vor `deleteDraft` die Zeile `outboxId(localId)` in einer
`rw`-Transaktion re-lesen und löschen, wenn `status === 'pending'` (wie `send()`, nur bedingt); ist sie
`inflight`, stehen lassen — dann greift die in R-25 vorgeschlagene Behandlung in `reconcileDraftSave`
(„drafts-Zeile fehlt → `discardDraft` für `created.id` einreihen“). Test: V1 (Scratch) plus die
`inflight`-Variante B2.

**Aufwand:** S

**Verifikation:** V1 (eigener Test der Gegenprüfung): Save `pending` → `deleteDraft` ohne Dispatch →
Replay → `setEmails` mit `create: {'draft-d1'}`; drafts-Zeile fehlt, Outbox-Zeile weg, Server-Entwurf
`S_A` angelegt. Rot.

(Quelle: SYNC-13)

### R-30 — [MEDIUM] Zwei Tabs, die gleichzeitig refreshen, löschen sich bei Refresh-Token-Rotation mit Invalidierung gegenseitig das gültige Token aus dem gemeinsamen Store

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Auth)

**Fundstelle(n):**
- `apps/web/src/auth/controller.ts:287-292` (`refresh()`: Single-Flight nur pro `AuthController`-Instanz, also pro Tab; der Kommentar `:279-286` kennt die Rotation, adressiert aber nur Caller im selben Tab)
- `apps/web/src/auth/controller.ts:294-330` (`doRefresh`; `:328` `if (isPermanentRefreshError(error)) await this.tokens.clear()` ohne Prüfung, ob das gespeicherte Token noch das gesendete ist)
- `apps/web/src/auth/token-store.ts:98-102` (`clear()` löscht `SecretName.RefreshToken` bedingungslos)
- `apps/web/src/auth/secret-store.ts:31-33` (alle Tabs eines Profils teilen `waxwing-auth`, ADR-037)

**Problem:** Rotiert der IdP das Refresh-Token und invalidiert das alte (One-Time-Use), gewinnt Tab A,
schreibt RT2; Tab B sendet noch RT1, erhält `invalid_grant` → `tokens.clear()` löscht RT2. `doRefresh`
liest weder nach einem Lock erneut noch vergleicht es vor dem Löschen. Kein Web Lock oder anderes
Serialisierungsmittel in `auth/` (grep). Korrektur der Gegenprüfung: Stalwart ist NICHT betroffen —
seine Tokens sind stateless (Signatur + Ablauf + `credential_version`, kein Register), ein altes
Refresh-Token bleibt nach Ausgabe eines neuen bis zu seinem eigenen Ablauf gültig; der Schaden tritt nur
bei IdPs mit One-Time-Use-Refresh-Tokens ein (OAuth-2.1-Regel für Public Clients; authentik/Keycloak
optional) — genau die externen IdPs, die ADR-006 für Deployments mit Revocation-Bedarf empfiehlt.
Public-Computer-Modus nicht betroffen (Token im RAM pro Tab).

**Auswirkung:** Browser-Neustart mit zwei Waxwing-Tabs (Session-Restore) → beide `restore()` → erster
Request → zwei parallele `refresh_token`-Grants. Bei einem rotierenden IdP: Tab B sofort Re-Auth-Dialog;
Tab A nach Ablauf des Access-Tokens „No refresh token available“ → Re-Auth; nächster Kaltstart ohne
Session. Kein Datenverlust (Replica bleibt), aber Verlust der dauerhaften Anmeldung.

**Lösungsansatz:** `doRefresh` unter `navigator.locks.request('waxwing-auth-refresh', …)` ausführen
(Muster `sync/engine/leader.ts` inkl. Feature-Detection wie in `sync/engine/react.tsx:61`) und nach
Lock-Erwerb das Refresh-Token erneut lesen — weicht es vom zuvor gelesenen ab, den neuen Wert verwenden
statt zu grantieren. Zusätzlich im `invalid_grant`-Pfad compare-and-delete: nur löschen, wenn
`store.get(RefreshToken)` noch gleich dem gesendeten Token ist, sonst einmal mit dem neuen Token
wiederholen. Regressionstest: zwei Controller über einer `SecretStore` mit gleichem `dbName`, Fake-IdP
mit One-Time-Use-Rotation.

**Aufwand:** M

**Verifikation:** Race reproduziert (`auth-verify.test.ts`: Grants `['refresh-1','refresh-1']`,
Ergebnisse `fulfilled/rejected`, gespeichertes Token danach `null`, Kaltstart-`restore()` liefert
`null`); Gegenprobe mit Stalwart-Modell (`auth-verify2.test.ts`): beide Tabs `fulfilled`. Gegenprüfung:
bestätigt, Severity high → medium.

(Quelle: APP-01)

### R-31 — [MEDIUM] OAuth-Re-Auth stasht nur `pathname`; `?account=`, `?q=`, `?label=`, `?full=1` gehen verloren

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/session/SessionProvider.tsx:592` (`writeStored(session(), STASH_ROUTE_KEY, window.location.pathname)` — einzige Schreibstelle)
- `apps/web/src/app/session/SessionProvider.tsx:418-426` (Restore per `history.replaceState`, ohne Search)
- `apps/web/src/app/route/route.ts:120-121` (`?account=` unterscheidet delegierte von eigenen Mailbox-IDs), `apps/web/src/app/route/route.ts:152` (`FULL_PARAM`), `apps/web/src/mail/search/use-search.ts:94` (`q`), `apps/web/src/mail/labels/use-label-view.ts:20` (`label`)

**Problem:** Nach dem Redirect wird exakt der gestashte String wiederhergestellt — ohne Query.
`carryAccount` (`RouterProvider.tsx:36-45`) liest nur aus `window.location.search` der aktuellen Seite
und kann nach dem Redirect nichts rekonstruieren; `useActiveMailAccountId` (`active-account.ts:73-76`)
löst ohne Parameter gegen das eigene Konto auf.

**Auswirkung:** Nachricht in einem freigegebenen Konto (`/mail/a/e1?account=x`) → Token läuft ab →
Re-Auth → zurück auf `/mail/a/e1`: entweder eine **andere** Nachricht des eigenen Kontos mit gleicher
Kurz-ID (B37-Klasse) oder leerer Reading-Pane. Suche/Label-Ansicht werden zur Ordneransicht; FR-AUTH-06
und der Dialogtext versprechen „your place is kept“.

**Lösungsansatz:** `window.location.pathname + window.location.search` stashen; `replaceState`
verarbeitet den Query-String bereits. Test: Reauth-OAuth-Test in `SessionProvider.test.tsx` mit
gesetzter `?account=`-Suche. Dieselbe Änderung deckt R-81 ab.

**Aufwand:** S

**Verifikation:** Code gelesen (`grep STASH_ROUTE_KEY`: eine Schreibstelle; alle vier Parameter
existieren und sind tragend). Gegenprüfung: bestätigt.

(Quelle: APP-03)

### R-32 — [MEDIUM] Ein fehlgeschlagener OAuth-Callback vergisst den manuell eingegebenen Server, sperrt das Serverfeld und meldet ein IdP-`access_denied` als „Something went wrong“ mit Reset-Angebot

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/session/SessionProvider.tsx:397`, `:403`, `:409` (Stash gelesen, **vor** `completeRedirect()` gelöscht; die lokale Variable `stashed` wird im catch nicht benutzt)
- `apps/web/src/app/session/SessionProvider.tsx:467-480` (catch: `goToLogin(targetRef.current ?? fallbackTarget(), errToOnboard(error))`; `targetRef` im Callback-Zweig noch `null`)
- `apps/web/src/app/session/SessionProvider.tsx:116-119`, `:285-294` (`canEditServer` false für `fromProbe`-Targets; `fallbackTarget()` = Pinned / letzter durable Target / Origin)
- `apps/web/src/app/session/SessionProvider.tsx:131-185` (`errToOnboard`: `OAuthCallbackError` fällt auf `onboarding.error.generic`)
- `apps/web/src/app/onboarding/Onboarding.tsx:28-31`, `:99` (`canReset` bei jedem Nicht-Credential-Fehler)

**Problem:** Schlägt der Austausch fehl (IdP-`?error=access_denied`, abgelaufene PKCE-Transaktion,
Token-Endpoint down), landet der Nutzer auf dem Login-Formular des App-Origins (oder eines früheren
`waxwing.connect.target`), ohne editierbares Serverfeld, mit generischem Text und „Reset this
app“-Angebot. Verschärfung aus der Gegenprüfung: `canEditServer === false`, weil das Fallback-Target
`sameOriginTarget()` mit `fromProbe: true` ist — der Nutzer kann den Server ohne Reload nicht einmal neu
eingeben; erst ein Reload (kein Callback mehr, PKCE verbraucht → Probe → `showConnect`) führt zurück.

**Auswirkung:** `allowCustomServer`-Deployment: `mail.example.org` eingeben → OAuth → „Ablehnen“ am
IdP → „Sign in to `<app-host>`“ + „Something went wrong“ + Reset-Button; „Sign in“ startet Discovery
gegen den falschen Issuer. Reset würde die lokale Mailbox löschen.

**Lösungsansatz:** `targetRef.current = stashed` vor `completeRedirect` setzen (oder im catch
`stashed ?? fallbackTarget()`), Stash erst nach erfolgreichem Austausch löschen — analog zum bereits
verschobenen `STASH_PUBLIC_KEY` (`:409-415`). `OAuthCallbackError` in `errToOnboard` auf einen eigenen
Key mappen (`onboarding.error.oauthCallback`, 14 Locales), `access_denied` gesondert benennen, beide in
`CREDENTIAL_ERROR_KEYS`, damit kein Reset angeboten wird. Test: Teil C aus `session-verify.test.tsx`
(Host = `mail.example.org`, `canEditServer === true`). Zusammen mit R-84 (derselbe catch-Block).

**Aufwand:** S

**Verifikation:** Reproduziert mit `allowCustomServer: true`: Stash `mail.example.org`,
`completeRedirect` wirft → Login-Step zeigt `localhost:3000`, `error: onboarding.error.generic`, Stash
gelöscht. Gegenprüfung: bestätigt und verschärft.

(Quelle: APP-04)

### R-33 — [MEDIUM] Escape und der „Close“-Button im Re-Auth-Dialog melden ab (und wischen im Public-Computer-Modus das Replica)

**Status:** [ ] offen

**Kategorie / Bereich:** a11y / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/shell/ReauthDialog.tsx:32-36` (`onClose={cancelReauth}`, `dismissOnBackdrop={false}` — schaltet nur den Backdrop ab)
- `apps/web/src/ui/Dialog.tsx:81-87`, `:90`, `:139` (`requestClose` für Escape (`useDismiss … escape: true`) und den X-`IconButton` mit Label `ui.dialog.close`)
- `apps/web/src/app/session/SessionProvider.tsx:787` (`cancelReauth = endSession(false)`), `:685-688` (ephemer → `wipeReplica`)

**Problem:** Die zwei universellen „Dialog schließen“-Gesten (Escape, X mit Label „Close“) sind hier
die destruktive Aktion „Sign out“ ohne Rückfrage, während der Dialogtext „your place is kept“ verspricht.
Für eine ephemere Session heißt das zusätzlich `wipeReplica`. Kein Test pinnt das Verhalten
(`grep cancel` in `SessionProvider.test.tsx` leer).

**Auswirkung:** Session läuft während des Lesens/Schreibens ab, Dialog erscheint, reflexartiges Escape
oder Klick auf X → abgemeldet; im Public-Computer-Modus alle lokalen Daten der Sitzung weg.
Screenreader-Nutzer, die Escape zum Verlassen von Modals gewohnt sind, trifft es zuerst.

**Lösungsansatz:** `onClose` auf No-op setzen (bzw. Fokus zurück auf „Sign in“), den X-Button ausblenden
(`Dialog` braucht dafür eine `closeOnEscape`/`hideClose`-Prop) und Sign-out nur über den beschrifteten
Button „Sign out“ erlauben; alternativ Escape/X mit einer Bestätigung belegen. Test: Escape im
gerenderten `ReauthDialog` ruft `cancelReauth` nicht.

**Aufwand:** S

**Verifikation:** `ReauthDialog` mit Fake-Session gerendert (`reauth-verify.test.tsx`): Escape →
`cancelReauth` 1×, Klick auf den X-Button (Accessible Name „Close“) → 2×. Gegenprüfung: bestätigt und
verschärft.

(Quelle: APP-06)

### R-34 — [MEDIUM] `fromVCard` verwirft gemappte Properties stumm, wenn der Mapper sie nicht lesen kann — entgegen Kommentar und README

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Lib (jscontact)

**Fundstelle(n):**
- `packages/jscontact/src/from-vcard.ts:595` (`vCardProps = lines.filter((line) => !MAPPED.has(line.name))` — Filter nach NAME, nicht nach „wurde verbraucht“)
- `packages/jscontact/src/from-vcard.ts:453-455` (Kommentar behauptet: „the raw property stays in `vCardProps` instead“)
- `packages/jscontact/src/from-vcard.ts:249-269` (`parseVCardDate` kennt keine `date-time`-/`timestamp`-Form)
- `packages/jscontact/src/from-vcard.ts:312-314`, `:583-585` (`lines.find(...)` für FN/N/UID/KIND/REV — nur die erste Zeile)
- `packages/jscontact/src/convert.test.ts:507-511`, `:124-128` (Fixpunkt-Test bleibt grün, weil Import und Re-Import denselben Verlust haben; das RFC-Beispiel prüft nur `anniversaries[0]`)

**Problem:** Jede Property in `MAPPED` wird aus `vCardProps` ausgeschlossen, unabhängig davon, ob der
Builder etwas daraus gemacht hat. `BDAY`/`ANNIVERSARY`/`DEATHDATE` sind laut RFC 6350 §6.2.5/§6.2.6 vom
Typ `date-and-or-time` (alternativ `text`); die Form `20090808T1430-0500` aus dem RFC-eigenen Beispiel
ist gültig, `parseVCardDate` liefert dafür `undefined` → `continue` — und die Zeile landet NICHT in
`vCardProps`. Dasselbe trifft die zweite `FN`/`N` einer `ALTID`/`LANGUAGE`-Gruppe (RFC 6350 §5.4) und
jede weitere `UID`/`KIND`/`REV`.

**Auswirkung:** RFC 6350 §7.1-Beispiel (`RFC_6350_EXAMPLE` im eigenen Corpus): Hochzeitstag weg, im
Re-Export fehlt die Zeile; `BDAY:19820415T120000Z` + `BDAY;VALUE=text:circa 1800` → `anniversaries:
undefined`, `vCardProps: undefined`; `FN;ALTID=1;LANGUAGE=de` + `FN;ALTID=1;LANGUAGE=en` → nur die
deutsche Form; `UID`/`KIND`/`REV` ×2 → jeweils nur die erste. Der Nutzer sieht „1 Kontakt importiert“,
`ImportResult.skipped` bleibt leer — genau das, was Modulkopf („nothing here is dropped in silence“) und
README (`README.md:47`, „**Nothing is silently dropped.**“) ausschließen.

**Lösungsansatz:** (1) `vCardProps` nach VERBRAUCH filtern: jeder Builder gibt die Zeilen zurück, die
er tatsächlich umgesetzt hat (`Set<ContentLine>`), `convertCard` nimmt den Rest — dann bleiben
unparsbare Daten, ALTID-Alternativen und Duplikate automatisch erhalten. (2) `parseVCardDate` um
`date-time`/`timestamp` (RFC 6350 §4.3.3/§4.3.5: `YYYYMMDDThh[mm[ss]][Z|±hhmm]`) erweitern; mit Zone
als `Timestamp` (nach UTC normalisiert), ohne Zone als `PartialDate` aus dem Datumsteil —
Schreibrichtung siehe R-88. (3) Test über `ALL_CARDS`: jede Eingabezeile taucht entweder in einem
typisierten Feld oder in `vCardProps` wieder auf (Zählung pro Property-Name); der Fixpunkt-Test allein
sieht symmetrischen Verlust nicht.

**Aufwand:** M

**Verifikation:** Scratch-Test (`verify-lib/jscontact.log`): `RFC_6350_EXAMPLE` → `anniversaries`
enthält nur BDAY, `vCardProps` = `gender,lang,lang,geo,key,tz`, Re-Export ohne `ANNIVERSARY`-Zeile;
`parseVCardDate('20090808T1430-0500')` = `undefined`; Fixpunkt `fromVCard(toVCard(first))` trotzdem
gleich `first`. Gegenprüfung: bestätigt.

(Quelle: LIB-01)

### R-35 — [MEDIUM] `PHOTO;ENCODING=b` (vCard 3.0, Google-Export) wird als nackter Base64-String zur „URI“ — kaputtes Bild und relative Anfrage gegen den App-Origin

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Lib (jscontact)

**Fundstelle(n):**
- `packages/jscontact/src/from-vcard.ts:540-558` (`buildMedia`: `uri = line.value.trim()`, `ENCODING`/`TYPE` werden ignoriert)
- `packages/jscontact/src/corpus.ts:69-83` (`GOOGLE_EXPORT` enthält genau diesen Vektor; kein Test in `convert.test.ts` prüft `media` daraus)
- `apps/web/src/contacts/use-contact-photo.ts:33-35` (gibt `media.uri` ohne `blobId` unverändert zurück), `apps/web/src/contacts/ContactDetail.tsx:341` (`<img src>`; ebenso `SenderCard`, `RecipientField`, `ContactForm`)

**Problem:** vCard 3.0 (Google, ältere Apple-Exporte) trägt Binärdaten inline mit `ENCODING=b` +
`TYPE=JPEG` (RFC 2426 §2.4.1). `buildMedia` behandelt den Wert wie in 4.0 als fertige URI — RFC 9555
§2.5.7 („uri property is set to the PHOTO value“) setzt eine 4.0-URI voraus, die `data:`-Form ist RFC
6350 §6.2.4s eigenes Beispiel. (Outlooks `X-MS-CARDPICTURE;ENCODING=b` landet dagegen unverändert in
`vCardProps` — folgenlos.)

**Auswirkung:** Bei Google-Exporten verliert jeder Kontakt mit Foto sein Bild ohne Meldung; pro Render
eine 404-Anfrage `<app-origin>/9j/4AAQ…` an den Hoster; der Wert geht als `media.m1.uri` an den Server
(ob Stalwart einen Nicht-URI-String ablehnt: nicht geprüft).

**Lösungsansatz:** In `buildMedia` (und für `LOGO`/`SOUND` in `toJCardProp`): wenn `ENCODING` ∈
{`b`, `BASE64`} oder `VALUE=binary`, dann `uri = \`data:${mediaType};base64,${value.replace(/\s+/g,
'')}\`` mit `mediaType` aus `MEDIATYPE`, sonst aus `TYPE` (`JPEG`→`image/jpeg`, `PNG`→`image/png`,
`GIF`→`image/gif`; unbekannt → `application/octet-stream`). Test auf `GOOGLE_EXPORT`: `uri` beginnt
mit `data:image/jpeg;base64,`.

**Aufwand:** S

**Verifikation:** Scratch-Test: `fromVCard(GOOGLE_EXPORT).media` = `{ m1: { kind: 'photo', uri:
'/9j/4AAQ…' } }`; App-Pfad gelesen. Gegenprüfung: bestätigt, RFC-Stelle korrigiert.

(Quelle: LIB-03)

### R-36 — [MEDIUM] Quadratisches Backtracking in `TRAILING_PUNCTUATION` (`text.ts`) und `TOKEN_TRIM` (`link-host.ts`): 100 KB feindlicher Text blockieren den Main-Thread 8–9 s

**Status:** [ ] offen

**Kategorie / Bereich:** performance / Lib (mail-html)

**Fundstelle(n):**
- `packages/mail-html/src/text.ts:24` (`TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/`), angewandt in `linkify` auf das ganze URL-Token (`:102`)
- `packages/mail-html/src/link-host.ts:494` (`TOKEN_TRIM = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu`), angewandt in `claimFromWord` (`:683`)
- `packages/mail-html/src/link-host.ts:619-623` (Kommentar: „single O(n) scan“) und `:675-678` (Messung nur mit Prosa, die `PLAIN_WORD` kurzschließt)
- `apps/web/src/mail/MessageView.tsx:517` (`renderPlainText` synchron im Render auf dem Main-Thread; Body-Obergrenze 1 MB `use-parsed-message.ts:27` bzw. 2 MB im Sync `port.ts:61`)

**Problem:** Ein `[Klasse]+$` ohne linken Anker wird an jeder Startposition neu versucht; schlägt `$`
fehl, wird die gesamte Wiederholung zurückgerollt. Für ein Token aus n Satzzeichen mit einem
Fremdzeichen am Ende kostet das O(n²). `prepareLinks` → `gateLink` → `classifyLink` läuft ebenso beim
Laden jeder HTML-Mail.

**Auswirkung:** Eine text/plain-Mail mit einem 100-KB-Token friert den Tab beim Öffnen ~8 s ein, bei
der 1-MB-Grenze extrapoliert ~13 min; eine HTML-Mail mit entsprechendem Ankertext dasselbe beim Laden
(jeder Link) und beim Klick. Die Listenvorschau bleibt unberührt.

**Lösungsansatz:** Beide Trims linear machen:
```ts
const TRAIL = new Set([...'.,;:!?)]}\'"'])
function trimTrailing(url: string): string {
  let end = url.length
  while (end > 0 && TRAIL.has(url[end - 1] as string)) end -= 1
  return url.slice(0, end)
}
```
und in `link-host.ts` `TOKEN_TRIM` in den verankerten führenden Teil (`/^[^\p{L}\p{N}]+/u`, linear) plus
eine rückwärts laufende Schleife mit `/[\p{L}\p{N}]/u`-Test pro Codepoint zerlegen. Regressionstest mit
n=200 k und Zeitschranke (< 100 ms). Ein `useMemo` um `renderPlainText` in `MessageView` kann
mitgehen.

**Aufwand:** S

**Verifikation:** Neu gemessen (Node 24.15): `renderPlainText('https://x.test/' + '.'.repeat(n) +
'a')`: n=10 k → 82 ms, 50 k → 2039 ms, 100 k → 8144 ms; `classifyLink` mit `'a' + '!'.repeat(n) +
'b'`: 93 / 2304 / 9281 ms (Faktor ~25 bei 5×, quadratisch). Kontrollen: 100 KB gutartige Prosa → 2 ms,
1 MB → 10–14 ms, `BARE_HOST` mit `(ab.){40000}!` → 1 ms (linear). Gegenprüfung: bestätigt.

(Quelle: LIB-06)

### R-37 — [MEDIUM] Sprungmarken innerhalb der Mail (`<a href="#top">`) werden gegen den App-Origin aufgelöst, freigegeben und öffnen die App in einem neuen Tab

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Lib (mail-html)

**Fundstelle(n):**
- `packages/mail-html/src/frame.ts:462`, `:470` (`base = iframe.ownerDocument?.baseURI`; `webUrl('#top', base)` → absolute App-URL)
- `packages/mail-html/src/frame.ts:479-484` (Freigabe: `href` überschrieben, `target="_blank"`)
- `packages/mail-html/src/sanitize.ts:894` (`SANITIZE_NAMED_PROPS: true` → Ziel-`id`/`name` werden zu `user-content-*`)
- `apps/web/src/mail/use-link-opener.ts:77-84` (`ok` + `displayHost !== null` → freigeben)

**Problem:** Ein reiner Fragment-Link ist eine Navigation innerhalb des Dokuments, kein Web-Link.
`prepareLinks` unterscheidet das nicht; das Fragment wird gegen die App-URL absolut, `classifyLink`
findet keinen Host-Claim → `ok`, der App-Hook gibt frei. Selbst im Frame könnte der Link nicht treffen:
DOMPurify hat das Ziel in `user-content-top` umbenannt, das Fragment nicht. Keine Regression aus PR #54
(der Abfangpfad vor M3.9 rief `window.open('#top')` mit demselben Ergebnis); kein Test deckt
Fragment-Hrefs MIT Base ab (`link-host.test.ts:464` nur ohne Base, `frame.test.ts:700-708` nur für
den Destroy-Fall).

**Auswirkung:** Ein Klick auf „Zum Seitenanfang“/Inhaltsverzeichnis in einem Newsletter öffnet eine
zweite Waxwing-Instanz in einem neuen Tab (zweiter Sync-Teilnehmer, Leader-Election), statt im Frame zu
scrollen. Sicherheitsseitig folgenlos.

**Lösungsansatz:** In `prepareLinks` Fragment-only-Hrefs (`/^#/`) vor `webUrl` abfangen: `href` auf
`#user-content-<fragment>` umschreiben (DOMPurify-Standardpräfix; alternativ
`SANITIZE_NAMED_PROPS_PREFIX` explizit setzen und hier wiederverwenden), kein `target`, und in
`onClick` solche Links nicht abfangen (Fragment-Navigation im sandboxed Frame ist ohne
`allow-top-navigation` erlaubt). Achtung: der Frame ist auf Inhaltshöhe gestreckt
(`onLoad`/ResizeObserver), das Scrollen muss also das ÄUSSERE Dokument bewegen — im echten Browser
(Chromium und WebKit) prüfen; sonst auf Chromium im `onClick` das Ziel per `getBoundingClientRect` im
äußeren Scroll-Container anfahren (auf Safari kommt kein Klick an, dort bleibt es bei der nativen
Navigation ohne neuen Tab). Test: Fragment-Link bleibt ohne `target`, `onLink` wird nicht gerufen,
`href` zeigt auf das umbenannte Ziel.

**Aufwand:** S

**Verifikation:** Reproduziert unter jsdom mit echtem `sanitize` + `mountMailFrame` + der Gate-Logik
aus `use-link-opener.ts`: `#top` → Gate `http://localhost:3000/#top -> ok keep=false` →
`href=http://localhost:3000/#top target=_blank rel=noopener noreferrer`, Ziel `id=user-content-top`;
auch `href="#"` wird freigegeben. Gegenprüfung: bestätigt.

(Quelle: LIB-07)

### R-38 — [MEDIUM] Der Chord `Shift+o` (Vollbild öffnen) kann nie feuern, und der Registry-Test tarnt das

**Status:** [ ] offen

**Kategorie / Bereich:** correctness, tests / UI (Shortcuts)

**Fundstelle(n):**
- `apps/web/src/shortcuts/registry.ts:249-254` (`keys: ['Shift+o']`, Aktion `nav.full`; eingeführt in `cc3e33c`, 2026-08-19)
- `apps/web/src/shortcuts/keys.ts:42-46` (`parseChord` kennt nur `Mod+`), `apps/web/src/shortcuts/keys.ts:67` (`isLetterChord` verlangt `length === 1`), `apps/web/src/shortcuts/keys.ts:86-88` (Named-Key-Zweig: `event.key === 'Shift+o'`)
- `apps/web/src/shortcuts/keys.ts:108-114` (`formatChord` gibt `['Shift+o']` als einen Chip aus)
- `apps/web/src/shortcuts/registry.test.ts:27-38`, `:53-60` (`eventFor` baut das Event aus `parseChord(chord).key`)
- `apps/web/src/shortcuts/ShortcutHelp.tsx:26-34` (Kommentar benennt selbst, dass die Grammatik kein `Shift+` matcht), `apps/web/src/shortcuts/ShortcutHelp.tsx:105`, `apps/web/src/shortcuts/CommandPalette.tsx:299` (Chip „Shift+o“)

**Problem:** Die Chord-Grammatik (`keys.ts:2-3, 12-13`) schreibt Shift als Großbuchstaben (`'O'`).
`'Shift+o'` fällt in den Named-Key-Zweig; ein echter Tastendruck liefert `key: 'O'` und matcht nie.
`eventFor` in `registry.test.ts` erzeugt `{key: 'Shift+o'}` und befriedigt damit genau diesen Vergleich
— der Test „every chord parses under matchesChord“ ist für diesen Chord vakuos. Cheat-Sheet und Palette
rendern einen Chip mit dem Text `Shift+o`. `e2e/tests/keyboard.spec.ts` drückt kein Shift+O; die
Vollbild-Abdeckung in `read.spec.ts:643-664` läuft ausschließlich über `dblclick`.

**Auswirkung:** „Im Vollbild öffnen“ ist per Chord auf keinem Layout erreichbar; das `?`-Cheat-Sheet
dokumentiert einen Chip, den kein Tastendruck erzeugt. Erreichbar bleibt die Aktion per Doppelklick und
über die ⌘K-Palette — daher medium statt high.

**Lösungsansatz:** `keys: ['O']` gemäß eigener Grammatik. `formatChord` für einen
Großbuchstaben-Chord `['⇧', 'O']` ausgeben (konsistent mit `keyCaps` in `ShortcutHelp.tsx:42-45`).
Test: `eventFor` durch eine explizite Tabelle realer Events ersetzen oder mindestens die Regel „ein
Chord mit `+` beginnt mit `Mod+`“ ergänzen; zusätzlich einen `nav.full`-Fall in
`ShortcutProvider.test.tsx` (Harness vorhanden).

**Aufwand:** S

**Verifikation:** Browsernahe Reproduktion gegen den montierten Dispatcher: `keydown {key:'O',
shiftKey:true}` auf `/mail/inbox/e1` ändert die URL nicht (rot); das synthetische Event
`{key:'Shift+o'}` feuert (grün); `o` ohne Shift → kein `full=1` (grün). Gegenprüfung: bestätigt,
Severity high → medium.

(Quelle: UI-01)

### R-39 — [MEDIUM] Der Escape-Stack sortiert sich bei nicht-memoisiertem `onClose` um — Escape schließt den Dialog unter einem offenen Menü

**Status:** [ ] offen

**Kategorie / Bereich:** react, a11y / UI

**Fundstelle(n):**
- `apps/web/src/ui/internal/useDismiss.ts:54-63` (Cleanup entfernt den Eintrag, Effekt pusht ihn ans Ende; `onDismiss` als Dependency `:63`; Stack per Registrierungsreihenfolge `:20, 56-57`)
- `apps/web/src/ui/Dialog.tsx:25` (Vorgabe „Memoize it“ — die einzige Sicherung), `apps/web/src/ui/Dialog.tsx:81-87`, `:90` (`requestClose` hängt an `onClose`)
- Mindestens 18 `<Dialog>`-Aufrufer mit Inline-Arrow-`onClose` (grep), u. a. `apps/web/src/calendar/CalendarPage.tsx:1043` (Kalender-Sheet mit Menüs pro Kalender in `calendar/CalendarList.tsx:196`), `apps/web/src/files/FilesPage.tsx:842,886,930,940`, `apps/web/src/mail/MessageView.tsx:1305-1346`, `apps/web/src/compose/ComposerWindow.tsx:622,649,679,692`

**Problem:** Wechselt die Identität von `onClose`, läuft Cleanup + Effekt und der Dialog-Eintrag wandert
**über** das darin geöffnete Menü. Passive Effekte laufen kindwärts zuerst, also landet der Dialog auch
dann oben, wenn beide im selben Commit neu registrieren. Das Menü hält seinen Eintrag stabil (`close`
hängt nur an `contextTarget`, `Menu.tsx:245-254`). Im Repo gibt es kein `useLatest`-artiges
Hook-Muster, das die Vorgabe überflüssig machen würde.

**Auswirkung:** Kalender-Sheet auf dem Phone (der Fall, den `tokens.css:239-246` als Grund für
`layer-popover > layer-dialog` beschreibt): „⋯“-Menü eines Kalenders offen, irgendein Re-Render der
`CalendarPage` (liveQuery-Tick, Sync-Status), Escape schließt das ganze Sheet. Bei Dialogen mit
`confirmDiscard` erscheint die Rückfrage, während das Menü noch offen ist.

**Lösungsansatz:** `onDismiss` in `useDismiss` über ein Ref entkoppeln — dasselbe Muster wie
`tRef`/`contextRef` in `ShortcutProvider.tsx:37-40, 72-74` (`useLayoutEffect(() => { ref.current =
onDismiss })`), Stack-Eintrag nur an `[active, closeOnEscape]` binden, `entry.dismiss = () =>
ref.current()`. Gleiches für den Outside-Pointer-Listener (dort nur Re-Subscriptions, kein
Fehlverhalten).

**Aufwand:** S

**Verifikation:** Reproduziert: Menü in Dialog mit Inline-`onClose`, Eltern-State-Bump, Escape → Dialog
und Menü weg (rot); Kontrollfälle ohne Bump und mit memoisiertem `onClose` → nur das Menü schließt
(grün). Gegenprüfung: bestätigt.

(Quelle: UI-02)

### R-40 — [MEDIUM] Escape, Enter und Pfeiltasten während einer IME-Komposition werden als Befehle ausgeführt (Dialog, Palette)

**Status:** [ ] offen

**Kategorie / Bereich:** i18n, a11y / UI

**Fundstelle(n):**
- `apps/web/src/ui/internal/useDismiss.ts:23-29` (`onDocumentEscape` prüft nur `event.key`)
- `apps/web/src/shortcuts/CommandPalette.tsx:200-231` (`onKeyDown`: `Enter`, `ArrowDown/Up`, `Home/End` ohne Kompositionsprüfung)
- Zum Vergleich korrekt: `apps/web/src/shortcuts/ShortcutProvider.tsx:81`, `apps/web/src/shortcuts/keys.ts:55`

**Problem:** Der globale Dispatcher und `matchesChord` ignorieren Kompositions-Keystrokes („IME
first“); Escape-Koordinator und Palette nicht. Browserlage (recherchiert): Firefox ≥ 65 liefert während
der Komposition `key: 'Escape'`/`'Enter'` mit `isComposing: true` → betroffen. Chromium liefert `key:
'Process'`, `keyCode 229` → die `event.key`-Vergleiche greifen nur zufällig nicht — der Grund, warum das
Problem in Chromium-basierten Tests nie auffällt. Safari sendet `keyCode 229`; sein `key`-Wert wurde
nicht verifiziert. `ja` und `zh` werden ausgeliefert (ADR-036). Gleiche Klasse wie R-14
(Empfängerfeld).

**Auswirkung:** In Firefox: Escape in einem Dialog-Textfeld (Kontakt, Termin, Ordner umbenennen,
Palette) schließt den Dialog statt die Komposition zu beenden — mit `confirmDiscard` Rückfrage, sonst
Eingabeverlust. Enter in der Palette führt den aktiven Befehl aus und schließt sie; ArrowDown verschiebt
die aktive Option, während die IME ihre Kandidaten bewegt.

**Lösungsansatz:** In `onDocumentEscape` als erste Zeile `if (event.isComposing || event.keyCode ===
229) return`; in `CommandPalette.onKeyDown` vor dem `switch` dasselbe auf `event.nativeEvent`.
Konsistenzhalber auch `Menu.onMenuKeyDown` (`Menu.tsx:357-388`, dort nur Typeahead, harmlos). Test: die
drei roten Fälle aus der Gegenprüfung übernehmen.

**Aufwand:** S

**Verifikation:** Reproduziert: Escape mit `isComposing` im Dialog-Input → `onClose` aufgerufen
(rot); Enter mit `isComposing` in der Palette → Palette geschlossen (rot); ArrowDown →
`aria-activedescendant` wechselt (rot); Kontrollfall Chromium-Form (`key: 'Process', keyCode: 229`) →
harmlos (grün). Gegenprüfung: bestätigt, Severity medium bleibt.

(Quelle: UI-03)

### R-41 — [MEDIUM] `PushSubscription/set update` wird nie auf `notUpdated` geprüft — eine abgelehnte `emailPush`-Änderung gilt lokal als erledigt und wird nie wiederholt (neue Stelle des W-32-Musters)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness, security (Privatsphäre-Schalter) / UI (Notify)

**Fundstelle(n):**
- `apps/web/src/notify/push-subscribe.ts:318-337` (`applyPlan`, Zweige `renew`/`reconfigure`: Antwort nicht gelesen; einziger Aufrufer von `PushSubscription/set update` für `expires`/`emailPush`)
- `apps/web/src/notify/push-subscribe.ts:247-258` (Registrierung wird anschließend mit `emailPush: wantEmailPush` geschrieben)
- `apps/web/src/notify/push-plan.ts:76-77` (Kommentar benennt `notUpdated` als Gefahr), `apps/web/src/notify/push-plan.ts:104`, `:121` (`contentDiffers` gegen `stored.emailPush`)
- `apps/web/src/notify/push-subscribe.ts:381-389` (`grantedExpiry` liest nur `expires`), `apps/web/src/notify/push-store.ts:98-105` (`PushSubscription/get` echot `emailPush` nicht — ein späterer `get` korrigiert also nichts)
- Zum Vergleich korrekt: `apps/web/src/notify/push-subscribe.ts:428-429` (`submitPushVerification` prüft `updated`), `:368-370` (`create` prüft `created`)

**Problem:** Ein JMAP-`set` kann pro Objekt scheitern, ohne dass der Aufruf wirft. Nach einem
abgelehnten `reconfigure` steht im Datensatz der **gewollte** Zustand, der nächste Lauf plant `keep`.
`renew` heilt sich selbst (der zurückgelesene `expires` bleibt nahe), `reconfigure` nicht. Präzisierung:
der Auslöser `invalidProperties` „No access to one of the accounts“ ist durch die Beschränkung auf das
Primärkonto (`push-reconcile.ts:194-206`) ausgeschlossen; realistisch bleiben
`serverFail`/`forbidden`/transiente Serverfehler und eine abweichende Draft-Revision. Reconcile zeigt
Fehler bewusst nicht an (`use-push-subscription.tsx:43-47`).

**Auswirkung:** (a) Rücknahme abgelehnt: „Absender und Betreff anzeigen“ steht auf aus, der Server hält
die Konfiguration weiter, Betreff und Vorschau reisen weiter durch den Push-Dienst — das Gegenteil von
ADR-017 Amendment Entscheidung 5 („governs the WIRE“). Der Worker blendet den Inhalt aus (`preview:
false`), die Übertragung findet statt. (b) Aktivierung abgelehnt: Schalter sagt „an“, Banner bleiben
inhaltsleer, niemand erfährt warum. Beide Fälle bleiben bis zum nächsten Umschalten bestehen. Selten,
aber dauerhaft, still und auf einem Privatsphäre-Schalter.

**Lösungsansatz:** In `applyPlan` die Antwort lesen: `updated` muss `plan.subscriptionId` enthalten,
sonst `throw new Error(...)` mit dem `notUpdated`-Fehlertext (Pendant zu `setErrorText`).
`ensurePushSubscription` fängt das (`:261-263`) → `failed`, die Registrierung wird **nicht**
geschrieben → der nächste Lauf plant `reconfigure` erneut. Test: den Fall „clears the configuration
server-side“ (`push-subscribe.test.ts:646`) um eine `notUpdated`-Variante ergänzen.

**Aufwand:** S

**Verifikation:** Reproduziert in beide Richtungen: `notUpdated` bei Rücknahme (gespeichert `true`,
gewollt `false`) → `subscribed`, Datensatz `emailPush: false`, zweiter Lauf sendet **kein** `set` (3
rot); Kontrollfall akzeptiertes Update → korrekt (grün). Gegenprüfung: bestätigt.

(Quelle: UI-04)

### R-42 — [MEDIUM] Hintergrund-Tab + Web Push: Live-Kanal und Service Worker melden dieselbe Mail doppelt

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / UI (Notify)

**Fundstelle(n):**
- `apps/web/src/sw/sw.ts:264-273` (`hasVisibleClient` zählt nur `visibilityState === 'visible'`), `apps/web/src/sw/sw.ts:295` (Tag `waxwing:push:delivery`)
- `apps/web/src/notify/push-frame.ts:296-309` (`shouldRaisePushBanner`: nur `visible` unterdrückt)
- `apps/web/src/sync/engine/engine.ts:1675-1690` (`raiseNewMailNotifications`), `:1706-1725` (`isAppInForeground`, Ack-Fenster `FOREGROUND_ACK_MS = 100`, `:261`), `:1993-1995` (`isDocumentForeground` = `visible && hasFocus()`)
- `apps/web/src/notify/notify-model.ts:275-277` (Live-Tag `waxwing:<acc>:mail:<id>`), `apps/web/src/notify/notifier.ts:169` (Live-Banner laufen über dieselbe `registration.showNotification`)

**Problem:** Live-Kanal bannert, wenn kein Tab im Vordergrund ist; Web Push bannert, wenn kein Tab
**sichtbar** ist. Ein geöffneter, verdeckter Tab erfüllt beides. Die Tags unterscheiden sich, kein
Banner ersetzt das andere. ADR-017 Entscheidung 3 formuliert die Absicht („the two must not
double-notify“) und den Mechanismus („suppresses its own when a client is visible“); ADR-010
Entscheidung 2 nennt den Hintergrund-Tab als Hauptfall des Live-Kanals — für einen verdeckten Tab
erfüllt der Mechanismus die Absicht nicht, keine bewusste Entscheidung. ADR-035 betrifft
Mailbox-Subscriptions und hat mit Bannern nichts zu tun.

**Auswirkung:** Mit aktivierter Hintergrund-Benachrichtigung zwei Banner pro Zustellung: das reiche vom
Leader-Tab (Klick öffnet die Nachricht) und das Push-Banner (Klick öffnet den Posteingang); bei Bursts
zwei Zusammenfassungsstrategien nebeneinander.

**Lösungsansatz:** Korrigiert in der Gegenprüfung — der Vorschlag „SW schweigt, sobald irgendein
Client existiert“ wäre eine Regression, weil eingefrorene/gedrosselte Hintergrund-Tabs auf Mobilgeräten
in `clients.matchAll` auftauchen, aber nicht bannern können. Stattdessen **lebender Live-Kanal**: Der
Worker fragt vor `showNotification` alle App-Clients per `postMessage` + `MessageChannel` („live?“) und
wartet begrenzt (~100 ms, Präzedenz `isAppInForeground`/`FOREGROUND_ACK_MS`); ein Leader mit scharfem
Live-Kanal (`notifyArmed`, verbunden) antwortet, ein eingefrorener Tab schweigt → Banner. Billigere
Milderung für die Reihenfolge „Live zuerst“: beide Kanäle nutzen dieselbe Registrierung, der Worker
kann per `registration.getNotifications()` ein frisches `waxwing:<acc>:mail:*`-Banner erkennen und
schweigen. Die Tag-Vereinheitlichung scheidet aus, weil dem Push die `id` fehlt (ADR-017 Amendment,
Entscheidung 7).

**Aufwand:** M (Änderung S, Hand-Verifikation je Plattform gemäß ADR-017 „stays unautomatable“)

**Verifikation:** Pure-Function-Check: `shouldRaisePushBanner(hasVisibleClient: false)` → `show: true`
und `isDocumentForeground()` bei `visibilityState: 'hidden'` → `false` (beide bannern, rot);
Kontrollfall sichtbares, unfokussiertes Fenster → genau ein Banner (grün); ADR-010/017/035 gelesen.
Gegenprüfung: bestätigt, Lösungsansatz korrigiert.

(Quelle: UI-05)

### R-43 — [MEDIUM] Auswahl aus einem Kontextmenü lässt den Fokus auf `<body>` fallen

**Status:** [ ] offen

**Kategorie / Bereich:** a11y / UI

**Fundstelle(n):**
- `apps/web/src/ui/Menu.tsx:302-308` (`activate`: `triggerRef.current?.focus()` — bei `trigger === null` No-op)
- `apps/web/src/ui/Menu.tsx:245-254` (`close` mit `contextTarget`-Fallback)
- Aufrufer mit `trigger={null}`/`contextTarget`: `apps/web/src/mail/FolderTreeView.tsx:332`, `apps/web/src/mail/labels/LabelList.tsx:147`, `apps/web/src/files/FilesPage.tsx:1214-1216`, `apps/web/src/mail/MessageList.tsx:794`

**Problem:** Nach `setOpen(false)` wird das Menü ausgehängt, das fokussierte `menuitem` verschwindet,
`activeElement` wird `<body>`. Öffnet `onSelect` einen Dialog, liest dessen Fokusfalle
`previouslyFocused = body` (`useFocusTrap.ts:32`), sodass auch der Dialog-Schluss nicht zurückführt.

**Auswirkung:** Shift+F10 auf einem Ordner → „Umbenennen…“ → Speichern → Fokus auf `<body>`, nächster
Tab beginnt am Dokumentanfang; Screenreader verliert die Position. Gleiches für Labels, Dateien,
Nachrichtenliste.

**Lösungsansatz:** Gemeinsame `restoreFocus()` aus `close` herausziehen und in `activate` **vor**
`item.onSelect()` aufrufen.

**Aufwand:** S

**Verifikation:** Reproduziert für Klick **und** Enter auf ein Item eines reinen Kontextmenüs:
`document.activeElement === body` (2 rot); Kontrollfall Escape → Fokus auf der Zeile (grün).
Gegenprüfung: bestätigt.

(Quelle: UI-06)

### R-44 — [MEDIUM] Die Account-&-Security-E2E-Suite wurde beim B25-Umbau überschrieben, nicht verschoben; `security.spec.ts` läuft im Gate doppelt

**Status:** [ ] offen

**Kategorie / Bereich:** tests / Infra (E2E)

**Fundstelle(n):**
- `e2e/playwright.write.config.ts:15-17` (Kommentar „Account & security (X-1..X-6) …“ + `'**/security.spec.ts'`)
- `e2e/playwright.read.config.ts:30` (`'**/security.spec.ts'`, seit `e09ac41`)
- `e2e/tests/security.spec.ts` (heute: drei B25-Tests, Z. 41-196; `seedReadMail()` im `beforeEach`)
- `docs/adr/*stalwart-self-service*.md:123` („plus one live E2E (`e2e/tests/security.spec.ts`)“ — zeigt auf Tests, die es nicht mehr gibt)
- `scripts/verify-e2e.mjs:117-118` (führt beide Suiten aus)
- Historie: `b3cb2d9` legte fünf Tests „Settings → Account & security“ an, `81ff67f` pflegte sie („five write-suite tests“), `e09ac41` ersetzte den Dateiinhalt komplett (250+/239−) und trug die Datei zusätzlich in die Read-Config ein, `7559518` änderte nur noch die B25-Fassung

**Problem:** Der Umbau hat die fünf X-Tests überschrieben statt verschoben; Commit-Text und Plan-Diff
von `e09ac41` erwähnen sie nicht — keine dokumentierte Absicht (`git log --all -S "really
authenticates"` trifft genau `b3cb2d9` und `e09ac41`). Es gibt keinen Test mehr, der gegen den echten
Stalwart ein App-Passwort anlegt, damit authentifiziert und es widerruft, oder die Account-Locale
schreibt und zurückliest. Was bleibt, sind `apps/web/src/settings/stalwart-client.test.ts` (22 Tests,
Wire-Shapes gegen einen Fake) und `security.test.tsx` (27, jsdom); in `packages/jmap` gibt es keinen
Integrationstest zu `x:Account`. Gleichzeitig laufen die drei B25-Tests im Gate zweimal (Read- und
Write-Suite, je mit Reseed und Login), und Kommentar und ADR beschreiben Tests, die nicht existieren.

**Auswirkung:** Eine Regression im App-Passwort-Pfad (`x:Account/set` mit `credentials`, Widerruf,
Locale-Schreibpfad) gegen den echten Server bleibt vom Gate unentdeckt — obwohl ADR und
`README.md:109-110` („249 end-to-end tests“) diese Abdeckung darstellen. Der Doppellauf kostet pro Gate
ein bis zwei Minuten ohne Aussagegewinn.

**Lösungsansatz:** `git show 81ff67f:e2e/tests/security.spec.ts` (letzte gepflegte Fassung) als
`e2e/tests/account-security.spec.ts` wiederherstellen und in der Write-Config eintragen (sie mutiert
Server-Zustand); `security.spec.ts` nur in der Read-Config belassen; Kommentar in
`playwright.write.config.ts:15-16` und ADR-Zeile 123 korrigieren. Wächter: ein `*.source.test.ts`, das
die `testMatch`-Listen der Gate-Configs parst und einen Spec-Namen in mehr als einer Config meldet — mit
Ausnahme von `playwright.webkit.config.ts:37`, das `read.spec.ts` bewusst ein zweites Mal auf der
anderen Engine fährt.

**Aufwand:** S (Wiederherstellen) bis M (falls die alten Tests an die heutige Settings-Navigation
anzupassen sind)

**Verifikation:** `git show --stat` der vier Commits, `git log -S`, grep nach den alten Titeln (im
heutigen Baum kein Treffer außer dem Kommentar in der Write-Config), beide Configs, `verify-e2e.mjs`,
ADR gelesen; E2E nicht ausgeführt. Gegenprüfung: bestätigt.

(Quelle: INFRA-01)

### R-45 — [MEDIUM] Die Reverse-Proxy-Rezepte in `docs/deployment.md` §2 proxyen die OAuth-Pfade nicht — der primäre „Sign in“-Button ist auf diesem Deployment-Pfad tot

**Status:** [ ] offen

**Kategorie / Bereich:** correctness (Betreiber-Doku) / Infra

**Fundstelle(n):**
- `docs/deployment.md:194-212` (nginx: `location /jmap/`, `/auth/`, `/.well-known/jmap`; alles andere `try_files … /index.html`)
- `docs/deployment.md:265-277` (Caddy: dieselben drei Pfade)
- `docs/deployment.md:447-458` („Verifying a deployment“ prüft nur `/.well-known/jmap`)
- `apps/web/vite.config.ts:25-45` (`demoProxy`: `/jmap`, `/.well-known`, `/auth`, `/login`, `/api`, `/logo` — „the exact set of paths Stalwart needs … verified empirically against v0.16.11“); `e2e/mount-server.mjs:55` (`PROXY_PATHS`, identische Liste)
- `apps/web/src/app/config.ts:58` und `apps/web/public/config.json` (Default `auth: ["oauth", "basic"]` → OAuth ist der primäre Button)
- `apps/web/src/app/session/target.ts:24-32` (Issuer = Origin der Session-URL), `apps/web/src/auth/controller.ts:473` (Discovery als `oauth2`), `apps/web/src/auth/oauth.ts:149-155` (RFC-8414-Discovery `GET <origin>/.well-known/oauth-authorization-server`)
- `docs/implementation-plan.md:691-694` (protokollierte Stalwart-Antwort: `authorization_endpoint=/login`, `token_endpoint=/auth/token`, `registration_endpoint=/auth/register`)

**Problem:** Mit dem nginx-Rezept geht der Discovery-Fetch per `try_files` an `index.html` —
oauth4webapi bekommt HTML statt JSON und bricht ab; selbst mit korrekter Discovery würde der Redirect
auf `/login` die Waxwing-SPA statt Stalwarts Login-Seite laden, deren POST an `/api/auth` liefe
ebenfalls ins SPA-Fallback. `grep -i oauth docs/deployment.md` ist leer; nirgends steht, dass der
Betreiber Pfade ergänzen muss. `docs/configuration.md:64-83` beschreibt OAuth als den einzigen Pfad mit
zweitem Faktor und sagt, dass die Liste nicht gegen den Server geprüft wird. Der Read-E2E
`read.spec.ts:272` („OAuth login reaches the inbox“) läuft genau über die vollständige Proxy-Menge.

**Auswirkung:** Betreiber setzt §2 wörtlich um und lässt die Default-`config.json` → jeder Nutzer sieht
den prominenten „Sign in“-Button, der mit „the server offers no secure sign-in“ scheitert; nur der
eingeklappte Passwort-Pfad funktioniert. Konten mit 2FA können sich auf diesem Pfad gar nicht anmelden.

**Lösungsansatz:** In beiden Rezepten die Pfadmenge aus `demoProxy`/`PROXY_PATHS` übernehmen: nginx
`location /jmap/`, `location /auth/`, `location /.well-known/` (Präfix statt `/.well-known/jmap`),
`location /login`, `location /api/`, `location /logo`; Caddy `handle /.well-known/*`, `handle
/login*`, `handle /api/*`, `handle /logo*`. Ein Satz dazu, dass dies Stalwarts OAuth-Flow ist und
`auth: ["basic"]` die Alternative, wenn der Betreiber ihn nicht durchreichen will. In „Verifying a
deployment“ eine `curl`-Zeile für `/.well-known/oauth-authorization-server` ergänzen. Ein
`*.source.test.ts`, das `deployment.md` gegen `PROXY_PATHS` in `mount-server.mjs` prüft, fängt die
nächste Drift.

**Aufwand:** S

**Verifikation:** Code-Pfad Issuer → Discovery → Authorization-URL gelesen; Plan-Protokoll der
Stalwart-Discovery; Rezepte gegen `demoProxy`/`PROXY_PATHS` verglichen; der Erstbericht hatte
zusätzlich das Fixture abgefragt (gleiche Endpunkte). Gegenprüfung: bestätigt.

(Quelle: INFRA-02)

### R-46 — [LOW] Der LRU-Touch in `fetchBody` lässt die Inline-Bild-Pipeline beim Öffnen ein zweites Mal anlaufen (Doppel-Emission der liveQuery; Blob-URLs verworfen, Blobs erneut gelesen)

**Status:** [x] erledigt
Beide Teile des Lösungsansatzes umgesetzt: `useInlineImages` hängt an einem Inhalts-Fingerprint
(`body.id` plus `cid:blobId:type` je Teil), und der LRU-Touch in `fetchBody` wird übersprungen, wenn
der Stempel jünger als 60 s ist. Kleine Abweichung: statt `parts` über ein Ref zu lesen, wird `parts`
selbst per `useMemo` am Fingerprint stabilisiert — der Effekt behält dadurch eine ehrliche
Abhängigkeitsliste, und ein Ref, das im Render beschrieben wird, entfällt.

**Kategorie / Bereich:** react / Mail

**Fundstelle(n):**
- `apps/web/src/sync/engine/engine.ts:963-968` (`db.emailBodies.update(…, { lastAccessedAt })` bei jedem `fetchBody` auf eine gecachte Zeile — bewusst unbedingt, Kommentar dort)
- `apps/web/src/sync/react.tsx:130-136` (`useReplicaQuery` = `useLiveQuery`, keine Ergebnis-Dedupe), `apps/web/src/sync/react.tsx:203-205` (`useEmailBody`)
- `apps/web/src/mail/useInlineImages.ts:24` (`parts` per `useMemo` an `body`-Identität), `apps/web/src/mail/useInlineImages.ts:26-76` (Effekt an `[body, parts, fetchBlob]`; Cleanup `:72-75` revoked alle Object-URLs, `setReady(false)` in `:48`)
- `apps/web/src/mail/useMessageBody.ts:43-62` (`fetchBody` bei jedem Mount), `apps/web/src/mail/MessageView.tsx:509-512` (`sanitized` nur bei `ready`), `:1258-1270` (Skeleton, solange `bodyHtml === null`)

**Problem:** Beim Öffnen einer gecachten Nachricht laufen `useEmailBody` (liveQuery-Read) und
`fetchBody` (`get` → `update`) parallel an. Die `readwrite`-Transaktion des Touch kann erst nach der
`readonly`-Transaktion der liveQuery starten, also kommt zuerst die Emission der alten Zeile, dann nach
dem Commit eine zweite, inhaltsgleiche mit neuer Identität. `useInlineImages` startet daraufhin neu:
`cancelled = true`, bereits erzeugte URLs werden revoked, alle `cid:`-Blobs erneut aus IndexedDB
gelesen. Die Gegenprüfung hat das Body → Skeleton → Body-Flackern unter realistischem Timing NICHT
reproduziert (die zweite Emission traf ein, BEVOR der erste Lauf eine URL erzeugt hatte — Abbruch und
Neustart); belegt sind ein abgebrochener Lauf und doppelte IndexedDB-Reads pro Öffnen. Deshalb medium →
low.

**Auswirkung:** Pro Öffnen einer Mail mit Inline-Bildern ein verworfener Pipeline-Lauf, doppelte
Blob-Reads und ein IndexedDB-Write; bei sehr schnellen Blob-Reads möglicherweise ein einmaliges Flackern
plus kurz deaktiviertes Reply/Forward (`bodyReady`-Gate). Ohne Inline-Bilder nur eine überflüssige
Emission.

**Lösungsansatz:** Effekt in `useInlineImages` an einen Inhalts-Fingerprint statt an Identitäten
binden: `const key = body ? \`${body.id}|${parts.map(p => \`${p.cid}:${p.blobId}\`).join('|')}\` :
''`, Deps `[key, fetchBlob]`, `parts` über ein Ref lesen. Ergänzend in `fetchBody` den Touch
überspringen, wenn `existing.lastAccessedAt` jünger als z. B. 60 s ist (der Kommentar „unconditional“
bezieht sich auf den Early-Return-Fehler von vor M3.9, nicht auf eine Frischegrenze). Regressionstest:
Body-Zeile mit `cid`-Part, nach `ready` ein `emailBodies.update({ lastAccessedAt })` →
`revokeObjectURL` darf nicht gerufen werden.

**Aufwand:** S

**Verifikation:** `zz-verify-misc.test.tsx` „MAIL-03/A“ (direkter Touch nach `ready`): revoke 2×,
create 4× bei zwei Parts; `zz-verify-inline.test.tsx` (reale Reihenfolge, IndexedDB-gestützter Fetcher):
1 Bild → Fetcher > 1× gerufen (Neustart), `ready`-Verlauf `[false,false,false,true]` ohne Flackern; 3
Bilder und In-Memory-Fetcher → nur ein Lauf. Gegenprüfung: abgeschwächt, medium → low.

(Quelle: MAIL-03)

### R-47 — [LOW] Shift+↓/↑ ohne Anker lässt die Startzeile aus dem Bereich fallen

**Status:** [x] erledigt
Wie vorgeschlagen im Key-Handler: bei `selection.anchor === null` zuerst `selectOne` auf die
fokussierte Zeile, dann `range` auf das Ziel. Die Shift-Klick-Semantik im Reducer bleibt unangetastet
(`message-selection.test.ts:34` bleibt grün).

**Kategorie / Bereich:** a11y / Mail

**Fundstelle(n):**
- `apps/web/src/mail/MessageList.tsx:509-525` (`range` mit `id: destId`, ohne die fokussierte Zeile als Anker zu setzen)
- `apps/web/src/mail/message-selection.ts:49` (`anchor === null` → `single(action.id)`; `message-selection.test.ts:34` pinnt das für Shift-KLICK so — der Fix gehört daher in den Handler)
- `apps/web/src/mail/list-keys.ts:51` (Cheat-Sheet: „Extend the selection“)

**Problem:** APG-Grid: Shift+↓ erweitert die Auswahl um die nächste Zeile — die Zeile, auf der der Fokus
steht, gehört dazu. Ohne bestehenden Anker wird nur die Zielzeile selektiert; erst der zweite Shift+↓
bildet einen Bereich.

**Auswirkung:** Fokus auf Zeile 1, Shift+↓ → „1 selected“, Zeile 2 markiert, Zeile 1 nicht. Wer drei
Zeilen per Shift+↓↓ markieren will, bekommt zwei — und die erste fehlt.

**Lösungsansatz:** Im Key-Handler bei `selection.anchor === null && id !== undefined` zuerst
`dispatchSelection({ type: 'selectOne', id })`, dann `range` auf `destId`. Shift-Klick-Semantik bleibt
unverändert.

**Aufwand:** S

**Verifikation:** `zz-verify-list.test.tsx` „MAIL-08“: Reducer `range` ohne Anker → `['e2']`; Grid mit
3 Zeilen, Fokus auf Zeile 1, `Shift+ArrowDown` → „1 selected“, Zeile 1 `aria-selected="false"`, Zeile
2 `true`. Gegenprüfung: bestätigt.

(Quelle: MAIL-08)

### R-48 — [LOW] Die Snooze-Weckzeiten sind ein blinder Read-Modify-Write auf einem Render-Snapshot — der zweite Schreiber verliert die Weckzeit des ersten, die Mail bleibt dauerhaft ausgeblendet

**Status:** [x] erledigt
`updateSnoozeMap(db, accountId, fn)` als Dexie-`rw`-Read-Modify-Write in `repo.ts`, analog
`updatePinnedMailboxes`; `snooze` und `wake` gehen darüber. NICHT umgesetzt und bewusst verworfen:
der zusätzlich vorgeschlagene Waisen-Sweep (Ids mit `$snoozed` ohne Map-Eintrag beim Sweep wecken).
Das Keyword ist Server-Zustand und synchronisiert über alle Geräte, die Weckzeit liegt in
`localPrefs` und tut das nicht — auf jedem zweiten Gerät ist deshalb JEDE auf einem anderen Gerät
gesnoozte Mail eine „Waise". Der Sweep hätte sie dort sofort geweckt und die Entfernung des Keywords
an den Server geschickt, also den Snooze überall aufgehoben. Das wäre ein schlimmerer Fehler als der
behobene.

**Kategorie / Bereich:** correctness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/use-snooze.ts:55-76` (`setPref(…, withSnoozed(snoozed, …))` / `withoutIds(snoozed, …)` mit dem `snoozed` des letzten Renders)
- `apps/web/src/sync/repo.ts:831-839` (`setPref` = blinder `put`); Vorbild `apps/web/src/sync/repo.ts:846-857` (`updateLabels`), `:884-894` (`updatePinnedMailboxes`, Dexie-`rw`-Read-Modify-Write)
- Filter, der die Mail ausblendet: `apps/web/src/sync/engine/backfill.ts:57` (`notKeyword: $snoozed`)

**Problem:** Das Keyword geht über die Outbox (pro Nachricht korrekt), die Weckzeit aber über einen
`setPref` mit dem Map-Stand des Renders. Zwei Schreiber auf demselben Stand → last writer wins, eine
Weckzeit ist weg. Da der Waker nur Ids aus der Map weckt, bleibt das `$snoozed`-Keyword an der Mail und
sie ist in keinem Ordnerfenster mehr sichtbar. Das Cross-Tab-Fenster ist die liveQuery-Latenz von
`useLocalPrefOptional` (`react.tsx:430-438`) — klein, aber derselbe Mechanismus greift auch im selben
Tab (zweiter Aufruf vor der Emission, Waker-Tick während eines Snooze).

**Auswirkung:** Tab A snoozt e1, Tab B weckt im selben Moment e0 (Waker, Minutentakt) mit veraltetem
Stand → e1 verschwindet aus der Map, kommt nie zurück, taucht nur noch in der Suche auf. Zeitfenster
klein, Schaden eine „verlorene“ Mail.

**Lösungsansatz:** `updateSnoozeMap(db, accountId, fn)` als Dexie-`rw`-Read-Modify-Write in
`repo.ts`, analog `updatePinnedMailboxes`; `snooze`/`wake` darauf umstellen. Der Waker sollte
zusätzlich Ids mit `$snoozed` ohne Map-Eintrag (Waisen) beim Sweep wecken.

**Aufwand:** S

**Verifikation:** `zz-verify-misc.test.tsx` „MAIL-09“: zwei `snooze`-Aufrufe im selben `act` →
`dispatch` 2×, gespeicherte Map `['e2']`. Gegenprüfung: bestätigt (Vorbild-Fundstellen korrigiert).

(Quelle: MAIL-09)

### R-49 — [LOW] `useSnoozeWaker` hängt an instabilen Abhängigkeiten: Interval wird bei jedem Shell-Render abgebaut und neu gesetzt, `check()` läuft pro Render

**Status:** [x] erledigt
`coerceSnoozeMap` hängt jetzt per `useMemo` am Roh-Pref-Wert, und der Waker ist in zwei Effekte
geteilt: einer reagiert auf Datenänderungen (`[snoozed, wake]`), einer hält das Intervall
(`[wakeDue]`, das über ein Ref liest). Zusammen mit R-48 in einem Commit — die entscheidende Hälfte
der Stabilisierung ist, dass `snooze`/`wake` durch den Read-Modify-Write gar nicht mehr über
`snoozed` schließen.

**Kategorie / Bereich:** react / Mail

**Fundstelle(n):**
- `apps/web/src/mail/snooze.ts:25-32` (`coerceSnoozeMap` erzeugt immer ein neues Objekt), `apps/web/src/mail/use-snooze.ts:40`, `:66`, `:75` (`snooze`/`wake` hängen daran), `:90-98` (Effekt an `[snoozed, wake]`)

**Problem:** `useLocalPrefOptional` liefert zwischen Emissionen eine stabile Referenz,
`coerceSnoozeMap` macht daraus pro Render ein frisches Objekt. `setInterval`/`clearInterval` und
`dueIds` laufen bei jedem Render der `AppShell`, in jedem Tab. Kein Leak (Cleanup vorhanden). Der im
Erstbericht vermutete Doppel-Dispatch bleibt unbelegt und wäre idempotent.

**Auswirkung:** Unnötige Arbeit im Shell-Render-Pfad; ein zusätzlicher `wake`-Dispatch im Fenster
zwischen `setPref` und liveQuery-Emission ist möglich, aber harmlos.

**Lösungsansatz:** `coerceSnoozeMap` per `useMemo` an den Roh-Pref-Wert binden (oder an
`JSON.stringify(raw)`, wie `usePinnedMailboxes` an `pref.join(',')`), und den Waker-Effekt nur an
`[wake]` bzw. einen `useRef`-Spiegel der Map hängen.

**Aufwand:** S

**Verifikation:** `zz-verify-misc.test.tsx` „MAIL-10“: `renderHook(useSnoozeWaker)`, zwei
`rerender()` ohne Datenänderung → `window.setInterval` +2, `dispatch` 0×. Gegenprüfung: bestätigt.

(Quelle: MAIL-10)

### R-50 — [LOW] Zwei hardcodierte Interpunktions-Muster im JSX: `": "` nach „An“ und `" (n)"` in der Anhangs-Überschrift

**Status:** [ ] offen

**Kategorie / Bereich:** i18n / Mail

**Fundstelle(n):**
- `apps/web/src/mail/MessageView.tsx:1084` (`{t('reading.to')}: {…}`)
- `apps/web/src/mail/AttachmentList.tsx:225` (`{t('reading.attachments.title')} ({items.length})`)

**Problem:** Doppelpunkt und Klammer-Zähler stehen außerhalb der Übersetzung; Französisch setzt vor dem
Doppelpunkt ein geschütztes Leerzeichen, ein Zähler gehört in einen `{{count}}`-String. Die Suchchips
zeigen das richtige Muster bereits (`en/common.json:1408` `"to": "To: {{value}}"`). Grep über
`apps/web/src` findet app-weit nur diese zwei Vorkommen.

**Auswirkung:** Nur typografisch; keine funktionale Folge.

**Lösungsansatz:** `t('reading.toLine', { recipients })` bzw. `t('reading.attachments.titleCount', {
count })` in allen 14 Bundles; `node scripts/check-locales.mjs` meldet fehlende Keys.

**Aufwand:** S

**Verifikation:** Grep über `apps/web/src/**/*.tsx` nach `')}: {` und `} ({…length})`; genau diese
zwei Treffer. Gegenprüfung: bestätigt.

(Quelle: MAIL-11)

### R-51 — [LOW] Ein fehlgeschlagenes Nachladen (offline) hinterlässt eine unbehandelte Rejection und sperrt den Guard bis zum Fensterwechsel

**Status:** [x] erledigt
Guard-Freigabe im `catch` umgesetzt (nur der eigene Stempel wird geräumt). NICHT umgesetzt: die
optionale Zeile `list.loadMoreFailed` unter der Liste — das Nachladen ist ein Prefetch, der beim
nächsten Scrollen an den Rand von selbst erneut anläuft, und eine dauerhafte Fehlerzeile für einen
Vorgang, den niemand ausgelöst hat, wäre lauter als der Fehler.

**Kategorie / Bereich:** robustness / Mail

**Fundstelle(n):**
- `apps/web/src/mail/use-message-list.ts:121-123` (`void engine?.loadMoreFor(key, PAGE_SIZE)` — kein `catch`)
- `apps/web/src/mail/MessageList.tsx:425-426` (`requestedAtRef.current = ids.length` vor `loadMore()`, nie zurückgesetzt)
- `apps/web/src/sync/engine/engine.ts:686-688` → `apps/web/src/sync/engine/backfill.ts:206-251` (`loadMore` ohne `try/catch`, `port.queryEmailsWithEnvelopes` wirft offline)

**Problem:** In der Gegenprüfung von R-01 gefunden. Scheitert das Nachladen (offline, Serverfehler,
Abbruch), bleibt `ids.length` unverändert und `requestedAtRef.current === ids.length` — jeder weitere
Scroll ans Ende bleibt am Guard hängen. Die Rejection geht unbehandelt in die Konsole; es gibt keinen
`unhandledrejection`-Handler (`dispatch-failure.ts:11`).

**Auswirkung:** Offline ans Ende scrollen (nichts passiert, kein Hinweis), wieder online, erneut
scrollen → weiterhin nichts, bis der Ordner gewechselt wird — wo R-01 den nächsten Versuch blockieren
kann. Aus Nutzersicht: „Nachladen geht manchmal nicht.“

**Lösungsansatz:** Zusammen mit R-01: `loadMore` im Hook ein Promise zurückgeben lassen, im Effekt
`.catch(() => { requestedAtRef.current = '' })` (oder `.finally` mit Prüfung, ob `ids.length` gewachsen
ist), damit der nächste Scroll erneut anfragt; optional eine Zeile `list.loadMoreFailed` unter der
Liste, analog zu `list.stale`.

**Aufwand:** S

**Verifikation:** Code gelesen (`loadMore` wirft; kein `catch` im Hook; kein Guard-Reset); nicht mit
Test reproduziert. Regressionstest-Skizze: `loadMoreFor` einmal rejecten lassen, danach `lastIndex`
erneut ans Ende setzen → zweiter Aufruf erwartet.

(Quelle: MAIL-12)

### R-52 — [LOW] `useDraftOpener` läuft im `ActiveAccountScope`, der Composer außerhalb: ein Entwurf aus einem geteilten Drafts-Ordner wird beim Schließen als Kopie im eigenen Konto angelegt, beim Verwerfen nicht gelöscht

**Status:** [x] erledigt
Erste Variante des Lösungsansatzes umgesetzt (Entwürfe fremder Konten gar nicht als Entwurf öffnen).
Die Prüfung sitzt in `useDraftOpener` selbst (`canEdit`, Vergleich mit `connected.accountId`) statt in
`MessageList`, damit beide Aufrufer — Liste und Lesebereich — dieselbe Antwort bekommen; die zweite
Variante (`getActiveReplica()` im Opener) wäre falsch gewesen: die Email-Id des geteilten Kontos steht
nicht in der Replica des Primärkontos, das Öffnen wäre stillschweigend wirkungslos geworden.

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/mail/MessageList.tsx:438-441` (jede `$draft`-Zeile → `draftOpener.open`, ohne `isPersonal`/`isReadOnly`-Prüfung), `apps/web/src/mail/Conversation.tsx:165-169`
- `apps/web/src/compose/use-draft-opener.ts:22-27` (`useReplicaOptional()` → verschachtelter Provider), `apps/web/src/compose/use-draft-opener.ts:71-94` (`adoptServerDraft` unter dieser `accountId`)
- `apps/web/src/app/shell/MailScreen.tsx:539`, `apps/web/src/mail/ActiveAccountScope.tsx:29-44` (bei ≥ 1 geteiltem Konto verschachtelter `ReplicaProvider` auf das aktive Konto; der Opener kommt in der Aufteilung im Header `:13-18` nicht vor)
- `apps/web/src/compose/use-draft-sync.ts:131-139`, `:228-230` (Composer = äußerer Provider = Primärkonto, bewusst; `AppShell.tsx:192-202`)

**Problem:** Mit mindestens einem geteilten Konto öffnet die Liste einen Drafts-Eintrag des geteilten
Kontos C: `getDraftByServerId(db, C, …)`/`putDraft({accountId: C, serverEmailId})`. Das Composer-Fenster
flusht mit `accountId = Primär`: `getDraft(db, Primär, localId)` → `undefined` → neue Zeile ohne
`priorServerId` → `Email/set create` in den *eigenen* Drafts-Ordner. Discard findet keine
`serverEmailId` → kein `discardDraft`; die Zeile unter C bleibt als Waise. ADR-020 (kein Send-as)
begründet den Composer auf dem Primärkonto, nicht das Öffnen fremder Entwürfe.

**Auswirkung:** „Entwurf aus Carols Ordner öffnen, korrigieren, schließen“ erzeugt eine Kopie in Alices
Drafts und lässt Carols Original unberührt — die Fehlklasse, die der Kommentar in `adoptServerDraft`
(2026-08-22) für das Einzelkonto gerade beseitigt hat.

**Lösungsansatz:** Bis Send-as (ADR-020) Drafts fremder Konten gar nicht als Entwurf öffnen (in
`MessageList.open` auf `isPersonal` des aktiven Kontos prüfen, sonst lesen), oder `useDraftOpener` die
Replica so auflösen wie der Composer (`getActiveReplica()`).

**Aufwand:** S–M

**Verifikation:** Code gelesen (Mount-Hierarchie, Provider-Auflösung, Aufrufer); nicht reproduziert
(braucht die Shell mit zwei Konten). Gegenprüfung: bestätigt (Code).

(Quelle: COMP-08)

### R-53 — [LOW] `oversized` zählt fehlgeschlagene Uploads mit — ein Fehl-Chip sperrt Senden (und weiteres Anhängen) mit dem Label „zu groß“, entgegen dem Kommentar in `ComposerWindow`

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/use-attachment-upload.ts:420-426` (`oversized`), `apps/web/src/compose/use-attachment-upload.ts:282-287` (`addFiles`-Summe)
- `apps/web/src/compose/attachment-upload.ts:97-105` (`totalAttachmentBytes` ohne Statusfilter)
- `apps/web/src/compose/ComposerWindow.tsx:117-121` („an errored chip must not wedge it“), `:158-165`

**Problem:** `uploadsInFlight` filtert korrekt auf `uploading`, die Byte-Summe nicht. Ergänzung der
Gegenprüfung: `addFiles` rechnet mit derselben Summe, also blockiert ein Fehl-Chip auch das Anhängen
weiterer Dateien („totalTooLarge“-Toast).

**Auswirkung:** Cap 25 MB; 20 MB erfolgreich; zweiter Upload 10 MB scheitert am Netz → Chip rot; Summe
30 > 25 → Send deaktiviert mit „Attachments too large“ und jede weitere Datei wird als „zu groß“
abgewiesen, obwohl nur 20 MB gesendet würden.

**Lösungsansatz:** In `totalAttachmentBytes` (oder den beiden Aufrufern) nur `upload.status ===
'uploading'` summieren.

**Aufwand:** S

**Verifikation:** Reproduktion: `totalAttachmentBytes([{size:20}], [{status:'error', size:10}]) ===
30`. Gegenprüfung: bestätigt.

(Quelle: COMP-09)

### R-54 — [LOW] `classifyUploadError` macht aus einem HTTP-400-Problem-Dokument jeden Typs ein `tooLarge` — falscher Toast, Retry ausgeblendet

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/attachment-upload.ts:121` (`err.type === ProblemTypes.limit || err.status === 400`)
- `apps/web/src/compose/AttachmentChips.tsx:65-68` (`tooLarge` ⇒ kein Retry-Button)
- `apps/web/src/compose/attachment-upload.test.ts:61-68` (pinnt ausdrücklich `{type:'other', status:400} → tooLarge`; der Fix muss den Test mitändern)

**Problem:** Der Fallback greift enger als im Erstbericht beschrieben: `errorFromResponse`
(`packages/jmap/src/errors.ts:231-257`) erzeugt `JmapProblemError` nur für einen JSON-Body mit gültigen
Problem-Details; ein nacktes HTTP 400 wird `JmapHttpError` → `server` (Retry vorhanden). Betroffen sind
400-Antworten mit Problem-Body eines anderen `type` (`notRequest`, `notJSON`, serverspezifisch). RFC
8620 §6.1 sagt für Uploads nur, dass der Server bei HTTP-Fehlern ein Problem-Details-Objekt zurückgeben
SHOULD; das Größensignal ist `urn:ietf:params:jmap:error:limit` (§3.6.1).

**Auswirkung:** Irreführende Meldung („zu groß, max 25 MB“ für eine 100-KB-Datei), kein Wiederholen
ohne Entfernen und Neuanhängen — nur in diesem engeren Fall.

**Lösungsansatz:** Nur `ProblemTypes.limit` (und ggf. 413) → `tooLarge`; sonstige 400 → `server`;
Test anpassen.

**Aufwand:** S

**Verifikation:** Code und Test gelesen, RFC 8620 §6.1/§3.6.1 lokal geprüft. Gegenprüfung:
abgeschwächt, Severity bleibt low.

(Quelle: COMP-10)

### R-55 — [LOW] `ScheduledSends.cancel` hat kein `catch`: bei Netzwerkfehler keine Rückmeldung, unbehandelte Rejection

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Compose (Outbox)

**Fundstelle(n):**
- `apps/web/src/outbox/ScheduledSends.tsx:62-73` (`try/finally` ohne `catch`), `apps/web/src/outbox/ScheduledSends.tsx:108` (`void cancel(item)`)

**Problem:** `client.cancel` wirft bei Transport-/Method-Fehler; der Spinner endet, sonst passiert
nichts (kein Toast, Liste unverändert). Der Schlüssel `outbox.scheduled.cancelFailed` fehlt
(`en/common.json:1571-1581`; vorhanden: `loadFailed`, `cancelled`, `tooLate`).

**Auswirkung:** Offline auf „Abbrechen“ klicken: keine Reaktion; unklar, ob die Nachricht nun geht oder
nicht.

**Lösungsansatz:** `catch` → `toast({ tone: 'danger', title: t('outbox.scheduled.cancelFailed') })`
(neuer Schlüssel in allen 14 Locales), analog zu `loadFailed`.

**Aufwand:** S

**Verifikation:** Code gelesen, Locale geprüft. Gegenprüfung: bestätigt.

(Quelle: COMP-11)

### R-56 — [LOW] Eine verspätete, leere lokale Antwort schließt die Vorschlagsliste, obwohl Directory-Treffer vorliegen — und sie bleibt bis zum nächsten Tastendruck zu

**Status:** [ ] offen

**Kategorie / Bereich:** react / Compose

**Fundstelle(n):**
- `apps/web/src/compose/RecipientField.tsx:124-130` (`setOpen(results.length > 0)` aus der lokalen Query)
- `apps/web/src/compose/RecipientField.tsx:177-182` (Wieder-Öffnen nur bei Änderung von `suggestions.length`, das durch `local=[]` unverändert bleibt)

**Problem:** Die lokale Query (120 ms Debounce + IndexedDB + Kontaktfilter) kann nach der
Directory-Antwort (250 ms, ggf. gecacht) eintreffen und setzt dann `open=false`, obwohl `suggestions`
Directory-Zeilen enthält. Voraussetzung bleibt eine lokale Antwort, die später kommt als die
Directory-Antwort (R-21 macht das wahrscheinlicher).

**Auswirkung:** Die Kollegin, die S-5 sichtbar machen soll, ist da, aber die Liste ist zu; erst ein
weiterer Tastendruck zeigt sie.

**Lösungsansatz:** `open` aus `suggestions.length > 0 && dismissedFor.current !== needle` ableiten (ein
Effekt auf `suggestions`), statt es aus einer einzelnen Query zu setzen.

**Aufwand:** S

**Verifikation:** Reproduziert: lokale Quelle antwortet nach 500 ms mit `[]`, Directory sofort mit
„Carol Chen“: bei ≈250 ms öffnet die Liste (`aria-expanded=true`), bei ≈620 ms setzt `:128`
`open=false`; 300 ms später ist sie noch zu und Carol nicht im DOM. Gegenprüfung: bestätigt.

(Quelle: COMP-13)

### R-57 — [LOW] `maxSizeAttachmentsPerEmail` wird ungeprüft übernommen — `0` sperrt jeden Anhang und jeden Versand mit Anhang (vgl. W-28)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Compose + Lib (jmap)

**Fundstelle(n):**
- `packages/jmap/src/session.ts:234-238` (`isMailCapability`: nur `typeof === 'number'`)
- `apps/web/src/compose/use-attachment-upload.ts:149-154` (`mailCap?.maxSizeAttachmentsPerEmail ?? null`)
- `apps/web/src/compose/attachment-upload.ts:87-94` (`validateTotal`: `cap !== null && existing + incoming > cap`)
- Muster: `packages/jmap/src/chunking.ts:91-93` (`usable`, W-28)

**Problem:** W-28 hat `maxSizeUpload`/`maxConcurrentUpload` auf `usable()` umgestellt; das dritte Limit
aus der Session blieb bei `??`. `0`, `-1` oder `NaN` passieren (`NaN` schaltet die Prüfung still ab,
`0`/`-1` sperren alles). Korrektur der Gegenprüfung: RFC 8621 §1.4 definiert das Feld als
`UnsignedInt`, nicht nullable — `null` ist die app-interne Darstellung von „Capability fehlt“, kein
Serverwert; die Begründung ist „Serverdaten sind ungeprüft“ (wie W-28), nicht „RFC erlaubt null“.

**Auswirkung:** `maxSizeAttachmentsPerEmail: 0` → jede Datei `totalTooLarge`, `oversized` für jeden
Entwurf mit Anhang ⇒ Send gesperrt mit `formatBytes(0)`-Toast.

**Lösungsansatz:** Wie W-28, aber mit `null`-Fallback: `Number.isInteger(v) && v > 0 ? v : null`
(kleine `usableOrNull`-Variante neben `usable`, oder die Prüfung direkt in `isMailCapability`).

**Aufwand:** S

**Verifikation:** Reproduktion: Session mit `maxSizeAttachmentsPerEmail: 0` →
`getMailCapability(...)?.maxSizeAttachmentsPerEmail === 0`, `validateTotal(0, 1, …)` →
`totalTooLarge`. Gegenprüfung: bestätigt, Begründung korrigiert.

(Quelle: COMP-14)

### R-58 — [LOW] `htmlToPlainText` kollabiert Zeilenumbrüche in `<pre>` und fügt zwischen Tabellenzellen keinen Trenner ein

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Compose

**Fundstelle(n):**
- `apps/web/src/compose/html-to-text.ts:74-76` (`\s+ → ' '` für jeden Textknoten, auch unter `PRE`)
- `apps/web/src/compose/html-to-text.ts:19-20`, `:35` (`LINE_TAGS = DIV, TR`; `TD`/`TH` inline; `PRE` nur in `PARA_TAGS`)

**Problem:** Die `text/plain`-Alternative jeder Nachricht (auch zitierter/weitergeleiteter) verliert
Codeblöcke (alle Zeilen in einer) und klebt Tabellenzellen zusammen. `html-to-text.test.ts` hat keinen
`<pre>`-/`<td>`-Fall.

**Auswirkung:** Text-only-Empfänger und Screenreader-Nutzerinnen mit Plain-Präferenz erhalten
unlesbare Weiterleitungen von Rechnungen/Newslettern und Code.

**Lösungsansatz:** `WalkContext` um `preformatted: boolean` erweitern (unter `PRE` Whitespace
bewahren, Zeilen 1:1); für `TD`/`TH` einen Trenner (`\t` oder zwei Leerzeichen) emittieren. Tests für
beide Fälle.

**Aufwand:** S

**Verifikation:** Reproduktion: `htmlToPlainText('<pre>line1\nline2</pre>') === 'line1 line2'`,
`htmlToPlainText('<table><tr><td>Betrag</td><td>100 €</td></tr></table>') === 'Betrag100 €'`.
Gegenprüfung: bestätigt.

(Quelle: COMP-15)

### R-59 — [LOW] Offline zeigt die Kalenderleiste „Dieses Konto hat keine Kalender“, während der Monat daneben aus der Replica gezeichnet wird

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/CalendarPage.tsx:912` und `:1049` (`<CalendarList calendars={calendars}>` — Netzwerk-State statt `effectiveCalendars`)
- `apps/web/src/calendar/CalendarPage.tsx:323-326` (`effectiveCalendars` nur für `visibleIds`), `:309-316` (Kommentar verspricht „the replica's copy is drawn instead of an empty rail“)
- `apps/web/src/calendar/CalendarPage.tsx:872` (Import-Button `disabled={calendars.length === 0}`), `:1154` (`EventDialog calendars`), `:1161` (`rsvpAllowed(calendars, …)`), `:394-407` (`loadCalendars` läuft nur bei `client`-Wechsel, nicht bei `online`)

**Problem:** Der Replica-Fallback hängt nur an der Ereignisabfrage; Leiste, Sheet, Import-Gate und
RSVP-Recht lesen `calendars`, das bei fehlgeschlagenem `listCalendars()` leer bleibt — entgegen dem
eigenen Kommentar. Herabgestuft (medium → low), weil offline nichts Funktionales verloren geht: Toggles,
Anlegen und Teilen sind über `disabled={saving || !online}` ohnehin gesperrt, Import und `+` über
`unavailableReason`; nach Wiederverbindung holt der „Try again“-Balken (`:987-993`) `loadCalendars()`
nach.

**Auswirkung:** Offline sieht die Leserin Termine im Raster, aber die Aussage „no calendars“ und keine
Legende, welcher Kalender welche Farbe hat — bis zum Klick auf „Try again“.

**Lösungsansatz:** Überall `effectiveCalendars ?? []` statt `calendars` an die Ansicht geben;
Schreibaktionen bleiben über `online` gesperrt.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt (`zz-verify-pim-rail.test.tsx`): Chip „Standup“ ist da,
Leiste rendert `"CalendarsThis account has no calendars."`. Gegenprüfung: bestätigt, medium → low.

(Quelle: PIM-06)

### R-60 — [LOW] Ein Map-Key `__proto__` in `emails`/`phones`/… lässt den Eintrag bei der nächsten Bearbeitung verschwinden — der JSON-Import lässt solche Keys durch (vgl. W-07)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness (Security-Härtung) / PIM (Kontakte)

**Fundstelle(n):**
- `apps/web/src/contacts/contact-io.ts:144-165` (`REJECT_ON_IMPORT` nur für Top-Level-Keys der Card)
- `apps/web/src/contacts/contact-fields.ts:69-74` (`preferredEntries` reicht `__proto__` als Key weiter — `JSON.parse` legt ihn als eigene Property an)
- `apps/web/src/contacts/contact-card-mapping.ts:499-514, 516-531, 585-638, 642-656, 660-674, 687-709, 820-838` (`out[entry.key] = …` auf Objektliteralen)

**Problem:** Dasselbe Muster wie W-07, an einer neuen Stelle (Schreibseite der Formularabbildung).
`out['__proto__'] = base` setzt den Prototyp des Objektliterals; beim Schreiben verschwindet der Eintrag,
`Object.keys(out)` zählt ihn nicht, der Patch ersetzt `emails` ohne ihn. Herabgestuft (medium → low):
der Key entsteht nur aus einer präparierten JSON-Datei oder einem feindlichen Client auf demselben Konto
— kein Werkzeug exportiert `__proto__` als PROP-ID —, der „verlorene“ Eintrag ist damit der des
Angreifers selbst; `Object.prototype` wird nicht verändert, kein Sicherheitsgewinn für einen Dritten.

**Auswirkung:** Nur mit präparierter Eingabe erreichbar; dann verschwindet der präparierte Eintrag bei
der nächsten Bearbeitung ohne Hinweis.

**Lösungsansatz:** In `coerceJsonCard` die bekannten Map-Properties rekursiv gegen
`__proto__`/`constructor`/`prototype` filtern (Muster `idAllocator` aus W-07); in
`contact-card-mapping.ts` die Zielobjekte mit `Object.create(null)` anlegen.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt: `cardToForm` zeigt beide Zeilen, `formToCard` +
`diffCardPatch` nach Namensänderung liefert `"emails":{"e2":…}` ohne den `__proto__`-Eintrag.
Gegenprüfung: abgeschwächt, medium → low.

(Quelle: PIM-09)

### R-61 — [LOW] Die Dateiliste ist nicht virtualisiert und wird bei jedem Tastendruck im Suchfeld komplett neu gerendert

**Status:** [ ] offen

**Kategorie / Bereich:** performance / PIM (Dateien)

**Fundstelle(n):**
- `apps/web/src/files/FilesPage.tsx:1074-1315` (eine `<li>` je Knoten mit Kontext-`Menu`, bis zu sechs `IconButton`s, Overflow-`Menu`, `Checkbox`, inline erzeugten Closures und `RowAction[]`; kein `memo(` in der Datei)
- `apps/web/src/files/FilesPage.tsx:231-232`, `:292-295` (`term` ist State derselben Komponente und löst pro Tastendruck ein Render der Seite samt Liste aus; die Zeilen ändern sich erst nach 250 ms Debounce)

**Problem:** Keine memoisierte Zeilenkomponente; `busy`, `preview`, `selected`, `term` lösen jeweils
ein vollständiges Re-Render aller Zeilen aus. `useVirtualizer` gibt es nur in `MessageList.tsx` und
`ContactList.tsx`. Nicht gemessen (jsdom ist nicht repräsentativ); 2 000 Einträge sind für diesen
Dateibrowser ein Ausreißer — ohne Zahl eine belegte Struktur-Schwäche, keine „spürbare“ Lücke, daher
medium → low.

**Auswirkung:** Große Verzeichnisse machen Tippen im Suchfeld und Anhaken per Checkbox träge
(Größenordnung nicht gemessen).

**Lösungsansatz:** Zeile als `memo`-Komponente, Suchfeld als Kindkomponente mit eigenem State (nur
`query` nach Debounce nach oben); Virtualisierung erst, wenn eine Messung sie rechtfertigt.

**Aufwand:** M

**Verifikation:** Code gelesen. Gegenprüfung: abgeschwächt, medium → low.

(Quelle: PIM-14)

### R-62 — [LOW] `monthRange` addiert `DAY_MS` und `defaultUntil` nimmt das UTC-Datum — beides gegen die eigene Regel des Moduls

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender)

**Fundstelle(n):**
- `apps/web/src/calendar/month-grid.ts:85-90` (`to: new Date(startOfDay(last).getTime() + DAY_MS)`; `weekRange` in `week-grid.ts:70-78` macht es richtig)
- `apps/web/src/calendar/EventDialog.tsx:631-635` (`defaultUntil` mit `toISOString().slice(0, 10)`)

**Problem:** Fällt der letzte Rastertag (Sonntag bei Montag-Start) auf die Herbstumstellung, endet das
Abfragefenster um 23:00 dieses Tages. Nur in Zonen mit Sonntags-Umstellung im November und Montag-Locale
(europäische Locale in den USA).

**Auswirkung:** Termine zwischen 23:00 und 24:00 des letzten Rastertags fehlen — selten und klein;
`defaultUntil` liefert nach 22:00 (Berlin) bzw. 19:00 (New York) den Vortag als Standard-Enddatum.

**Lösungsansatz:** `to: addDays(startOfDay(last), 1)`; `defaultUntil` mit `toIsoDate(date)`.

**Aufwand:** S

**Verifikation:** `month-range-dst.mjs` wiederholt: `TZ=America/New_York`, Montag-Start → 21 Raster
mit Nicht-Mitternacht-Ende, davon 7 mit 23:00 (2027-10, 2028-10, 2032-10, 2033-10, 2034-10, 2038-10,
2039-10); Sonntag-Start und `TZ=Europe/Berlin` → 0; Vitest gegen das echte `monthRange` (`de-DE`)
bestätigt dieselben 21 Fälle. Gegenprüfung: bestätigt.

(Quelle: PIM-16)

### R-63 — [LOW] Geburtstag als `Timestamp`: Formular zeigt den UTC-Tag, Detailansicht den lokalen — in Zonen westlich von UTC einen Tag auseinander

**Status:** [ ] offen

**Kategorie / Bereich:** i18n / PIM (Kontakte)

**Fundstelle(n):**
- `apps/web/src/contacts/contact-card-mapping.ts:756-768` (`extractBirthdayString`: `getUTC*`)
- `apps/web/src/contacts/contact-fields.ts:199-206` (`formatBirthday`: `toLocaleDateString` in lokaler Zeit; der `PartialDate`-Zweig `:208-214` vermeidet das ausdrücklich mit UTC-Mittag)

**Problem:** Detail und Formular rechnen denselben `Timestamp` verschieden um. `Timestamp`-Geburtstage
entstehen nur aus vCard `BDAY` mit Uhrzeit — selten.

**Auswirkung:** Detail „March 14“, Formular „1980-03-15“; wer das Datum im Formular „bestätigt“,
schreibt einen `PartialDate` mit dem 15., und die Anzeige springt.

**Lösungsansatz:** `formatBirthday` für `Timestamp` mit `timeZone: 'UTC'` formatieren.

**Aufwand:** S

**Verifikation:** Reproduktion wiederholt unter `TZ=America/New_York`: `form: 1980-03-15 detail:
March 14, 1980`. Gegenprüfung: bestätigt.

(Quelle: PIM-17)

### R-64 — [LOW] Fotofeld: ein fehlgeschlagener zweiter Bildauswahlversuch widerruft die Vorschau-URL, die der Entwurf noch anzeigt

**Status:** [ ] offen

**Kategorie / Bereich:** react / PIM (Kontakte)

**Fundstelle(n):**
- `apps/web/src/contacts/ContactForm.tsx:1022-1025` (`setPreview` widerruft die vorherige URL beim Setzen der neuen), `:1039-1040` (`onPick` ruft es **vor** dem `await preparePhotoUri`), `:1053-1061` (im `catch` `setPreview(null)` widerruft auch die neue), `:1134` (`PhotoImg` bevorzugt `photo.previewUrl` vor `photo.uri`)

**Problem:** Nach Bild A (Erfolg) und Bild B (zu groß) verweist der Entwurf auf eine widerrufene
Blob-URL.

**Auswirkung:** Kaputtes Bild im Foto-Kreis, obwohl Bild A gespeichert würde.

**Lösungsansatz:** Vorschau-URL erst nach erfolgreichem `preparePhotoUri` tauschen; oder `previewUrl`
nicht im Entwurf halten und immer `photo.uri` rendern.

**Aufwand:** S

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt.

(Quelle: PIM-18)

### R-65 — [LOW] Kleinere Formular-Inkonsistenzen: Wiederholungszähler springt beim Leeren auf 1, Firma/Titel werden ungetrimmt gespeichert

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / PIM (Kalender, Kontakte)

**Fundstelle(n):**
- `apps/web/src/calendar/EventDialog.tsx:611-621` (`count`-Feld: `Number.parseInt('')` → `NaN` → `1`, kontrollierter Wert `String(end.count)`; das T14-Muster `:119-131` ist hier nicht angewandt)
- `apps/web/src/contacts/contact-card-mapping.ts:725`, `:742` (`formToOrganizations`/`formToTitles` schreiben `form.organization`/`form.title` ohne `trim()`, während die Leerprüfung trimmt)

**Problem:** Zwei kleine Abweichungen vom Muster der übrigen Felder.

**Auswirkung:** Zähler: „10“ löschen, um „5“ zu tippen, ergibt „15“ oder „51“. Firma „ ACME “ wird mit
Leerzeichen gespeichert.

**Lösungsansatz:** Zählerwert als Text im State halten und beim Speichern parsen (wie `duration`);
`trim()` in `formToOrganizations`/`formToTitles`.

**Aufwand:** S

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt (Kategorie correctness statt a11y).

(Quelle: PIM-19)

### R-66 — [LOW] Dialoge „Neuer Ordner“ und „Umbenennen“ reagieren nicht auf Enter, und der Name wird nicht — wie kommentiert — vorselektiert

**Status:** [ ] offen

**Kategorie / Bereich:** a11y / PIM (Dateien)

**Fundstelle(n):**
- `apps/web/src/files/FilesPage.tsx:838-880` (Neuer Ordner), `:882-921` (Umbenennen), `:225-226` (Kommentar „opens with the CURRENT name selected“)
- Gegenbeispiele: `apps/web/src/calendar/CalendarDialog.tsx:108-114` (`<form onSubmit>`), `apps/web/src/contacts/AddressBookList.tsx:423-429` (`form={formId}`)

**Problem:** `grep -n '<form\|onSubmit\|onKeyDown' FilesPage.tsx` → kein Treffer; `Dialog.tsx` und
`TextInput.tsx` haben keine Enter-Behandlung; `grep -rn '\.select()' apps/web/src` → kein Treffer.

**Auswirkung:** Tastaturnutzer tippen den Namen, drücken Enter — nichts passiert; beim Umbenennen muss
der alte Name von Hand markiert werden.

**Lösungsansatz:** Beide Dialoge als `<form onSubmit>` (Muster `CalendarDialog`); `onFocus={(e) =>
e.currentTarget.select()}` oder `initialFocusRef` + `select()`.

**Aufwand:** S

**Verifikation:** Code gelesen, greps wie oben. Gegenprüfung: bestätigt.

(Quelle: PIM-20)

### R-67 — [LOW] Sammel-Upload: bricht die Schleife bei Datei 3 von 11 ab, nennt der Toast keine Datei

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / PIM (Dateien)

**Fundstelle(n):**
- `apps/web/src/files/FilesPage.tsx:771-773` (`for (const file of chosen) await client.upload(file, here)` in **einem** `run`), `apps/web/src/files/FilesPage.tsx:469-494` (Reload nur im Erfolgspfad, Toast ohne Dateinamen)

**Problem:** Abgeschwächt in der Gegenprüfung: für das eigene Konto ist die Liste eine Live-Query auf
die Replica, die der FileNode-Delta (Push oder 60-s-Sweep) nachzieht — die hochgeladenen Dateien
erscheinen also binnen Minutenfrist von selbst, nicht erst „bis zum nächsten Reload“. Bleibt: welche
Datei abgelehnt wurde und welche folgenden nicht mehr versucht wurden, erfährt die Leserin nicht.

**Auswirkung:** Bei `alreadyExists`/`overQuota` mitten im Stapel weiß die Leserin nicht, welche Datei
abgelehnt wurde.

**Lösungsansatz:** Je Datei ein `run` (Fehler sammeln, Datei im Toast nennen) und nach der Schleife
genau ein Reload; oder `Promise.allSettled` mit „8 von 11 hochgeladen“.

**Aufwand:** S

**Verifikation:** Code gelesen. Gegenprüfung: abgeschwächt, Severity low beibehalten.

(Quelle: PIM-21)

### R-68 — [LOW] Irreführende Kopfkommentare beschreiben den Zustand vor K-8/D-4 und ein Verhalten, das es nicht gibt

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / PIM

**Fundstelle(n):**
- `apps/web/src/calendar/calendar-client.ts:4-5`, `apps/web/src/calendar/CalendarPage.tsx:159` („no replica“ — seit K-8 falsch; die Seite liest ausschließlich aus der Replica, `use-calendar-events.ts`)
- `apps/web/src/files/files-client.ts:4`, `apps/web/src/files/FileMoveDialog.tsx:9-10` (seit D-4 falsch; `use-file-tree.ts` sagt es selbst)
- `apps/web/src/calendar/WeekView.tsx:21-22` (behauptet Klick-Erstellung in der Spalte — `grep onClick WeekView.tsx` zeigt nur Tageskopf `:121` und Termin-Buttons `:145`, `:229`)
- `apps/web/src/sync/engine/maintenance.ts:278-280` (siehe R-05), `apps/web/src/files/FilesPage.tsx:225-226` (siehe R-66)

**Problem:** Wer die Dateien liest, entscheidet auf falscher Grundlage — R-05 (falsche
Stempel-Behauptung) und R-24 (Move-Dialog ohne Replica) sind so entstanden.

**Auswirkung:** Wartungsreibung, Folgefehler.

**Lösungsansatz:** Kommentare auf den Replica-Stand bringen; die WeekView-Passage streichen oder den
Spaltenklick tatsächlich anbieten.

**Aufwand:** S

**Verifikation:** Code gelesen, greps wie oben. Gegenprüfung: bestätigt.

(Quelle: PIM-23)

### R-69 — [LOW] W-13 unvollständig: die Fehlerpfade des Replay schreiben weiter per Id über eine inzwischen ersetzte Zeile (vgl. W-13)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/outbox.ts:2731` (`deadLetter`: `status: 'error'` + `conflict` per Id), `:2741` (`undo: null`)
- `apps/web/src/sync/engine/outbox.ts:2785` (`refreshes`), `:2808-2812` (Auth-Expiry), `:2836-2842` (transient)
- Gegenstück: `apps/web/src/sync/engine/outbox.ts:2012` (`deleteIfUnchanged` prüft `seq` — nur auf den zwei Erfolgspfaden)

**Problem:** Der `seq`-Vergleich schützt nur das abschließende `delete`. Jede andere Fortschreibung der
geclaimten Zeile ist ein unbedingtes `db.outbox.update([accountId, row.id], …)`. Wird die Zeile
(`draft:<localId>`) während des Roundtrips ersetzt, landet das Ergebnis der ALTEN Anfrage auf der NEUEN:
ein permanenter Reject dead-lettert B mit A's Konflikt (`stampDraftError` markiert den Draft), ein
transienter Fehler vererbt `attempts`/`nextAttemptAt`. Herabgestuft (medium → low): der Reject-Fall
braucht eine permanente Ablehnung eines Autosaves (`tooLarge`, `overQuota`, `invalidProperties`) UND
Überlappung, und die falsche Dead-Letter-Zeile wird vom nächsten Autosave/Close-Flush überschrieben;
der Transient-Fall verzögert nur um einen Backoff-Schritt.

**Auswirkung:** Autosave A wird permanent abgelehnt, während B (weitergetippt) schon eingereiht ist →
B steht als „fehlgeschlagen“ mit A's Fehler, der Draft ist rot markiert — bis zum nächsten Tastendruck
bzw. Close-Flush oder einem Klick auf „Erneut versuchen“. Ist B der letzte Flush vor dem Schließen,
bleibt der Draft bis dahin als fehlerhaft im Restore.

**Lösungsansatz:** `updateIfUnchanged(db, accountId, row, patch)` analog zu `deleteIfUnchanged`
(Transaktion: re-read, `seq`-Vergleich, `update`) und die fünf Schreibstellen darüber führen; bei
Mismatch das Row-Bookkeeping überspringen (Undo für Drafts ist `none`). Regressionstests für Reject-
und Transient-Pfad (R-76).

**Aufwand:** S

**Verifikation:** A1/A2 wiederholt: Ersatzzeile (`seq: 2`, Payload B) nach Reject `status: 'error'`;
nach `TypeError` `attempts: 1` und `nextAttemptAt` gesetzt. Gegenprüfung: bestätigt, medium → low.

(Quelle: SYNC-02)

### R-70 — [LOW] `discardFailed` löscht eine Zeile, deren Undo der Drain gerade geclaimt hat — schlägt dessen Rollback fehl, geht er still verloren (vgl. W-14)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/engine.ts:618-644` (Claim: `undo != null` → nullen; danach `row.undo ?? null` → bei `null` direkt `delete`)
- `apps/web/src/sync/engine/outbox.ts:2600-2622` (`drainOwedUndos`: Claim, Netz-Roundtrip in `applyUndo`, bei Fehler `update({ undo })` — trifft eine gelöschte Zeile, No-op)

**Problem:** Der W-14-Claim codiert „ich habe das Undo übernommen“ als `undo: null` — derselbe Wert wie
„Undo wurde angewendet“. `discardFailed` löscht die Zeile, sobald es `undo: null` liest; hält in diesem
Moment `drainOwedUndos` den Claim und scheitert danach, schreibt es sein `undo` auf eine nicht mehr
vorhandene Zeile. Herabgestuft (medium → low): vier Bedingungen müssen zusammentreffen (permanenter
Reject mit `refetchEmails`-Undo, dessen Rollback bereits einmal am Netz scheiterte, Klick auf
„Verwerfen“ innerhalb des Drain-Roundtrips, erneuter Netzfehler genau dann); das Listenfenster heilt
sich über die periodische Vollabfrage (`FULL_SWEEP_EVERY`), nur die Ordnerzähler bleiben bis zur
nächsten serverseitigen Änderung falsch. Die `retryFailed`-Variante konvergiert.

**Auswirkung:** Dead Letter eines `destroyEmails` (`forbidden`) mit geschuldetem Refetch; Sync-Pass
startet, Drain claimt und wartet auf `Email/get`; Nutzerin klickt „Verwerfen“; der Refetch scheitert →
Zeile weg, Envelopes bleiben lokal gelöscht, `totalEmails`/`unreadEmails` um N zu niedrig, bis der
Server den Ordner neu meldet.

**Lösungsansatz:** Claim und „angewendet“ trennen: Feld `undoClaimedAt?: number` (nicht indiziert,
kein Version-Bump). Claim = `undo: null, undoClaimedAt: now`; Erfolg = `undoClaimedAt: null`;
Fehlschlag = `undo` zurück + `undoClaimedAt: null`. `discardFailed`/`retryFailed` liefern `false`,
solange `undoClaimedAt` gesetzt ist. Regressionstest für den Fehlschlagfall (R-76).

**Aufwand:** S

**Verifikation:** D1 wiederholt: `discardFailed` liefert `true`, Refetch verworfen → Zeile weg, `e1`
nicht wiederhergestellt, `inbox.totalEmails === 0` statt 1. Gegenprüfung: bestätigt, medium → low.

(Quelle: SYNC-04)

### R-71 — [LOW] `reconcileContactQuery` verwirft unplatzierbare Adds und persistiert ein leeres Fenster mit gültigem `queryState` — die B17-Korrektur der Mail-Seite fehlt bei Kontakten

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/delta.ts:648-651` (`if (item.index <= ids.length)` — verwirft still), `apps/web/src/sync/engine/delta.ts:660-667` (schreibt `ids: []` mit neuem `queryState`)
- Gegenstück: `apps/web/src/sync/engine/delta.ts:440-448` (Mail: `unplaceable` ⇒ `fullRequery`) und `:455-459` (leeres Fenster bei `total > 0` ⇒ `fullRequery`)

**Problem:** Meldet `ContactCard/queryChanges` alle Fenster-Ids als `removed` und die Adds mit Indizes
jenseits des Fensters, wird `ids: []` mit dem NEUEN `queryState` geschrieben. Der nächste Delta sieht
„nichts geändert“; die Liste bleibt leer, bis der fünfte Sweep (`FULL_SWEEP_EVERY`) eine Vollabfrage
erzwingt. Das Server-Verhalten, das den Mail-Guard motiviert hat, ist beim selben Server auch für
Kontakte zu erwarten.

**Auswirkung:** Kontaktliste zeigt „keine Kontakte“ bei `total: 3`, bis zu fünf Minuten, ohne Fehler.

**Lösungsansatz:** Die zwei Mail-Guards 1:1 übernehmen (`unplaceable.length > 0` und `ids.length ===
0 && total > 0` ⇒ `fullRequeryContacts`); Test analog zum Mail-Fall.

**Aufwand:** S

**Verifikation:** F1 wiederholt: `ids: []`, `queryState: 'q2'`, `total: 3`, `fullQueries: 0`.
Gegenprüfung: bestätigt.

(Quelle: SYNC-07)

### R-72 — [LOW] Der W-18-Occurrence-Sweep kann eine gerade materialisierte Kalenderansicht leeren: Occurrences werden vor der Fensterzeile geschrieben (vgl. W-18)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/delta.ts:925` (`putCalendarEvents(…, true)`) vor `:927-929` (Sync-State) und `:941` (`putCalendarQueryCache`) — drei Transaktionen dazwischen
- `apps/web/src/sync/engine/maintenance.ts:292-306` (Sweep löscht jede Occurrence, die kein Fenster nennt)
- Vorbild: `apps/web/src/sync/engine/backfill.ts:136-140` (Mail: Fensterzeile ZUERST, aus genau diesem Grund)
- Nebenläufigkeit: `apps/web/src/sync/engine/engine.ts:862-905` (`refreshCalendarWindow`/`backfillCalendarQueryIfAbsent` laufen aus der UI ohne Leader-Prüfung und ohne Serialisierung mit `maintaining`)

**Problem:** Der Sweep betrachtet in der Lücke die frischen Occurrences als verwaist und löscht sie;
die danach geschriebene Fensterzeile nennt Ids ohne Zeilen (`stale: false`). Der Sweep muss die
Fensterliste VOR `:941` und die Occurrences NACH `:925` lesen — ein Fenster von wenigen Millisekunden
bei 5-Minuten-Kadenz; selten, aber die Folge ist ein leerer Monat ohne Fehler. PIM-22 beschrieb
denselben Defekt und wurde als Duplikat gestrichen; der PIM-Aspekt (`refresh()` nach `createEvent`,
`engine.ts:862-868`) ist hier enthalten. Eigener Defekt neben R-05 (gleicher Block, andere Ursache).

**Auswirkung:** Monat wird geöffnet, gleichzeitig läuft Wartung → Grid bleibt leer bis zum nächsten
`forceFull`-Sweep (bis 5 Min) oder einem Delta, das das Fenster berührt.

**Lösungsansatz:** Occurrences und Fensterzeile in EINER `rw`-Transaktion über `calendarEvents` +
`calendarQueryCache` schreiben (kein Netz dazwischen), oder wie im Mail-Pfad die Fensterzeile zuerst.

**Aufwand:** S

**Verifikation:** Code gelesen (Schreibreihenfolge, Sweep-Kriterium, Aufrufpfade); kein Test — die
Lücke liegt zwischen zwei IndexedDB-Transaktionen und ist mit fake-indexeddb nicht deterministisch zu
treffen. Gegenprüfung: bestätigt (Code).

(Quelle: SYNC-08; PIM-22 als Duplikat verworfen)

### R-73 — [LOW] Der W-18-Wartungspass lädt alle Kalender-Events vollständig (JS-Filter) — alle fünf Minuten (vgl. W-18)

**Status:** [ ] offen

**Kategorie / Bereich:** performance / Sync

**Fundstelle(n):**
- `apps/web/src/sync/repo.ts:1171-1177` (`calendarOccurrences`: `where('accountId').filter(row => row.occurrence).toArray()` — `occurrence` ist kein Index, jede Kalenderzeile wird deserialisiert)
- `apps/web/src/sync/engine/maintenance.ts:281`, `:286`, `:299` (Fensterzeilen je `toArray()`); `[accountId+lastUsedAt]` existiert auf beiden Fenstertabellen (`db.ts:928`, `:937`), `planWindowReap` braucht nur `key`/`lastUsedAt` (`eviction.ts:253-257`)

**Problem:** Für den Sweep wird JEDE Kalenderzeile mit vollem JSCalendar-Objekt geladen; der Reap lädt
die Fensterzeilen samt Id-Arrays, obwohl für die Reap-Lesung ein Key-Range über `[accountId+lastUsedAt]`
genügte (die Id-Arrays der überlebenden Fenster werden für die `referenced`-Menge in 1c allerdings
GEBRAUCHT — der eigentliche Kostenpunkt ist der Occurrence-Vollscan). Beides wächst linear mit der
Kalendergröße und läuft auf dem Main-Thread.

**Auswirkung:** Große Kalender (mehrere tausend Occurrences) → alle 5 Minuten ein Vollscan mit
Deserialisierung im Leader.

**Lösungsansatz:** Reap über den `lastUsedAt`-Index als Key-Range (`.below([accountId, now − TTL])`,
`primaryKeys()`); für den Sweep ein indizierbares Ableitungsfeld (`occ: 0|1`) in `toCalendarEventRow`
(Version-Bump mit `.upgrade()`) oder `eachKey` über `[accountId+base]` mit `id !== base`, wo der Server
synthetische Ids liefert.

**Aufwand:** S–M (Index braucht Version-Bump)

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt, präzisiert.

(Quelle: SYNC-09)

### R-74 — [LOW] `cannotCalculateChanges`-Recovery nullt den `FileNode`-State, wonach der Baum nicht mehr per Delta gepflegt wird; Full-Pull von Mailboxen/Adressbüchern entfernt serverseitig gelöschte Zeilen nicht

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/engine.ts:1478-1483` (`resetWatchedStates` iteriert alle `WATCHED_TYPES` inkl. `FileNode`, `:124-135`), `apps/web/src/sync/engine/engine.ts:1649-1651` (Files-Delta nur bei `state !== null`)
- `apps/web/src/sync/engine/delta.ts:229-233`, `:558-561` (`syncMailboxes`/`syncAddressBooks` bei `null` nur `put`); Gegenstück `:779-795` (`reloadCalendars` löscht)

**Problem:** Nach einer Recovery (Server aus Backup, Reset) bleibt der Dateibaum eingefroren, bis
`FilesPage` beim nächsten Mount `load()` → `refreshFileTree` ruft (`FilesPage.tsx:360-361`, `:336`);
die Vollabfrage von Mailboxen/Adressbüchern schreibt die Serverliste nur additiv — ein Ordner/Buch, das
der Server nicht mehr hat, bleibt lokal bestehen, weil kein Delta es je meldet; diese heilen sich nie.

**Auswirkung:** Nach einem Server-Restore stehen gelöschte Ordner weiter im Baum; Klicks enden als
`folderGone`-Dead-Letter.

**Lösungsansatz:** In der `sinceState === null`-Branch von `syncMailboxes`/`syncAddressBooks` wie in
`reloadCalendars` die nicht mehr gelisteten Ids löschen; `FileNode` aus `resetWatchedStates` ausnehmen
oder nach Reset einmal `syncFileNodes` anstoßen, wenn zuvor ein State existierte.

**Aufwand:** S

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt (Code), Files-Aspekt präzisiert.

(Quelle: SYNC-10)

### R-75 — [LOW] `SyncEngineHost`: ein Fehler in `startFleet()` bleibt eine unhandled rejection und vergiftet die `teardownRef`-Kette

**Status:** [ ] offen

**Kategorie / Bereich:** react / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/react.tsx:185-189` (`started` ohne `catch`), `apps/web/src/sync/engine/react.tsx:194` (`teardownRef.current = started.then(…)`)

**Problem:** Wirft `startFleet()`, rejectet `started`; niemand fängt es. Die Kette rejectet weiter, der
nächste Effekt-Lauf scheitert an `await teardownRef.current`, `stopFleet` bleibt `null`, bis zum Remount
startet keine Fleet — ohne Fehleranzeige. Vor W-15 hätte derselbe Wurf den Effekt scheitern lassen
(sichtbar im Error-Boundary). Ein Wurf ist unwahrscheinlich (`canRunEngine()` prüft
Locks/BroadcastChannel vorab), aber nicht ausgeschlossen (`getReplica()` in einem Teardown-Fenster).

**Auswirkung:** Härtung; im Normalbetrieb nicht beobachtet.

**Lösungsansatz:** `started` mit `.catch` versehen (Fehler an `reportDispatchFailure`/Konsole,
`teardownRef.current = null`) und in der Kette `await teardownRef.current?.catch(() => undefined)`.

**Aufwand:** S

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt (Code).

(Quelle: SYNC-11)

### R-76 — [LOW] Die Regressionstests zu W-13 und W-14 pinnen nur die Erfolgspfade (vgl. W-13, W-14)

**Status:** [ ] offen

**Kategorie / Bereich:** tests / Sync

**Fundstelle(n):**
- `apps/web/src/sync/engine/outbox.test.ts:175-215` („does not delete the replacement when the claimed row completes“ — nur Erfolgsantwort)
- `apps/web/src/sync/engine/engine.test.ts:1878-1901` (beide Discards erfolgreich), `:1903-1927` („hands the claim back“: ohne konkurrierenden Claim-Halter)

**Problem:** Die gefixten Races haben je zwei Hälften — Erfolg und Fehlschlag der laufenden Operation —
und nur die erste ist getestet. Die fehlenden Hälften sind genau R-69 und R-70.

**Auswirkung:** Grün trotz defektem Fehlerpfad.

**Lösungsansatz:** A1, A2, D1 (Scratch des Prüf-Agenten) sowie V1 und V3 (Scratch der Gegenprüfung,
für R-29 und R-28) angepasst in die bestehenden Suiten übernehmen, sobald die Befunde behoben sind.

**Aufwand:** S

**Verifikation:** Tests gelesen; Gegenproben laufen rot. Gegenprüfung: bestätigt.

(Quelle: SYNC-12)

### R-77 — [LOW] Public-Computer-Modus hinterlässt `waxwing.connect.target` in `localStorage`, wenn der Tab ohne Sign-out geschlossen wird (vgl. W-05)

**Status:** [ ] offen

**Kategorie / Bereich:** security / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/session/SessionProvider.tsx:334` (`writeStored(local(), DURABLE_TARGET_KEY, target)` in `connectSession`, ohne `ephemeralRef`-Prüfung)
- `apps/web/src/app/session/SessionProvider.tsx:539-548` (`pagehide` löscht nur das Replica)
- `apps/web/src/app/session/SessionProvider.tsx:685-699`, `:752` (einzige Löschstellen, beide erst beim Sign-out)

**Problem:** Der Schlüssel wird auch für ephemere Sessions geschrieben; FR-AUTH-09 nennt das Verlassen
ohne Menüklick als Kernszenario, und das Registry-Schreiben wurde für diesen Fall bereits unterbunden
(`:809`), der Target nicht. Kein Duplikat von W-05: dessen Fix (`wipeWebStorage` in `endSession`,
`:695-698`) deckt nur den Sign-out-Pfad; der Tab-Schließen-Pfad ist ein nicht abgedeckter Rest.
Herabgestuft (medium → low), weil der Wert auf den üblichen Deployments (pinned / same-origin) nur den
App-Origin selbst enthält; nur bei `allowCustomServer` mit manuell eingegebenem fremden Server bleibt
ein Hostname zurück, keine Identität.

**Auswirkung:** `allowCustomServer`-Deployment auf einem geteilten Rechner: Gast schließt den Tab, der
Mailserver-Host des Gastes bleibt in `localStorage`; ein späterer durable Restore bootet gegen diesen
Server (`fallbackTarget()`, `:288`).

**Lösungsansatz:** `if (!ephemeralRef.current) writeStored(local(), DURABLE_TARGET_KEY, target)`. Der
Restore braucht den Schlüssel bei ephemeren Sessions nie (kein AuthRecord → `restore()` liefert
`null`); `endSession` nutzt `targetRef`. Test im „public-computer mode“-Block: nach ephemerem Connect
ist `localStorage.getItem('waxwing.connect.target')` null.

**Aufwand:** S

**Verifikation:** Reproduziert: nach `basic-public`-Login steht `waxwing.connect.target` in
`localStorage`; simuliertes `pagehide` lässt es stehen. Gegenprüfung: bestätigt, medium → low.

(Quelle: APP-05)

### R-78 — [LOW] Offline-Kaltstart landet auf dem Login-Formular — bekannter, per E2E-Tripwire gepinnter Produktdefekt ohne Tracking-Eintrag

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/session/SessionProvider.tsx:441-449` (`restore()` → `connectSession()` → `services.connect()`)
- `packages/jmap/src/client.ts:225-241` (`connect` ruft immer `getSession`; Konstruktor `:66-72` akzeptiert `{session, auth, sessionUrl}` direkt)
- `e2e/tests/pwa.spec.ts:98-153` (Tripwire: Assertion `toBeHidden()` pinnt den Zustand und benennt ihn korrekt als „a product defect rather than a harness limitation“)

**Problem:** Installierte PWA offline öffnen → Shell bootet aus dem Precache, `restore()` gelingt,
`connectSession` scheitert am Netz → „Could not reach the server“ auf dem Login-Formular, das
vollständige Replica dahinter unerreichbar; `jmapSession` wird nirgends persistiert. Abgeschwächt in der
Gegenprüfung: Die Kernaussage des Erstberichts (die dokumentierte Begründung sei falsch) trifft nur eine
Formulierung im Plan-Eintrag 2026-07-20; der Tripwire selbst beschreibt die Sache richtig. Kein neuer
Code-Befund, sondern ein bekannter, bewusst gepinnter Defekt gegen FR-OFF-01 (Must) — neu ist nur, dass
ihn kein Backlog-/Plan-Eintrag trägt.

**Auswirkung:** Flugzeug/Zug: keine Mail trotz Replica. Bei Basic ohne „stay signed in“ gar kein
Restore.

**Lösungsansatz:** Wie im Tripwire skizziert: Session-Dokument bei erfolgreichem `connectSession` in
das Replica schreiben (kein Mail-Inhalt, kein Token); in `boot()` bei `restore()` + `TypeError`/Offline
daraus einen `JmapClient` bauen, `connected` als offline markieren, `refreshSession()` nach Reconnect.
Tripwire in einen echten Offline-Kaltstart-Test umwandeln. Bis dahin: Eintrag im Plan/Backlog, damit das
Must nicht nur in einem Testkommentar lebt.

**Aufwand:** M

**Verifikation:** Code gelesen, Tripwire und Plan-Eintrag gelesen. Gegenprüfung: abgeschwächt.

(Quelle: APP-07)

### R-79 — [LOW] Ein terminal fehlschlagender Refresh nach `logout()` legt die gewischte `waxwing-auth`-Datenbank neu an (vgl. W-05, W-23)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Auth)

**Fundstelle(n):**
- `apps/web/src/auth/controller.ts:320-330` (Fehlerpfad ruft `tokens.clear()` ohne Generation-Check; der W-05-Generation-Check `:335` sitzt nur im Erfolgspfad)
- `apps/web/src/auth/secret-store.ts:188-193`, `:97-127` (`delete()` → `openDb()` erzeugt DB samt Object Stores neu)

**Problem:** Nach „Sign out & remove data“ existiert wieder eine (leere) `waxwing-auth`-DB — genau das
Muster, das W-23/W-05 für den Registry-Key beseitigt haben.

**Auswirkung:** Keine Credentials, aber `indexedDB.databases()` ist nach dem Wipe nicht leer; ein
E2E-Assert „keine Waxwing-Datenbank nach Wipe“ würde sporadisch rot.

**Lösungsansatz:** Im catch vor `tokens.clear()`: `if (generation !== this.generation) throw new
AuthExpiredError('Signed out during token refresh', { cause: error })`. `clearAccessToken()` reicht
nach einem Logout.

**Aufwand:** S

**Verifikation:** Reproduziert (`auth-verify.test.ts`): Refresh hängt am Fake-IdP,
`logout({wipeData:true})`, DB weg, `invalid_grant` freigegeben → `indexedDB.databases()` enthält die DB
wieder (leer). Gegenprüfung: bestätigt.

(Quelle: APP-08)

### R-80 — [LOW] Basic-Anmeldung ohne „stay signed in“ scheitert, wenn IndexedDB nicht geöffnet werden kann, obwohl nichts persistiert werden soll (vgl. W-06)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / App (Auth)

**Fundstelle(n):**
- `apps/web/src/auth/controller.ts:183` (`this.session = session` vor jedem Store-Zugriff), `:190` (`await this.tokens.clear()`, W-06-Fix), `:201-202` (`store.delete(...)` im `else`-Zweig)

**Problem:** Alle drei Aufrufe öffnen den `SecretStore`, auch wenn nichts gespeichert werden soll;
`registry-store.ts` toleriert dieselbe Umgebung bewusst. `errToOnboard` zeigt „Something went wrong“
mit Reset-Angebot. Zusatzbeobachtung: `this.session` ist bereits gesetzt, `getSession()` liefert also
eine Basic-Session, obwohl der Login als fehlgeschlagen gemeldet wird.

**Auswirkung:** Basic-only-Nutzer in Storage-blockierten Umgebungen (Policy, WebView) kommen nicht
hinein, obwohl die Session rein im Speicher liegen könnte.

**Lösungsansatz:** Die Aufräum-Deletes best-effort (`.catch(() => undefined)`) — Hygiene, kein
Bestandteil der Anmeldung; nur der `staySignedIn`-Zweig darf am Store scheitern. `this.session` erst
nach den Store-Schritten setzen.

**Aufwand:** S

**Verifikation:** Reproduziert: `SecretStore` mit fehlschlagendem `indexedDB.open` →
`startLogin({method:'basic', staySignedIn:false})` → `rejected: InvalidStateError: blocked`.
Gegenprüfung: bestätigt.

(Quelle: APP-09)

### R-81 — [LOW] Deep Link geht bei der ersten OAuth-Anmeldung verloren (Route-Stash nur im Re-Auth-Pfad)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/session/SessionProvider.tsx:507-531` (`chooseOAuth`: schreibt Target und Public-Flag, keine Route), `:592` (einzige Schreibstelle von `STASH_ROUTE_KEY`, in `resolveReauthOAuth`), `:418-426` (Restore beim Callback), `:436` (Nicht-Callback-Pfad löscht die Route)
- `apps/web/src/auth/controller.ts:525-530` (`computeRedirectUri` strippt Query und Hash; der Callback kommt an der App-Wurzel an)
- `apps/web/public/manifest.json:12-17` (`mailto`-Protokoll-Handler `./?mailto=%s`; `useMailtoHandler` läuft erst in `AppShell`)

**Problem:** Der Callback-Pfad kann eine Route wiederherstellen; die Erstanmeldung stellt keine bereit.

**Auswirkung:** Nutzer ohne persistierte Session (Public-Computer, nach Sign-out) folgen einem Link
(`/contacts/…`, `/mail/a/e1?account=…`, `./?mailto=…`, Notification-Klick), melden sich per OAuth an und
landen im Posteingang; der `mailto:`-Composer öffnet nicht. Basic-Anmeldung nicht betroffen.

**Lösungsansatz:** In `chooseOAuth` `writeStored(session(), STASH_ROUTE_KEY, pathname + search)`
(gleiche Änderung wie R-31).

**Aufwand:** S

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt.

(Quelle: APP-10)

### R-82 — [LOW] Sieve-Round-Trip bricht bei Regelnamen mit U+2028/U+2029 oder mit Marker-Text

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Settings, Sieve)

**Fundstelle(n):**
- `apps/web/src/settings/sieve/script-io.ts:43` (`MARKER_BEGIN = /^# @waxwing:rules:v(\d+) (.*)$/gm`), `:406-408` (Kommentar behauptet, die Metadaten belegten immer genau eine Zeile)
- `apps/web/src/settings/sieve/script-io.ts:202-210`, `:220` (zweiter Begin-Marker → opaque; `source.indexOf(MARKER_END, lineEnd)` findet auch eine Regel-Kommentarzeile — Substring-Match)
- `apps/web/src/settings/sieve/rule-model.ts:368-370` (`sanitizeComment` ersetzt nur `\r`/`\n`)

**Problem:** (a) LINE/PARAGRAPH SEPARATOR im Namen wird roh ins JSON geschrieben (`JSON.stringify`
escapet U+2028 nicht); das Regex bricht davor ab, das JSON ist abgeschnitten → `readRules` → `null` →
das gesamte Skript wird opaque (U+0085 NEL ist nicht betroffen). (b) Ein Regelname, der
`@waxwing:rules:end` enthält oder wie ein Begin-Marker aussieht (`@waxwing:rules:v2 {}`), erzeugt eine
Kommentarzeile, die der Parser als Marker nimmt; auch `x\n# @waxwing:rules:end` trifft, weil
`sanitizeComment` den Umbruch flacht. Das String-Escaping selbst ist RFC-5228-konform (§2.4.2, §2.7.1
mit `a"b\c*d?e` für alle fünf Match-Arten geprüft).

**Auswirkung:** (a) Nach dem Speichern „someone else's script“, read-only; „adopt“ hängt den Marker in
die Preamble, der nächste Parse sieht zwei Marker → dauerhaft opaque per UI. (b) Doppelte Ausführung,
`stop`-Semantik verschoben. Nur bei ungewöhnlichen Namen (Paste), daher low.

**Lösungsansatz:** Metadaten-JSON vor dem Schreiben um `\u2028`/`\u2029` escapen
(`.replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')` — `JSON.parse` liest das zurück) oder
das Marker-Regex auf `([^\r\n]*)` umstellen; `sanitizeComment` zusätzlich `@waxwing:` neutralisieren
(z. B. → `@waxwing_`) — der Name bleibt im JSON unverändert, nur der Kommentar wird entschärft.
Round-Trip-Tests mit den vier Namen aus der Gegenprüfung.

**Aufwand:** S

**Verifikation:** Reproduziert (`sieve-verify*.test.ts`): Name `a\u2028b` →
`parseScript(buildScript(…)).opaque === true`; Name `@waxwing:rules:end` → `rules: 2`, `trailer`
enthält Regelkörper und echten End-Marker; zwei weitere Varianten. Gegenprüfung: bestätigt.

(Quelle: APP-11)

### R-83 — [LOW] Der W-17-Issuer-Check greift auch bei ephemeren Sessions, deren Token gar nicht aus dem Store stammt (vgl. W-17)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Auth)

**Fundstelle(n):**
- `apps/web/src/auth/controller.ts:311-317` (liest den AuthRecord bedingungslos; Kommentar `:308-310` deckt nur „absent ⇒ ephemeral“, nicht die Umkehrung)
- `apps/web/src/auth/token-store.ts:87-90` (ephemeres Token kommt aus `ephemeralRefresh`, nicht aus dem Store)

**Problem:** Der Check soll die **gemeinsam gespeicherte** Kopie schützen; bei einer
Public-Computer-Session ist das gesendete Token nachweislich das eigene. Randfall: der fremde Record
entsteht nur, wenn ein Restore an `connectSession` scheiterte oder ein zweiter Tab durable bei einem
anderen Issuer angemeldet ist.

**Auswirkung:** Ephemere Session verliert nach einer Stunde grundlos die Anmeldung → Re-Auth-Dialog.

**Lösungsansatz:** `TokenStore.isEphemeral()` ergänzen; den Record-Check nur ausführen, wenn das Token
aus dem Store kam.

**Aufwand:** S

**Verifikation:** Reproduziert: AuthRecord + RT eines anderen Issuers im Store, ephemere
OAuth-Anmeldung bei Issuer X, nach Ablauf des Access-Tokens `getAccessToken()` → `AuthExpiredError: The
stored credential belongs to a different sign-in`, null Refresh-Grants. Gegenprüfung: bestätigt.

(Quelle: APP-12)

### R-84 — [LOW] Nach fehlgeschlagenem Public-Computer-Callback bleibt `ephemeralRef`/Replica-Name gesetzt; eine anschließende Basic-Anmeldung mit „stay signed in“ wird halb-durable (vgl. W-02)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / App (Session)

**Fundstelle(n):**
- `apps/web/src/app/session/SessionProvider.tsx:406-409` (`markEphemeral()` vor `completeRedirect()`), `:467-480` (catch setzt `ephemeralRef` nicht zurück)
- `apps/web/src/app/session/SessionProvider.tsx:564` (`submitBasic` kann den Zustand nur setzen, nicht aufheben), `:265-269` (`markEphemeral` idempotent)
- `apps/web/src/app/onboarding/LoginForm.tsx:69` (Formular startet mit `publicComputer = false`)

**Problem:** Der Stash bleibt bewusst fail-closed (W-02-Fix) — für den OAuth-Retry korrekt, weil der
Redirect neu lädt. Ein Basic-Retry im selben Page-Load erbt den ephemeren Replica-Namen, obwohl der
Nutzer „stay signed in“ wählt; das Formular zeigt einen anderen Modus an, als tatsächlich gilt.

**Auswirkung:** Dauerhafte Anmeldung ohne dauerhaften Cache; `pagehide` löscht das Replica, nächster
Kaltstart voller Resync. Formular und Modus widersprechen sich.

**Lösungsansatz:** Im Boot-catch nach fehlgeschlagenem Callback `ephemeralRef.current = false;
releaseEphemeralClaim(); resetReplica()` (das Replica ist noch nicht geöffnet, `setReplicaName` wirft
also nicht); der Zustand ergibt sich dann allein aus dem Stash (nächster OAuth-Versuch) bzw. der nächsten
Nutzerwahl (Basic). Zusammen mit R-32 (derselbe catch-Block).

**Aufwand:** S

**Verifikation:** Reproduziert: `STASH_PUBLIC_KEY` gesetzt, `completeRedirect` wirft → Replica-Name
`waxwing-replica-eph-…`; danach `submitBasic(…, staySignedIn: true, publicComputer: false)` →
Credentials + AuthRecord durable, Replica bleibt `eph-…`, Registry wird nicht geschrieben.
Gegenprüfung: bestätigt.

(Quelle: APP-13)

### R-85 — [LOW] `SecretStore` cached ein rejected `dbPromise`; `wipe()` wirft es weiter, bevor es zurückgesetzt wird

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / App (Auth)

**Fundstelle(n):**
- `apps/web/src/auth/secret-store.ts:97-127` (`openDb` memoisiert auch die Rejection; `onerror` in `:124` setzt `dbPromise` nicht zurück)
- `apps/web/src/auth/secret-store.ts:206-212` (`await this.dbPromise` vor `this.dbPromise = null`)

**Problem:** Ein einmaliger Open-Fehler macht die Instanz für die Lebensdauer der Seite unbrauchbar;
`wipe()` scheitert am gecachten Fehler, ohne `deleteDatabase` zu versuchen → `logout()` meldet
`incomplete` („your data is still on this machine“), obwohl nichts gespeichert wurde.

**Auswirkung:** Falsche Warnung beim Sign-out; kein Retry ohne Reload.

**Lösungsansatz:** Im `onerror` von `openDb` `this.dbPromise = null` setzen; in `wipe()` den `await` in
try/catch nehmen und `deleteDatabase` trotzdem aufrufen.

**Aufwand:** S

**Verifikation:** Reproduziert mit einem `IDBFactory`-Fake, dessen `open` mit `UnknownError`
scheitert: zweiter `get` → `rejected: UnknownError` ohne neuen `open`, `wipe()` → `rejected`,
`deleteDatabase` nie aufgerufen. Gegenprüfung: bestätigt.

(Quelle: APP-14)

### R-86 — [LOW] Identitäts- und Vacation-Formular verlieren ungesicherte Eingaben beim Sektionswechsel ohne Rückfrage

**Status:** [ ] offen

**Kategorie / Bereich:** correctness (UX) / App (Settings)

**Fundstelle(n):**
- `apps/web/src/settings/IdentityForm.tsx:65`, `apps/web/src/settings/IdentitiesSection.tsx:340-355` (inline gerendert, `editing !== null &&`; der `Dialog` ab `:365` bestätigt nur das Löschen), `apps/web/src/settings/VacationSection.tsx:113` (Draft im Komponentenstate)
- `apps/web/src/settings/SettingsPage.tsx:596-609` (tauscht `detail.render()` beim Slug-Wechsel ohne Guard)
- Gegenbeispiel: `apps/web/src/settings/sieve/RuleForm.tsx:130`, `apps/web/src/settings/TemplatesSection.tsx:126` (`Dialog confirmDiscard`)

**Problem:** Die inline gerenderten Formulare werden beim Klick auf einen anderen Rail-Eintrag, das „‹
Settings“-Back-Link (Phone, `:598-604`) oder eine Route außerhalb der Settings ohne Warnung unmounted;
die Dialog-Editoren derselben Seite bestätigen das Verwerfen.

**Auswirkung:** Phone: mehrzeilige Signatur getippt, „‹ Settings“ versehentlich getroffen → Text weg.

**Lösungsansatz:** Dirty-Flag (`identity-model.ts:148 isDirty`) hochreichen und in `SettingsPage` vor
dem Sektionswechsel einen `confirmDiscard`-Dialog zeigen; alternativ beide Formulare wie `RuleForm` in
einen `Dialog` mit `confirmDiscard` legen (Muster vorhanden).

**Aufwand:** M

**Verifikation:** Code gelesen. Gegenprüfung: bestätigt (Kategorie eher UX/correctness als a11y).

(Quelle: APP-15)

### R-87 — [LOW] `StorageSection.freeUp` meldet einen fehlgeschlagenen Maintenance-Lauf als „Nothing to free up“

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / App (Settings)

**Fundstelle(n):**
- `apps/web/src/settings/StorageSection.tsx:43-53` (`forcedMaintenance`: `null` für „kein Engine“ und — via `engine.ts:1053` — für „Lauf fehlgeschlagen“), `apps/web/src/settings/StorageSection.tsx:94-107` (`freeUp`: `null`/`0` → `nothingToFree`)
- `apps/web/src/sync/engine/engine.ts:1053` (`runMaintenance` hängt `.catch(() => null)` an den Lauf)

**Problem:** Die im Erstbericht behauptete unhandled rejection gibt es nicht (`runMaintenance` fängt
selbst); der Rest bleibt: der Fehlerfall (Quota, Dexie, blockierte Transaktion) ist im Rückgabewert
nicht vom Leerfall zu unterscheiden.

**Auswirkung:** „Free up space now“ auf voller Platte scheitert und meldet „Nothing to free up“.

**Lösungsansatz:** `runMaintenance` den Fehler als eigenen Ergebniswert (z. B. `{ failed: true }`) oder
per Rethrow im `force`-Fall liefern lassen und in `freeUp` mit `toast({ tone: 'danger', title:
t('settings.offline.freeUpFailed') })` (neuer Key, 14 Locales) unterscheiden.

**Aufwand:** S

**Verifikation:** Code gelesen (`engine.ts:1038-1061`, `StorageSection.tsx:43-107`). Gegenprüfung:
abgeschwächt.

(Quelle: APP-16)

### R-88 — [LOW] Zeitstempel werden in beide Richtungen in der falschen Grammatik geschrieben: `Timestamp`-Daten und `REV`/`updated`

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Lib (jscontact)

**Fundstelle(n):**
- `packages/jscontact/src/to-vcard.ts:201-202` (`formatVCardDate`: `Timestamp.utc` wird roh geschrieben), `packages/jscontact/src/to-vcard.ts:385` (`REV: card.updated` roh)
- `packages/jscontact/src/from-vcard.ts:602` (`updated: unescapeText(revLine.value).trim()` roh)
- Kontext App-Kette: `apps/web/src/contacts/contact-io.ts:249-257`, `apps/web/src/sync/engine/contact-mutations.ts:78-90`, `apps/web/src/sync/engine/outbox.ts:260-264`, `:2094` (die importierte Karte geht inkl. `updated` in `ContactCard/set create`; `cardCreateProps` löscht nur `id`)

**Problem:** vCard 4.0 verlangt für `timestamp` (REV) und die Zeitform von `date-and-or-time` das
ISO-8601-Basisformat ohne Bindestriche und Doppelpunkte (RFC 6350 §4.3.5, §6.7.4 Beispiel
`REV:19951031T222710Z`); JSContact verlangt für `updated` und `Timestamp.utc` RFC 3339 mit `Z` (RFC 9553
§1.4.5, §2.1.10, §2.8.1). Das Paket kopiert beide Werte unverändert von einer Welt in die andere.
Herabgestuft (medium → low): der einzige belegte Datenverlust betrifft die `Timestamp`-Form von
Anniversaries, die der eigene Importer nie erzeugt (nur Server-Karten); das nicht konforme `REV` wird
von gängigen Parsern toleriert; ob Stalwart ein nicht-RFC-3339-`updated` ablehnt, bleibt ohne Server
Annahme. Apples `REV:2026-07-01T09:12:00Z` ist in vCard **3.0** konform (RFC 2426 §3.6.4).

**Auswirkung:** `anniversaries.a1.date = { utc: '1982-04-15T00:00:00Z' }` →
`BDAY;PROP-ID=a1:1982-04-15T00:00:00Z` (ungültiges vCard 4.0) → eigener Re-Import: Geburtstag weg
(verstärkt durch R-34); `OUTLOOK_EXPORT` (`REV:20260701T091200Z`) → `updated: "20260701T091200Z"` →
wandert per `ContactCard/set create` als ungültige `UTCDateTime` an den Server; Export einer
Server-Karte → `REV:2026-07-01T09:12:00Z` (in der Praxis toleriert).

**Lösungsansatz:** Zwei Funktionen in `vcard/value.ts`: `toVCardTimestamp('2026-07-01T09:12:00Z') →
'20260701T091200Z'` und `fromVCardTimestamp`, die Basis- UND Erweiterungsform (3.0-Exporte) akzeptiert
und `undefined` liefert, wenn keine passt (dann `updated` weglassen statt Müll senden).
`formatVCardDate` für `Timestamp` und `REV`/`updated` darauf umstellen. Tests: `toVCard(fromVCard(x))`
für `OUTLOOK_EXPORT`/`APPLE_EXPORT` mit expliziter `REV`-Erwartung, Roundtrip einer
`Timestamp`-Anniversary. App-seitig klären (ein Aufruf gegen den Dev-Stalwart), ob `updated` bei
`create` überhaupt gesendet werden soll — RFC 9610 §3 sagt nichts zur Client-Setzbarkeit.

**Aufwand:** S

**Verifikation:** Scratch-Test (`verify-lib/jscontact.log`, „LIB-02“), Code der App-Kette gelesen.
Gegenprüfung: abgeschwächt, medium → low, RFC-Abschnitte korrigiert.

(Quelle: LIB-02)

### R-89 — [LOW] vCard 2.1 mit `ENCODING=QUOTED-PRINTABLE` wird als Zeichensalat importiert, ohne Meldung

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Lib (jscontact)

**Fundstelle(n):**
- `packages/jscontact/src/vcard/lex.ts:59-88` (`unfold` kennt keine QP-Soft-Line-Breaks `=CRLF`)
- `packages/jscontact/src/vcard/value.ts:59-81` (`unescapeText` — keine QP-Dekodierung; `ENCODING`/`CHARSET` werden nirgends ausgewertet)
- `packages/jscontact/README.md:64-77` („Known limits“ ohne 2.1/QP/CHARSET)

**Problem:** vCard 2.1 kodiert Nicht-ASCII mit `ENCODING=QUOTED-PRINTABLE` (meist
`CHARSET=Windows-1252`) und bricht lange Werte mit `=` am Zeilenende um. Nichts davon wird erkannt; der
Rohwert wird als Klartext übernommen. Herabgestuft (medium → low): FR-CON-06
(`functional-specification.md:474`) verspricht vCard-**4.0**-Import, die README nennt 3.0-Form als
gelesen; 2.1/QP liegt außerhalb des erklärten Umfangs — eine Lücke, kein Fehler in vorhandener Logik.
Was bleibt, ist die Stille. Dass klassisches Outlook für Windows 2.1 mit QP exportiert, ist verbreitet
dokumentiert, konnte offline aber nicht gegen eine echte Exportdatei geprüft werden.

**Auswirkung:** Kontakt mit Namen `J=C3=BCrgen M=C3=BCller` und abgeschnittener Notiz, „1 Kontakt
importiert“, `skipped` meldet nur die Folgezeile als `noColon`.

**Lösungsansatz:** Minimal (S): `ENCODING=QUOTED-PRINTABLE` bzw. `VERSION:2.1` im Lexer erkennen und
die betroffenen Zeilen mit neuem `SkippedLine.reason` (`unsupportedEncoding`) melden statt roh zu
übernehmen; README „Known limits“ ergänzen. Vollständig (M): Soft-Breaks vor dem Unfold
zusammenziehen, QP zu Bytes dekodieren, über `TextDecoder(charset ?? 'utf-8')` wandeln (Windows-1252
ist in `TextDecoder` verfügbar).

**Aufwand:** S (melden) / M (dekodieren)

**Verifikation:** Scratch-Test: `N;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:M=C3=BCller;J=C3=BCrgen` →
`full: 'J=C3=BCrgen M=C3=BCller'`, Soft-Line-Break-Fortsetzung als `noColon` übersprungen.
Gegenprüfung: abgeschwächt, medium → low.

(Quelle: LIB-04)

### R-90 — [LOW] Parameter gemappter Properties gehen beim Roundtrip verloren (`PID`, `ALTID`, `LANGUAGE`, `VALUE=uri` auf `TEL`)

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Lib (jscontact)

**Fundstelle(n):**
- `packages/jscontact/src/to-vcard.ts:81-95` (`entryParams` schreibt nur `PROP-ID`/`TYPE`/`PREF`/`LABEL`, plus `CC`, `SORT-AS`, `MEDIATYPE`, `SERVICE-TYPE` an den jeweiligen Stellen)
- `packages/jscontact/src/from-vcard.ts:338-353`, `:355-378` (nur `TYPE`/`PREF`/`LABEL` gelesen)

**Problem:** Für typisierte Felder werden nur bekannte Parameter übernommen; RFC 6350 §5.4 `ALTID`,
§5.5 `PID`, §5.1 `LANGUAGE` und `VALUE` verschwinden. `TEL;VALUE=uri:tel:…;ext=102` wird als TEXT
re-exportiert (der Wert selbst überlebt den Roundtrip, verloren gehen Typisierung und Parameter).

**Auswirkung:** Für CardDAV-Clients, die `PID`/`CLIENTPIDMAP` zum Zusammenführen nutzen, ist die
Identität weg; `LANGUAGE` auf FN/N ebenfalls. README nennt das nicht unter „Known limits“.

**Lösungsansatz:** Nicht ausgewertete Parameter je Eintrag in `vCardParams` (RFC 9555 §2.15.2)
mitführen und in `entryParams` zurückschreiben; mindestens in der README dokumentieren.

**Aufwand:** M

**Verifikation:** Code gelesen; Re-Export des RFC-Beispiels im Scratch-Test zeigt
`TEL;PROP-ID=tel1;TYPE=voice,work;PREF=1:tel:+1-418-656-9254\;ext=102` ohne `VALUE=uri`.
Gegenprüfung: bestätigt, RFC-Stelle korrigiert.

(Quelle: LIB-05)

### R-91 — [LOW] W-25 unvollständig: drei Sondierungen indizieren `session.capabilities`/`session.accounts` weiterhin ohne Schutz — beim Polling stirbt der Kanal still (vgl. W-25)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Lib (jmap)

**Fundstelle(n):**
- `packages/jmap/src/session.ts:317` (`getWebPushVapidCapability`: `session.capabilities[…]`; Aufrufer `apps/web/src/notify/capability.ts:21`, `apps/web/src/notify/push-reconcile.ts:230`)
- `packages/jmap/src/push/websocket.ts:49` (`getWebSocketCapability`: `session.capabilities[…]`, aufgerufen aus `isEligible` in `channel.ts:186`)
- `packages/jmap/src/push/polling.ts:112`, `:124-127` (`resync(session)`: `Object.keys(session.accounts)` auf der NEU geholten Session, außerhalb des `try` in `:94-104`)

**Problem:** `isSessionShape` (`session.ts:72-81`) verlangt `capabilities`/`accounts` bewusst nicht;
die drei Stellen wurden beim W-25-Fix nicht angepasst (`git diff 1eb3789..e78e32b`: PR #54 hat nur
`session.ts` angefasst, nicht `push/*`). Beim Polling liegt der Zugriff hinter dem `try/catch` in
`tick()`: ein Wurf dort ist eine unbehandelte Rejection, `scheduleNext()` (`:114`) wird nie erreicht.

**Auswirkung:** Der Kanal meldet „open“ und pollt nie wieder, ohne `onError`. Erreichbar bleibt die
W-25-Form „accounts vorhanden, capabilities fehlt“.

**Lösungsansatz:** `session.capabilities?.[…]` an beiden Stellen; in `polling.ts`
`Object.keys(session.accounts ?? {})` und den Rest von `tick()` nach dem Fetch in den Fehlerpfad
(`reportClosed(toError(e))`) einbeziehen. Tests analog `session.test.ts` („answers not advertised for a
session without capabilities“) und ein Polling-Test mit `accounts`-loser Antwort.

**Aufwand:** S

**Verifikation:** Scratch-Test: auf einer Session ohne `capabilities`/`accounts`: `getCoreCapability` →
`null`, `hasCapability` → `false` (W-25 greift), `getWebPushVapidCapability` und
`getWebSocketCapability` → `TypeError`; `PollingChannel` gegen Session ohne `accounts`: `status=open`,
genau ein Fetch, unhandled `TypeError`, nach allen Timern weiterhin ein Fetch. Gegenprüfung: bestätigt.

(Quelle: LIB-08)

### R-92 — [LOW] `postApi` validiert die Hülle, nicht die Invocations: `methodResponses: [null]` wird zum `TypeError` (vgl. W-26)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Lib (jmap)

**Fundstelle(n):**
- `packages/jmap/src/transport.ts:109-113` (`isJmapResponse`: nur `Array.isArray(methodResponses)`)
- `packages/jmap/src/chunking.ts:197-201`, `packages/jmap/src/request.ts:135-139` (`response[2]` auf ungeprüftem Element)
- `packages/jmap/src/transport.ts:33-42` (verwaister Docblock: „TRANSIENT … RETRIES“ — genau der Fehlertyp, den die Hüllenprüfung schließen sollte; siehe R-97)

**Problem:** Ein Element, das kein 3-Tupel `[string, unknown, string]` ist, erreicht
`reassembleResponses`/`MethodResponses` und wirft roh; keine `JmapError`-Instanz, also fällt es in
`classifyThrown` (`conflict.ts:229-232`) auf `retry` — die Sync-Schicht wiederholt mit Backoff.

**Auswirkung:** Ein Server/Proxy, der dauerhaft so antwortet, wird endlos wiederholt statt einmal sauber
gemeldet.

**Lösungsansatz:** `isJmapResponse` um `methodResponses.every(isInvocationShape)` erweitern
(`Array.isArray(v) && typeof v[0] === 'string' && typeof v[2] === 'string'`), Fehlertext „Malformed
method response invocation (RFC 8620 §3.4)“. Vorbild im Repo: `isMethodError` (`errors.ts:183-191`).

**Aufwand:** S

**Verifikation:** Scratch-Test: `[null]` → `TypeError: Cannot read properties of null (reading '2')`
aus `reassembleResponses`; `[['Core/echo']]`, `['str']`, `[['Core/echo', {}, 42]]` → `Error: No
response for method call "c0"`. Gegenprüfung: bestätigt, Fundstellen korrigiert.

(Quelle: LIB-09)

### R-93 — [LOW] Zwei Tests belegen nicht, was ihr Name verspricht (`blob.test.ts` „no streaming“, `timeout.test.ts` Fake-Timer) (vgl. W-11, W-16)

**Status:** [ ] offen

**Kategorie / Bereich:** tests / Lib (jmap)

**Fundstelle(n):**
- `packages/jmap/src/blob.test.ts:127-137` („buffers the body (no streaming) when no progress callback is given“)
- `packages/jmap/src/timeout.test.ts:16-38` (`vi.useFakeTimers()` + `advanceTimersByTimeAsync(60)`)
- `packages/jmap/src/test-support.ts:70-84` (`jmapPostMock` ignoriert `init.signal`)

**Problem:** (a) `new Response(Uint8Array).body !== null` unter Node → der Test nimmt seit W-11 den
Streaming-Zweig (`blob.ts:197-219`) und prüft nur den Inhalt; er pinnt namentlich das ALTE Verhalten und
würde eine Rückkehr zum ungeschützten `arrayBuffer()`-Pfad nicht bemerken. (b) `AbortSignal.timeout`
hängt nicht an den gefälschten Timern; der Test besteht, weil beim `await settled` real 50 ms
verstreichen — wer die Deadline im Test auf den Default (30 s) stellt, bekommt einen hängenden Test.
(c) Der Fetch-Mock reicht `signal` nie durch, weshalb `timeout.test.ts` eigene Mocks bauen musste.

**Auswirkung:** Kein Fehlverhalten im Produkt; Regressionsschutz schwächer als die Testnamen
suggerieren (W-11-Regression bliebe unentdeckt).

**Lösungsansatz:** (a) Test umbenennen und einen `ReadableStream`-Body ohne `onProgress` mit `maxBytes`
liefern, der den Abbruch nachweist (`reader.cancel` beobachten). (b) `vi.useFakeTimers()` entfernen
oder `AbortSignal.timeout` stubben. (c) `jmapPostMock` um einen `signal`-Hook erweitern.

**Aufwand:** S

**Verifikation:** Scratch-Test: `AbortSignal.timeout(50)` unter `vi.useFakeTimers()` +
`advanceTimersByTimeAsync(60)` → `aborted=false`; nach 80 ms Echtzeit → `aborted=true`. Gegenprüfung:
bestätigt, Fundstellen korrigiert.

(Quelle: LIB-10)

### R-94 — [LOW] `RequestBuilder.send()` kann keine `CallOptions` (insbesondere `signal`) transportieren — der Sync-Port sendet 29× ohne Abbruchsignal (vgl. W-16)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Lib (jmap) + Sync

**Fundstelle(n):**
- `packages/jmap/src/request.ts:74` (Executor-Signatur `(builder) => Promise<MethodResponses>`), `:112-116` (`send()` ohne Parameter)
- `packages/jmap/src/client.ts:85-87` (`request()` bindet `this.call(builder.invocations)` ohne Optionen)
- `apps/web/src/sync/engine/port.ts` (29× `builder.send()`, kein `signal`; `engine.ts:277` besitzt `stopController`)

**Problem:** `JmapClient.call` akzeptiert `signal`/`using`/`createdIds`, der fluent Pfad nicht. Die
Engine kann ihr Abbruchsignal an keine Port-Anfrage hängen — nicht wegen App-Nachlässigkeit, sondern
weil die API es nicht zulässt. W-16s Maßnahme umfasste ausdrücklich „`stopController.signal` durch
`createJmapPort` bis in `builder.send()` durchreichen“; der Fix-Commit `116a7f9` hat stattdessen
Deadline plus `SIGN_OUT_STOP_BUDGET_MS = 5000` gewählt. Die Sync-Gegenprüfung merkt an, dass der
fehlende Abbruch für dispatchte Zeilen bewusst ist (W-15-Kommentar) und für R-28 Voraussetzung ist —
das betrifft die Replay-Anfragen, nicht die Delta-Legs.

**Auswirkung:** Kontowechsel/Fleet-Rebuild warten auf laufende Sync-Requests bis zur 30-s-Deadline;
beim Sign-out läuft der Request nach dem 5-s-Budget neben dem Replica-Wipe weiter. Ein
`PushSubscription/set` mit `using`-Erweiterung muss den `client.call([...])`-Pfad nehmen (so in
`push-subscribe.ts:332-342`).

**Lösungsansatz:** `send(options?: CallOptions)` → Executor-Signatur `(builder, options) =>
this.call(builder.invocations, options)`; dann im Port das Engine-Signal durchreichen — für die
Delta-Legs; Replay-Anfragen dispatchter Zeilen weiterhin durchlaufen lassen (R-28).

**Aufwand:** S (Lib) + S (Port)

**Verifikation:** Code gelesen; grep über `.send()`/`client.call(` in `apps/web/src`; W-16-Commit und
`SessionProvider` gelesen. Gegenprüfung: bestätigt, Auswirkung korrigiert.

(Quelle: LIB-11)

### R-95 — [LOW] `uploadBlob` castet die Serverantwort ungeprüft (`as UploadResult`) (vgl. W-26)

**Status:** [ ] offen

**Kategorie / Bereich:** robustness / Lib (jmap)

**Fundstelle(n):**
- `packages/jmap/src/blob.ts:142` (`const result = (await response.json()) as UploadResult`)
- `packages/jmap/src/blob.ts:21-30` (`UploadResult`: `accountId`, `blobId`, `type`, `size`)
- `apps/web/src/compose/use-attachment-upload.ts:48-50` (`makeBlobUploader` liest `result.blobId`)

**Problem:** Dieselbe Klasse, die die Fix-Commits für `getSession` (`session.ts:51-60`) und `postApi`
(`transport.ts:94-99`) geschlossen haben („narrowed, not cast“).

**Auswirkung:** Anhang-Upload meldet einen nichtssagenden Fehler bzw. der Sendeversuch scheitert später
mit einer Server-Meldung (`invalidProperties`), die den Upload nicht nennt.

**Lösungsansatz:** `const raw: unknown = await response.json().catch(() => undefined)`; Narrowing auf
`{ accountId: string; blobId: string; type: string; size: number }` → sonst `JmapError('Malformed
upload response (RFC 8620 §6.1)')`.

**Aufwand:** S

**Verifikation:** Scratch-Test: HTML-Body mit Status 200 → `SyntaxError` aus `response.json()` (kein
`JmapError`); `{}` → `blobId: undefined`; `null` → `uploadBlob` liefert `null`, `TypeError` erst in
`makeBlobUploader`. Gegenprüfung: bestätigt.

(Quelle: LIB-12)

### R-96 — [LOW] Remote-Medien werden als „blockiert und freigebbar“ gemeldet, die Frame-CSP lässt `<video>`/`<audio>`-`src` auch nach Freigabe nie zu

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / Lib (mail-html)

**Fundstelle(n):**
- `packages/mail-html/src/sanitize.ts:140-145` (`kindForAttr` → `'media'` für `video`/`audio`/`source`)
- `packages/mail-html/src/frame.ts:172-184` (`framePolicy`: `default-src 'none'`, nur `img-src` bekommt `https:` unter `allowRemote`; kein `media-src`)
- `apps/web/src/mail/MessageView.tsx:518`, `:1170` (die App liest nur `hasRemoteContent`)

**Problem:** Der Sanitizer nimmt unter `allowRemote` `<video src>`/`<audio src>` wieder auf; die
innere CSP blockt `media-src` weiterhin. Korrekturen der Gegenprüfung: einen Zähler blockierter
Ressourcen gibt es im Banner nicht; `poster` wird laut HTML-Spec unter `img-src` geladen, lädt also nach
Freigabe — nur `src` bleibt unter `default-src 'none'`. Die CSP ist Defense-in-Depth und der Grund,
warum das nur eine Funktionslücke ist. Kein ADR und keine Doku-Stelle nennt `media-src`.

**Auswirkung:** „Remote-Inhalte laden“ zeigt für eine Mail mit `<video>` das Poster, das Video spielt
aber nie und nichts sagt warum. Seltene Eingabe.

**Lösungsansatz:** Entweder `media-src https:` unter `allowRemote` in `framePolicy` (plus
`blob:`/`data:` falls gewünscht), oder Medien im Sanitizer immer verwerfen und NICHT als
`hasRemoteContent` melden. Entscheidung als ADR oder Kommentar in `framePolicy` festhalten.

**Aufwand:** S

**Verifikation:** Scratch-Test: unter `allowRemote` gibt `sanitize` `<video src poster controls>` und
`<audio src>` unverändert aus (`blocked=[]`, `hasRemote=true`), im Default blockiert es beide mit `kind:
'media'`; Frame-CSP ohne `media-src`. Gegenprüfung: bestätigt, Auswirkung korrigiert.

(Quelle: LIB-13)

### R-97 — [LOW] `postApi` hat seinen Docblock verloren — er hängt seit dem W-16-Commit vor `DEFAULT_REQUEST_TIMEOUT_MS` (vgl. W-16)

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / Lib (jmap)

**Fundstelle(n):**
- `packages/jmap/src/transport.ts:33-42` (verwaister Docblock „POSTs a JMAP request … narrowed rather than cast …“)
- `packages/jmap/src/transport.ts:43-57` (Docblock der Konstante), `:74` (`postApi` ohne JSDoc)

**Problem:** In der Gegenprüfung gefunden: `git diff 1eb3789..e78e32b -- packages/jmap/src/transport.ts`
(Commit `116a7f9`) zeigt, dass Konstante und `withDeadline` zwischen den bestehenden
`postApi`-Docblock und die Funktion eingefügt wurden. Zwei `/** … */`-Blöcke stehen direkt
hintereinander; TypeScript/IDEs hängen nur den nächsten an das Symbol. Die Begründung für das Narrowing
(die W-26-Klasse, auf die R-92 und R-95 verweisen) ist beim Hover auf `postApi` unsichtbar.

**Auswirkung:** Irreführende Dokumentation an der zentralen Transportfunktion; keine Laufzeitwirkung.

**Lösungsansatz:** Den Block `:33-42` direkt über `export async function postApi` (`:74`)
verschieben.

**Aufwand:** S

**Verifikation:** Diff und Datei gelesen.

(Quelle: LIB-14)

### R-98 — [LOW] Zwei Toasts mit Aktion laufen nach 5 s ab — entgegen ADR-021, und die Primitive erzwingt die Regel nicht

**Status:** [ ] offen

**Kategorie / Bereich:** a11y / UI

**Fundstelle(n):**
- `apps/web/src/mail/SenderCard.tsx:108-111` (Undo nach „Kontakt anlegen“)
- `apps/web/src/outbox/use-conflict-notifier.ts:55-66` („Retry“/„Keep in …“), `:46-47` (`surfaced`-Set: nur einmal je Zeile)
- `apps/web/src/ui/Toast.tsx:25-28`, `:145` (Default unabhängig von `action`), `:152-155`

**Problem:** ADR-021 (Z. 39-40): „A toast that carries an action is raised with `duration: 0`“. Von
sieben `action:`-Aufrufern setzen fünf `duration: 0` (`use-triage.ts:141,173`, `FilesPage.tsx:614`,
`CalendarPage.tsx:605`, `use-update-prompt.ts:127`), zwei nicht; kein Test prüft die Regel in der
Primitive.

**Auswirkung:** Undo nach „Absender als Kontakt anlegen“ und die Konflikt-Aktionen der Outbox
verschwinden nach 5 s; für Tastatur-/Screenreader-Nutzer praktisch unerreichbar (Toast-Region am
Dokumentende). Die Konflikt-Toasts kommen nicht wieder.

**Lösungsansatz:** In `ToastItem`: `const duration = record.duration ?? (record.action ? 0 :
DEFAULT_DURATION)` — die ADR-Regel in der Primitive; ein Test in `Toast.test.tsx` („action ⇒ bleibt“).

**Aufwand:** S

**Verifikation:** Code gelesen, alle sieben Aufrufer geprüft. Gegenprüfung: bestätigt.

(Quelle: UI-07)

### R-99 — [LOW] `initialsFromName` zerschneidet Astral-Zeichen (Emoji) in einsame Surrogate

**Status:** [ ] offen

**Kategorie / Bereich:** correctness / UI

**Fundstelle(n):**
- `apps/web/src/ui/Avatar.tsx:26-34` (`charAt(0)`, `slice(0, 2)`)
- Aufrufer mit Kontakt-/Absendernamen: `apps/web/src/compose/RecipientField.tsx:463,496`, `apps/web/src/mail/MessageRow.tsx:191`, `apps/web/src/mail/SenderCard.tsx:142`, `apps/web/src/mail/MessageView.tsx:1047`

**Problem:** Zweiwort-Namen mit führendem Emoji ergeben ein Ersatzzeichen plus Buchstabe („�Z“). Der
Einzeltoken-Fall zerschneidet nicht (`'🏠Haus'.slice(0,2)` ist das ganze Emoji), liefert aber nur ein
Initial statt zwei. Kein Codepoint-/Segmenter-Muster im Repo (nur `codePointAt` in
`packages/jscontact/src/vcard/write.ts:31`).

**Auswirkung:** Das Initial ist `aria-hidden`, aber sichtbar falsch.

**Lösungsansatz:** Über Codepoints: `Array.from(first)[0]`, `Array.from(parts[0]).slice(0,
2).join('')`; optional `Intl.Segmenter` (Grapheme) für kombinierende Zeichen.

**Aufwand:** S

**Verifikation:** Node: `'🏠 Zuhause'` → `"\uD83CZ"`, `'😀 Bob'` → `"\uD83DB"` (einsame
High-Surrogates); vitest-Fall Einzeltoken rot. Gegenprüfung: bestätigt, präzisiert.

(Quelle: UI-09)

### R-100 — [LOW] Permissions-API-`change`-Listener kann nach dem Effekt-Cleanup registriert werden (Leak)

**Status:** [ ] offen

**Kategorie / Bereich:** react / UI (Notify)

**Fundstelle(n):**
- `apps/web/src/notify/use-notification-permission.ts:63-79`

**Problem:** `status` wird erst im `.then` gesetzt; das Cleanup entfernt nur, was bereits registriert
war. Bei Unmount vor Auflösung (StrictMode-Doppelmount, schneller Wechsel im Settings-Abschnitt) bleibt
ein Listener auf dem `PermissionStatus`. Kein sichtbares Fehlverhalten (der Store dedupliziert), ein
Listener pro Mount-Zyklus.

**Auswirkung:** Leak ohne sichtbare Folge.

**Lösungsansatz:** `let cancelled = false`; im `.then` bei `cancelled` nicht registrieren; Cleanup
setzt `cancelled = true` (dasselbe Muster wie `use-push-subscription.tsx:89-91`).

**Aufwand:** S

**Verifikation:** Reproduziert mit `renderHook` und einem `navigator.permissions.query`, das erst nach
`unmount()` auflöst: `addEventListener('change')` wird trotzdem aufgerufen. Gegenprüfung: bestätigt.

(Quelle: UI-10)

### R-101 — [LOW] Kommentar in `pwa-options.ts` behauptet, der `push`-Listener fehle noch

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / UI (PWA)

**Fundstelle(n):**
- `apps/web/src/pwa/pwa-options.ts:8-12` („M3.5 expected M3.6 to add `push` and `pushsubscriptionchange` too; … so the listeners are still absent“)
- `apps/web/src/sw/sw.ts:213` (`push`-Listener existiert seit M4.0/ADR-017)

**Problem:** In der Gegenprüfung von UI-08 gefunden. Der Kommentar beschreibt den Stand vor ADR-017 und
nennt die Client-Hälfte eine „open owner decision“; beides ist überholt. Wer den Worker nach dem
Kommentar beurteilt, sucht die Push-Verarbeitung an der falschen Stelle.

**Auswirkung:** Irreführende Dokumentation; keine Laufzeitwirkung.

**Lösungsansatz:** Kommentar auf den Stand bringen: `push` und `notificationclick` vorhanden
(ADR-017), `pushsubscriptionchange` bewusst nicht (siehe „Nicht bestätigt“, UI-08).

**Aufwand:** S

**Verifikation:** Code gelesen.

(Quelle: UI-11)

### R-102 — [LOW] `SECURITY.md` behauptet `sandbox="allow-same-origin"` „and nothing else — no allow-popups“; der Code setzt `allow-popups allow-popups-to-escape-sandbox`

**Status:** [ ] offen

**Kategorie / Bereich:** security (Doku-Zusage weicht vom Code ab) / Infra

**Fundstelle(n):**
- `SECURITY.md:39-42` („mounted `sandbox="allow-same-origin"` **and nothing else** — … no `allow-popups` …“)
- `packages/mail-html/src/frame.ts:406` (`'allow-same-origin allow-popups allow-popups-to-escape-sandbox'`)
- `packages/mail-html/src/link-host.ts:4-5` (Kommentar: „`sandbox="allow-same-origin"` with no `allow-scripts`“ — ebenfalls veraltet)
- korrekt: `docs/tech-stack.md:176-179`, `docs/adr/029-…md:84`, `frame.ts:28-34`

**Problem:** Seit ADR-029 öffnen unauffällige Links nativ aus dem Frame; dafür trägt der Sandbox-Wert
zwei Popup-Flags. Die Garantie (kein `allow-scripts`, innerer `script-src 'none'`) bleibt, aber die
wörtliche Zusage in `SECURITY.md` — dem Abschnitt, den ein Prüfer zuerst liest — ist falsch. Keiner der
vier Tests, die `SECURITY.md` nennen, pinnt diesen Satz. Kein Duplikat von W-19/W-20 (andere Aussagen).

**Auswirkung:** Ein Auditor, der `SECURITY.md` mit dem DOM vergleicht, findet eine falsche Aussage in
der zentralen Threat-Model-Zusage; kein funktionaler Schaden.

**Lösungsansatz:** Absatz auf den tatsächlichen Wert umschreiben und begründen, warum die Flags ohne
`allow-scripts` nichts gewähren (Text steht in `frame.ts:28-34` und tech-stack §4.5);
`link-host.ts:4-5` mitziehen. Ein `*.source.test.ts`, das den `sandbox`-String aus `frame.ts` in
`SECURITY.md` wiederfindet, verhindert die nächste Drift.

**Aufwand:** S

**Verifikation:** Code und drei Dokumente gelesen; grep nach `allow-same-origin` in Tests.
Gegenprüfung: bestätigt.

(Quelle: INFRA-03)

### R-103 — [LOW] Versionsdrift ohne Wächter: `@waxwing/mail-html` steht seit sechs Releases auf 0.16.0, acht Doku-Strings nennen v0.15.0, und nichts prüft `apps/web/package.json` gegen den Tag

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / Infra

**Fundstelle(n):**
- `packages/mail-html/package.json:3` (`"version": "0.16.0"`; letzte Änderung `46eeae6` v0.16.0); Release-Commits `d594b05` (v0.17.0) … `2efca77` (v0.22.0) bumpen Root, `apps/web`, `e2e`, `jmap`, `jscontact` — nie `mail-html`
- `CONTRIBUTING.md:153-156` („Bump `package.json`, then the eight version strings … There is no check for this“ — nennt die Workspace-Manifeste nicht)
- noch auf v0.15.0: `README.md:72`, `SECURITY.md:250`, `:261`, `:294`, `docs/deployment.md:74`, `:101`, `:107`, `docs/site/index.html:190` („Status: v0.15.0“)
- `.github/workflows/release.yml:122-130` (Tag nur gegen Root-`package.json`); `scripts/release.mjs:86-92`; `apps/web/vite.config.ts:93-95` (`__WAXWING_VERSION__` aus `apps/web/package.json`); `scripts/check-site.mjs` prüft nur Pfade

**Problem:** Lockstep ist die Absicht (alle Pakete `private: true`, nie veröffentlicht); der manuelle
Prozess verliert Manifeste (`mail-html`) und Doku-Strings (sieben Releases alt). Die im Client
angezeigte Version stammt aus einem Manifest, das kein Check gegen den Tag hält — heute zufällig
konsistent.

**Auswirkung:** Ein Release, bei dem `apps/web/package.json` vergessen wird, baut
`waxwing-web-v0.23.0.tar.gz`, dessen „About“ 0.22.0 sagt — die erste Support-Frage („which
version?“, `vite.config.ts:90-92`) wird falsch beantwortet. Projektseite und Verifikationsbeispiele
nennen ein Tag von vor sieben Releases.

**Lösungsansatz:** (1) In `release.mjs` `version()` zusätzlich prüfen, dass `apps/web`, `e2e` und
`packages/*` dieselbe Version tragen wie das Root, sonst mit Liste abbrechen. (2) Ein `*.source.test.ts`
nach dem Muster von `packages/jscontact/matrix.test.ts`, das die `--source-ref refs/tags/v…`-Beispiele
und die Status-Zeile gegen `package.json` prüft (die zwei historischen v0.10.0-Erwähnungen per
Allowlist). (3) CONTRIBUTING-Schritt 2 um die Workspace-Manifeste ergänzen — oder ein `pnpm bump
<version>`-Einzeiler, der alle sechs Manifeste schreibt.

**Aufwand:** S

**Verifikation:** `git show --stat` der Release-Commits, `git log` der Manifeste, grep über die vier
Dokumente, `release.mjs`, `release.yml`, `vite.config.ts`, `check-site.mjs` gelesen. Gegenprüfung:
bestätigt, präzisiert.

(Quelle: INFRA-04)

### R-104 — [LOW] `contacts.spec.ts`: der Read-only-Adressbuch-Test wird im Gate immer übersprungen (B22-Klasse)

**Status:** [ ] offen

**Kategorie / Bereich:** tests / Infra (E2E)

**Fundstelle(n):**
- `e2e/tests/contacts.spec.ts:33-37` (Header: „an HONEST premise-skip … cannot be provisioned“), `:53-54` (`roBook = await readOnlyBook(…)`), `:359-368` (`test.skip(roBook === null, '… M4.4 groundwork …')`)
- `e2e/stalwart/seed-contacts.mjs:87-90` (`readOnlyBook` sucht ein Buch mit `myRights.mayWrite === false`); `e2e/playwright.write.config.ts:18`; `e2e/write.setup.mjs` (teilt nichts)
- `e2e/stalwart/fixture.mjs:791` (`shareAddressBook(owner, grantee, role)`, seit `7f80f25`, 2026-08-22), `:904` (`revokeAllPimShares`); einziger Aufrufer `e2e/tests/sharing-pim.spec.ts:416` (prüft nur den „New shares“-Streifen)

**Problem:** Die Prämisse des Skips ist seit S-2 überholt — das Fixture kann das Buch mit einem Aufruf
bereitstellen. `grep "Read only" e2e/tests` trifft ausschließlich den übersprungenen Test — keine Suite
prüft FR-CON-01 im Browser. Ein Test, der nie läuft, aber im Bericht als vorhanden erscheint, ist genau
das Muster, das `scripts/integration.mjs` für die jmap-Suiten mit dem Skip-Zähler abstellt.

**Auswirkung:** „a read-only shared book gates writes (FR-CON-01)“ ist im Gate nicht geprüft; ein
Regressionsfehler in der `myRights.mayWrite`-Auswertung der Kontakte-Oberfläche bleibt unbemerkt.

**Lösungsansatz:** Im `beforeAll` `await shareAddressBook('carol', 'alice', 'viewer')`, im
`afterAll` `revokeAllPimShares()`, `test.skip` und den Header-Absatz entfernen. Alternativ den Test
nach `sharing-pim.spec.ts` verschieben. Generell: `scripts/verify-e2e.mjs` könnte nach jeder Suite die
Playwright-Zusammenfassung auf `skipped` prüfen (wie `integration.mjs`), mit Allowlist für die
Browser-bedingten Skips (ADR-029).

**Aufwand:** S

**Verifikation:** Spec, Setup, Seed und Fixture gelesen; grep nach `shareAddressBook|readOnlyBook|Read
only`; `git log -S` für die Einführung von `shareAddressBook`. Gegenprüfung: bestätigt.

(Quelle: INFRA-05)

### R-105 — [LOW] `release.mjs`: `--check` braucht ein System-`unzip` (entgegen der eigenen Begründung), und beide Archive sind nicht byte-stabil

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / Infra

**Fundstelle(n):**
- `scripts/release.mjs:36-42` (Header: „shells out to system binaries … fails outright where one is missing (a minimal CI image, Windows)“), `scripts/release.mjs:149` (`execFileSync('unzip', ['-Z1', paths.stalwart])`)
- `scripts/release.mjs:94`, `:114-116` („byte-stable across machines“, „two builds of the same tree produce comparable archives“)
- `scripts/release.mjs:162-166` (Kommentar sagt Archiv, Code liest `DIST/index.html`)
- `docs/deployment.md:24-25` („build them yourself … `pnpm install && pnpm release`“), `SECURITY.md:269-270` („Reproducible-ish builds … deterministic, sorted file list“)

**Problem:** (1) Der Check-Pfad hängt an `unzip`; ohne (Windows, Minimal-Image) scheitert `pnpm
release` mit `ENOENT`. (2) `archive.file()` übernimmt die Datei-mtime in ZIP- UND TAR-Header
(`archiver/lib/core.js:304-305`); zwei Builds derselben Bytes ergeben in beiden Formaten verschiedene
Archive — die Aussage „tar ist byte-stabil“ des Erstberichts war ein Artefakt seines Skripts. (3) Die
Base-href-Prüfung behauptet, das Archiv zu prüfen, und prüft `dist/`.

**Auswirkung:** Ein Deployer, der der Doku folgt und selbst baut, kann weder ZIP noch TAR mit dem
veröffentlichten Artefakt vergleichen (Hash weicht immer ab); auf einer `unzip`-losen Maschine bricht
der dokumentierte Weg ab. Lokal und auf `ubuntu-latest` ist `unzip` vorhanden.

**Lösungsansatz:** (1) Das Listing aus `archiver`s `entry`-Event sammeln und gegen
`index.html`/`manifest.json` prüfen, oder `unzip` als Voraussetzung nennen und vor dem Build prüfen.
(2) `archive.file(path, { name, date: new Date(0) })` — gemessen: damit sind beide Formate bei gleichem
Inhalt identisch — und den Kommentar auf „stabil bei gleichem Inhalt“ präzisieren; oder den Kommentar
zurücknehmen. (3) Kommentar Z. 162-165 auf `dist/` umformulieren oder den Token aus dem Archiv lesen.

**Aufwand:** S

**Verifikation:** `pack-stability.mjs` mit `archiver@8.0.0` in drei Fällen: gleiche mtime → identisch;
mtime +120 s → zip UND tar verschieden; `{ date: new Date(0) }` → beide identisch. Gegenprüfung:
bestätigt, Reproduktion korrigiert.

(Quelle: INFRA-06)

### R-106 — [LOW] DOMPurify liegt zweimal im Bundle: einmal in `@waxwing/mail-html` (per `noExternal` eingebacken) im eager Chunk, einmal im lazy Composer-Chunk

**Status:** [ ] offen

**Kategorie / Bereich:** performance / Infra (Build)

**Fundstelle(n):**
- `packages/mail-html/tsup.config.ts:12-14` (`noExternal: ['dompurify']` — „so the published package is self-contained (the size budget in .size-limit.js measures the emitted dist …)“); `packages/mail-html/package.json` (`"private": true`)
- `apps/web/src/compose/squire-adapter.ts:15` (`import DOMPurify from 'dompurify'`), `apps/web/src/compose/editor-engine.ts:86` (`await import('./squire-adapter')` — lazy)
- `apps/web/dist/assets/index-*.js` (716 KB roh / 218 KB gz) und `squire-adapter-*.js` (88 KB roh / 28,4 KB gz): je eine DOMPurify-Kopie (`SAFE_FOR_XML`, `ALLOWED_NAMESPACES`, `removeAllHooks`, `3.4.13`)
- `.size-limit.js:8-14` (Paketbudgets „DEFERRED“, nicht erzwungen)

**Problem:** Der Sanitizer-Kern wird zweimal ausgeliefert. Die Begründung „self-contained published
package“ trägt für ein privates, nie veröffentlichtes Paket nicht, und das Budget, auf das sie verweist,
wird nicht gemessen. Zwei Kopien heißt auch: zwei Stellen, die bei einem DOMPurify-Advisory die gefixte
Version brauchen (heute beide 3.4.13, weil pnpm eine Version auflöst — nur solange beide Ranges
zusammenfallen).

**Auswirkung:** Rund 11 KB gz zusätzlich beim ersten Öffnen des Composers; kein Budgetbruch (das
Initial-Budget zählt den lazy Chunk nicht), aber vermeidbarer Doppelversand und eine Wartungsfalle.

**Lösungsansatz:** `noExternal` in `mail-html` entfernen (DOMPurify bleibt `dependency`; Vite
dedupliziert auf eine Kopie im Graph) — oder in `squire-adapter.ts` den Sanitizer über
`@waxwing/mail-html` beziehen. Danach `pnpm size`: Initial-Größe unverändert, Composer-Chunk schrumpft
um ~11 KB gz. Den tsup-Kommentar mitziehen.

**Aufwand:** S

**Verifikation:** grep fester DOMPurify-Bezeichner in den Chunks des Builds vom 29.08. (jünger als
HEAD), `gzip -c | wc -c`, `esbuild --minify` auf `purify.es.mjs` (29 KB roh / 11,0 KB gz), `pnpm why
dompurify`. Gegenprüfung: bestätigt (belegt).

(Quelle: INFRA-07)

### R-107 — [LOW] `engines.node: ">=22"` lässt Node 22 und 26 installieren, die `check:node` dann verweigert — und das Manifest widerspricht der README

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / Infra

**Fundstelle(n):**
- `package.json:9-12` (`"engines": { "node": ">=22" }`), `packages/*/package.json` (ebenfalls `>=22`), `.nvmrc` (`24`)
- `scripts/ci.mjs:278-296` (`checkNodeVersion`: nur der Major aus `.nvmrc`; Node 22 wird wie 26 abgewiesen), `:265-266` („`engines` is advisory“)
- `README.md:445-454` („Node.js **24** — the version in `.nvmrc`, and not just a recommendation“)

**Problem:** Das Manifest erlaubt jeden Major ab 22, obwohl Tests nur auf 24 „known good“ sind. Ein
Newcomer auf 22 oder 26 bekommt eine erfolgreiche Installation (heute mit einer `[WARN]`-Zeile, die im
Install-Rauschen untergeht) und wird erst von `pnpm verify` abgewiesen. Korrektur der Gegenprüfung: mit
pnpm 11.1.1 wirkt `engine-strict=true` aus `.npmrc` nicht (R-112); die Install-Sperre entsteht nur
zusammen mit R-112.

**Auswirkung:** Kein Gate-Loch (`check:node` greift), aber ein späterer und teurerer Fehlerzeitpunkt
als nötig, und ein Manifest, das der README widerspricht.

**Lösungsansatz:** `"node": ">=24 <25"` im Root und in `packages/*` — zusammen mit R-112, sonst bleibt
es bei der Warnung. `checkNodeVersion` bleibt als zweite Verteidigung.

**Aufwand:** S

**Verifikation:** Manifeste, `.npmrc`, `ci.mjs`, README gelesen; pnpm-Sonde (fünf
Konfigurationsvarianten, Kontrolle mit passendem Range). Gegenprüfung: bestätigt, Mechanismus
korrigiert.

(Quelle: INFRA-08)

### R-108 — [LOW] `ci.yml`: `cancel-in-progress: true` gilt auch für Pushes auf `main`; `release.yml` hat keine `concurrency`

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability (CI) / Infra

**Fundstelle(n):**
- `.github/workflows/ci.yml:40-42` (`group: ci-${{ github.ref }}`, `cancel-in-progress: true`; Trigger `push: main`, `pull_request`, `workflow_dispatch`; eingeführt in `22f6568` ohne Begründung)
- `.github/workflows/release.yml:68-76` (kein `concurrency`), `:175-178` (Publish unter `github.ref_name`)

**Problem:** Zwei schnelle Merges auf `main` brechen den Lauf des ersten ab; der erste Commit bleibt
ohne Verdikt („cancelled“). Abgeschwächt: `softprops/action-gh-release` legt das Release unter
`github.ref_name` an, zwei Tag-Pushes ergeben zwei verschiedene Releases — keine Konkurrenz um
„dieselbe Release-Seite“. Was bleibt: bei zwei gleichzeitig erfolgreichen Tag-Läufen zeigt
`releases/latest` ggf. auf das ältere Tag, und der Auto-Update-Pfad
(`releases/latest/download/waxwing-stalwart.zip`) verteilt die ältere Version.

**Auswirkung:** Verlorene Verdikte auf `main`; theoretisch ein `latest`, das auf das ältere von zwei
fast gleichzeitigen Releases zeigt.

**Lösungsansatz:** `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` in `ci.yml`; in
`release.yml` `concurrency: { group: release, cancel-in-progress: false }` (eine Gruppe für alle Tags —
`release-${{ github.ref }}` würde nur denselben Tag serialisieren und den `latest`-Fall nicht abdecken).

**Aufwand:** S

**Verifikation:** Workflows gelesen; `git log -S cancel-in-progress`. Gegenprüfung: abgeschwächt.

(Quelle: INFRA-09)

### R-109 — [LOW] `register-sw.test.ts`: Fake-Timer ohne garantierten Cleanup

**Status:** [ ] offen

**Kategorie / Bereich:** tests / Infra

**Fundstelle(n):**
- `apps/web/src/pwa/register-sw.test.ts:171-187` (`vi.useFakeTimers()` am Anfang, `vi.useRealTimers()` als letzte Zeile, kein `finally`), `:69-71` (`afterEach` nur `resetSwRegistrationState()`; `restoreMocks: true` in `apps/web/vitest.config.ts:31` berührt Timer nicht)
- richtig gelöst: `apps/web/src/mail/use-message-source.test.ts:238-242` (`finally`), `MessageView.test.tsx` (`afterEach`)

**Problem:** Schlägt eine Assertion vor Zeile 186 fehl, bleibt die Uhr für die restlichen Tests der
Datei gefälscht; die Folgefehler verdecken die Ursache. Der zweite Teil des Erstbefunds
(Platzhalter-Test in `calendar-series.test.ts:186-196`) wurde gestrichen — bewusste Entscheidung, siehe
„Nicht bestätigt“.

**Auswirkung:** Bei einer Regression in `startUpdateChecks` ein irreführender Fehlerbericht.

**Lösungsansatz:** `afterEach(() => vi.useRealTimers())` in der Datei ergänzen (oder `try/finally`).

**Aufwand:** S

**Verifikation:** Beide Stellen und `vitest.config.ts` gelesen. Gegenprüfung: abgeschwächt (ein Teil
gestrichen).

(Quelle: INFRA-10)

### R-110 — [LOW] Doku-Drift gegen den Code: `undoSendSeconds`-Obergrenze fehlt, `README`-Skripttabelle veraltet, drei irreführende Kommentare — einer davon deckt eine tote Option

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability (Doku) / Infra

**Fundstelle(n):**
- `docs/configuration.md:180-187` (`undoSendSeconds`: „`0` sends immediately“ — keine Obergrenze) vs. `apps/web/src/app/config.ts:208-218` (`clampUndoSend`: 0–30 s, nicht-numerisch → Default)
- `README.md:470` (`pnpm verify`: „typecheck → lint → test → size“) vs. `package.json` `verify` (zusätzlich `check:node`, `build:libs`, `check:dist`, `check:site`, `check:actions`, `check:nul`)
- `.github/workflows/ci.yml:52` („~3200 Vitest tests“; Stand 5304) — kosmetisch
- `e2e/playwright.audit.config.ts:4` („TEMPORARY … not committed“) — Datei und `e2e/audit/*` sind versioniert (`git ls-files`)
- `packages/jscontact/tsconfig.json:15-17` („The base config sets `baseUrl`“ + `"ignoreDeprecations": "6.0"`) — `tsconfig.base.json` setzt kein `baseUrl`; die Option ist wirkungslos

**Problem:** Ein Betreiber, der `undoSendSeconds: 60` setzt, bekommt stillschweigend 30 — die Referenz
nennt weder Obergrenze noch Clamping, obwohl sie für `cacheDays`/`maxStorageMB` genau diese Regeln
ausführt. Die übrigen Punkte sind Kommentare, die beim nächsten Leser Arbeit erzeugen (jemand „räumt“
die Audit-Konfiguration auf; jemand trägt `ignoreDeprecations` weiter, weil es angeblich nötig ist).

**Auswirkung:** Falsche Erwartung beim Betreiber; Wartungsreibung.

**Lösungsansatz:** In `configuration.md` „Range: 0–30 s, a larger value is clamped, a non-number falls
back to 15“ ergänzen und `config.shipped.test.ts` um eine Prüfung der dokumentierten Ranges gegen
`normalizeConfig` erweitern (31, −1, `'x'`). README-Zeile auf die tatsächliche Kette bringen.
Audit-Kommentar korrigieren. In `jscontact/tsconfig.json` `ignoreDeprecations` samt Kommentar entfernen.

**Aufwand:** S

**Verifikation:** Dateien gelesen; `git ls-files`; `tsc -p` gegen zwei Probe-Konfigurationen im
Scratch (jscontact-Form ohne `ignoreDeprecations`: exit 0; jmap-Form mit `baseUrl`: TS5101).
Gegenprüfung: bestätigt, präzisiert.

(Quelle: INFRA-11)

### R-111 — [LOW] Die Cache-Rezepte schützen nur `sw.js` und `config.json` — `theme.css`, `manifest.json` und `branding/` sind ebenso „edit in place, no rebuild“

**Status:** [ ] offen

**Kategorie / Bereich:** correctness (Betreiber-Doku) / Infra

**Fundstelle(n):**
- `docs/deployment.md:219-225` (`map $uri $waxwing_cache_control`: `no-cache` nur für `/sw.js` und `/config.json`); `docs/deployment.md:266-276` (Caddy: keine Cache-Header)
- `apps/web/src/pwa/sw-routes.ts:60-63` (`DEPLOYMENT_FILES = ['config.json', 'theme.css', MANIFEST_FILENAME]`, `NEVER_PRECACHE` + `branding/**`)
- `apps/web/src/app/theme.ts:66-70` (`theme.css` als gewöhnliches `<link>`); `apps/web/src/sw/sw.ts:104-112` (NetworkFirst), `:152-159` (`cache: 'reload'` nur beim Warm-up im Install); `apps/web/src/app/config.ts:283-286` (`cache: 'no-store'` nur für `config.json`)
- `docs/theming.md:14-17` („Edit them in place and reload“), `docs/configuration.md:238-241` („Serve it with `Cache-Control: no-cache`; the nginx block … does this“ — nur `config.json`)

**Problem:** `theme.css` und Branding-Assets laden ohne Cache-Direktive, und der Service Worker
(`NetworkFirst`) ruft `fetch()` durch den HTTP-Cache des Browsers. Ohne `Cache-Control` greift
heuristisches Caching aus `Last-Modified` (RFC 9111 §4.2.2) — ein bearbeitetes `theme.css` oder
ausgetauschtes Logo kann bei wiederkehrenden Nutzern tage- bis wochenlang alt bleiben, während
`theming.md` „reload“ verspricht. Kein Duplikat von W-35 (Query-String im SW-Cache).

**Auswirkung:** Rebranding ohne Rebuild kommt bei Bestandsnutzern verspätet an; der Betreiber sucht den
Fehler im Service Worker.

**Lösungsansatz:** Die nginx-`map` um `~^/theme\.css$`, `~^/manifest\.json$` und `~^/branding/` mit
`no-cache` erweitern; das Caddy-Rezept um einen `header`-Block für dieselben Pfade (und `immutable` für
`/assets/*`) ergänzen; in `configuration.md:239` „`config.json`, `theme.css`, `manifest.json` and
`branding/`“ schreiben.

**Aufwand:** S

**Verifikation:** `theme.ts`, `sw.ts`, `sw-routes.ts`, `config.ts` und die drei Dokumente gelesen;
nicht gegen einen echten Proxy gemessen. Gegenprüfung: bestätigt.

(Quelle: INFRA-12)

### R-112 — [LOW] `engine-strict=true` in `.npmrc` wird von pnpm 11 nicht gelesen — die Einstellung ist wirkungslos

**Status:** [ ] offen

**Kategorie / Bereich:** maintainability / Infra

**Fundstelle(n):**
- `.npmrc:1` (`engine-strict=true`)
- `pnpm-workspace.yaml:8-16`, `:29-33` (dokumentiert dieselbe Falle für `allowBuilds` und `overrides`: „pnpm 11 reads its settings from this file, and silently ignores the package.json block“)
- `package.json:7` (`"packageManager": "pnpm@11.1.1"`), `scripts/ci.mjs:265-266` („`engines` is advisory“ — stimmt nur, weil die Einstellung in der falschen Datei liegt)

**Problem:** In der Gegenprüfung von R-107 gefunden. Die Datei verspricht einen Install-Stopp bei
falscher Node-Version, den pnpm 11 aus dieser Quelle nicht liefert (`pnpm config get engine-strict` im
Repo: `undefined`). Das Repo hat den Umzug pnpm-eigener Einstellungen nach `pnpm-workspace.yaml` für
zwei andere Schlüssel bereits nachvollzogen; `engine-strict` wurde übersehen.

**Auswirkung:** Heute keine, weil `engines >=22` ohnehin fast alles durchlässt. Wer R-107 umsetzt und
auf `.npmrc` vertraut, bekommt statt des erwarteten Stopps weiterhin nur eine Warnzeile.

**Lösungsansatz:** `engineStrict: true` nach `pnpm-workspace.yaml` (zu `allowBuilds`/`overrides`, mit
einem Satz nach deren Muster), `.npmrc` leeren oder löschen; Kommentar in `ci.mjs:265` anpassen.
Zusammen mit R-107 umsetzen — dann stoppt `pnpm install` auf Node 22/26 in einer Sekunde mit einer
Meldung, die den erwarteten Major nennt.

**Aufwand:** S

**Verifikation:** Scratch-Sonde mit pnpm 11.1.1: `.npmrc` `engine-strict=true` → `[WARN] Unsupported
engine …`, exit 0; `engineStrict: true` in `pnpm-workspace.yaml` → `ERR_PNPM_UNSUPPORTED_ENGINE`, exit
1; `--config.engine-strict=true` ebenso; Kontrolle mit passendem Range → exit 0.

(Quelle: INFRA-13)

## Abarbeitungsreihenfolge

### Sofort

1. **R-03** — Datenleck zwischen Personen am selben Tab (auch im Public-Computer-Modus); ein `resetComposer()` in `endSession` plus Flush, das Muster steht zwei Zeilen daneben.
2. **R-02** — der Plain-Text-Modus versendet den falschen Body und verliert den getippten Text; Variante (a) ist ein Nachmittag, (b) die saubere Lösung.
3. **R-01** und **R-51** — Infinite Scroll ist im Alltag mit mehreren Ordnern tot; derselbe Guard, ein Stempel statt einer Zahl plus ein `.catch`.
4. **R-04** — jede Bearbeitung eines Termins fremder Zone verschiebt ihn um Stunden; `existing.timeZone` durchreichen ist ein `useState`.
5. **R-05**, **R-72** und **R-73** — derselbe W-18-Block in `maintenance.ts`: die Regression (dauerhafter Spinner) zuerst, die Schreibreihenfolge und der Vollscan im selben Durchgang.
6. **R-06** — Occurrence-Overrides frieren gegen spätere Serienänderungen ein; unsichtbar am Tag der Bearbeitung, deshalb nicht liegen lassen.
7. **R-25** und **R-29** — Geisterentwürfe im Drafts-Ordner aus einer Ursache (eingefrorene Server-Id) plus der race-freie Discard-Fall; zusammen schließen sie den Discard-Pfad, `rewriteQueued` existiert bereits.
8. **R-36** — 100 KB feindlicher Text frieren den Tab 8 s ein; zwei lineare Trim-Schleifen.
9. **R-26** — der Retry für die gesamte Kontakt-Intent-Familie ist tot; eine geteilte Tabellenliste.
10. **R-45** — Betreiber, die §2 wörtlich umsetzen, liefern einen toten „Sign in“-Button aus; sechs Pfade in zwei Rezepten.

### Nächste Iteration

11. **R-07** und **R-08** (Stufe 1) — Kontextmenü-Gates wie der Junk-Arm; ehrliche Kopf-Checkbox und Zähler „50 von 300“.
12. **R-09**, **R-57**, **R-92**, **R-95**, **R-91** — Serverdaten, die ungeprüft in Render- und Transportpfade laufen; dieselbe Klasse wie W-25/W-26/W-28, die Reste in einem Durchgang.
13. **R-10**, **R-11**, **R-55**, **R-87** — stille Fehler ohne `catch` bzw. ohne unterscheidbaren Fehlerwert; Reste von W-10/W-11, jeweils ein `catch` mit Toast.
14. **R-14** und **R-40** — der IME-Guard aus `keys.ts:55` an drei weiteren Stellen; je eine Zeile, betrifft 4 der 14 Locales.
15. **R-12** und **R-15** — beide in `flushDraft`/`isEmptyDraft`: Signatur-Entwürfe und geleerte Entwürfe hinterlassen Server-Leichen; ein gemeinsamer Patch.
16. **R-16**, **R-17**, **R-62** — DST-Arithmetik im Kalender, drei kleine Stellen, einmal im Jahr sichtbar.
17. **R-18** und **R-19** — verlorener Teilnehmer und verlorenes `sortAs`; je ein Einzeiler mit stiller Datenwirkung.
18. **R-22**, **R-23**, **R-24** — drei Defekte in `FilesPage.tsx` (Cache-Key, fehlender `live`-Guard, Offline-Gating); zusammen mit dem Move-Dialog auf `useFileNodes`.
19. **R-28**, **R-69**, **R-70**, **R-76** — die Reste der Outbox-Rennen W-13/W-14/W-15 mit den zugehörigen Fehlerpfad-Tests; die Scratch-Tests der Gegenprüfung liegen bereit.
20. **R-31**, **R-81**, **R-32**, **R-84** — vier Befunde im OAuth-Pfad von `SessionProvider.tsx` (Route-Stash mit Query, Stash bei Erstanmeldung, Fehlerpfad des Callbacks, `ephemeralRef`-Reset); eine Sitzung.
21. **R-33** — Escape im Re-Auth-Dialog meldet ab; ein No-op-`onClose` plus `hideClose`.
22. **R-30** — Refresh-Token-Rennen zwischen Tabs; nur bei rotierenden IdPs, aber genau denen, die ADR-006 empfiehlt.
23. **R-34**, **R-35**, **R-88**, **R-89**, **R-90** — vCard-Import/-Export: stumme Verluste zuerst (R-34, R-35), dann Zeitstempel, QP-Meldung und Parameter.
24. **R-37** — Fragment-Links öffnen eine zweite App-Instanz; kleiner Fix, Browser-Prüfung nötig.
25. **R-38**, **R-39**, **R-43** — Shortcut-Registry und `ui/`: toter Chord, Escape-Stack, Kontextmenü-Fokus; je S.
26. **R-41** und **R-42** — Push: `notUpdated` auswerten (Privatsphäre-Schalter), Doppel-Banner im verdeckten Tab.
27. **R-13** — `mailto:` mit Plus-Adressen; ein `replace` weniger, eines mehr.
28. **R-20** und **R-21** — Kontakte-Performance: Collator und Sortierschlüssel sofort (S), Foto-Auslagerung und geteilte Query danach (M–L).
29. **R-44** und **R-104** — verlorene E2E-Abdeckung (App-Passwort-Pfad) und ein nie laufender Skip-Test; beides aus der Historie bzw. dem Fixture wiederherstellbar.
30. **R-27** — Re-Send nicht-idempotenter Creates; L, weil JMAP kein Idempotenz-Mittel bietet — Kommentarkorrektur (S) sofort, der Rest als Design-Aufgabe.

### Backlog

31. **R-46**, **R-47**, **R-48**, **R-49**, **R-50** — Mail-Kleinigkeiten: Inline-Bild-Doppellauf, Shift+↓-Anker, Snooze-RMW und -Waker, zwei i18n-Interpunktionen.
32. **R-52**, **R-53**, **R-54**, **R-56**, **R-58** — Compose-Kleinigkeiten: Drafts fremder Konten, `oversized`-Summe, 400-Klassifikation, Vorschlagsliste, `<pre>`/`<td>` im Plain-Text.
33. **R-59**, **R-60**, **R-63**, **R-64**, **R-65**, **R-66**, **R-67** — PIM-Kleinigkeiten, je S.
34. **R-61** — Dateiliste ohne `memo`; erst nach einer Messung virtualisieren.
35. **R-71**, **R-74**, **R-75** — Sync-Härtungen: Kontakt-Guards wie bei Mail, Full-Pull löscht nicht, `startFleet`-Rejection.
36. **R-77**, **R-79**, **R-80**, **R-83**, **R-85** — Auth-/Session-Randfälle, je ein kleiner Patch; R-77 und R-79 sind Reste von W-05.
37. **R-82** — Sieve-Namen mit U+2028 oder Marker-Text; zwei `replace` und ein Regex.
38. **R-86** und **R-78** — Formular-Dirty-Guard in den Settings (M) und der Offline-Kaltstart (M, Produktentscheidung, mindestens als Backlog-Eintrag festhalten).
39. **R-93**, **R-94**, **R-96** — Lib: zwei Tests, die ihren Namen nicht einlösen, `send(options)` für das Engine-Signal, `media-src`-Entscheidung.
40. **R-98**, **R-99**, **R-100** — UI: ADR-021-Regel in der Toast-Primitive, Emoji-Initialen, Listener-Leak.
41. **R-107** und **R-112** — `engines`-Range und `engineStrict` gehören zusammen, sonst bleibt es bei der Warnzeile.
42. **R-103**, **R-105**, **R-106**, **R-108**, **R-109**, **R-111** — Release- und CI-Hygiene: Versionswächter, `unzip`/mtime, doppeltes DOMPurify, `concurrency`, Fake-Timer-Cleanup, Cache-Header für Theme und Branding.
43. **R-68**, **R-97**, **R-101**, **R-110**, **R-102** — Kommentare und Doku, die auf falsche Fährten führen; R-102 zuerst, weil `SECURITY.md` eine falsche Zusage enthält.
44. **R-08** (Stufe 2) — FR-LST-04 tatsächlich erfüllen („Alle {{total}} auswählen“); M, braucht `collectMatchingIds`.

## Nicht bestätigt

Kandidaten, die in Erstprüfung oder Gegenprüfung verworfen oder auf einen Teil reduziert wurden. Je ein
Satz mit Grund, damit das nächste Review nicht dieselbe Spur noch einmal läuft.

### Mail
- **MAIL-03, Flacker-Form** (Body → Skeleton → Body): unter realistischer Reihenfolge nicht reproduziert; belegt ist nur der abgebrochene und neu gestartete Pipeline-Lauf (deshalb R-46 low, nicht verworfen).
- **Server-Delta während Select-all → falsche Aktionsziele**: geprüft (neue Id, entfernte Id) — nein, `pruneSelection` und `allSelected` verhalten sich korrekt (siehe R-08).
- **`receivedAt: null`**: kein Crash, stiller 1970-Fallback (Teil von R-09, kein eigener Befund).
- **`messageRights` bis zu 3× pro sichtbarer Zeile mit `Map` über alle Mailboxen**: kein Beleg für spürbare Kosten.
- **`bodyTruncated` (W-33) wertet auch die nicht gerenderte text/plain-Alternative aus**: Banner ohne gekürzten HTML-Body setzt > 2 MB Plain-Text bei < 2 MB HTML voraus; praktisch irrelevant.
- **`aria-activedescendant` nach Maus-Scroll auf eine nicht gemountete Zeile** (Virtualisierung): nicht mit assistiver Technik geprüft.
- **Doppelte `wake`-Dispatches durch R-49**: nicht reproduziert, Folge wäre idempotent.
- **`SearchBox`: Debounce-Navigation vs. `useEffect(() => setInput(search.q))`**: laufen im selben Task, kein Tastendruck geht verloren.
- **`Conversation` rendert beim Nachrichtenwechsel einen Frame mit dem alten `expanded`-Set**: kosmetisch, nicht belegt.
- **Kontextmenü: `contextItems` leer, wenn die Zeile aus dem virtuellen Fenster scrollt**: nicht getestet.
- **`useMessageBody` berechnet `htmlParts`/`textBody` pro Render ohne `useMemo`**: `sanitized` hängt am String `joinedHtml`, kein erneutes Sanitizen.

### Compose / Outbox / Sharing
- **`format=flowed` / Zeilenlänge im `text/plain`**: nach RFC 8621 §4.6 wählt der Server die Transfer-Encoding für `bodyValues`.
- **`undoSend` hinterlässt `status: 'sending'`**: `engine.cancelSend` setzt die `drafts`-Zeile auf `pending` (`engine.ts:538-543`).
- **Upload-Abbruch beim Minimieren**: der Unmount-Cleanup prüft `drafts.has(draftId)` und bricht nur bei Close/Discard ab; korrekt.
- **Reply-All mit gesetztem Reply-To nimmt `From` nicht in Cc**: RFC-5322-konforme Designentscheidung.
- **In-Reply-To/References**: `threadingHeaders` entspricht RFC 5322 §3.6.4; Forward startet neuen Thread.
- **W-13 `seq`-Vergleich in `deleteIfUnchanged`, W-32 `notFound`-Ausnahme, W-37 Import, W-28 für `maxSizeUpload`/`maxConcurrentUpload`**: korrekt umgesetzt (die Restlücken sind R-25 und R-57).
- **Sharing-Rechtematrix**: Mailbox 10 Schlüssel (RFC 8621 §2 + `mayShare` aus RFC 9670), Calendar 8, AddressBook 4 (RFC 9610 §2) stimmen mit den Typen in `@waxwing/jmap` überein; `myRights.mayShare === true` als Gate.
- **i18n**: alle Schlüssel vorhanden; keine hartkodierten sichtbaren Strings in JSX.
- **`QueuedSends`-Statustext veraltet zwischen zwei Outbox-Writes**: kosmetisch.
- **`use-send-error-notifier` toastet nach jedem Reload erneut** für eine unbehandelte `error`-Zeile: gewollt (Dedup nur pro Sitzung).
- **`parseAddressList` mit Komma im Anzeigenamen**: `inQuotes` wird beachtet.
- **`RichTextEditor`: externe `value`-Änderung während des 200-ms-Debounce** kann Tastendrücke verwerfen: nur bei gleichzeitigem Klick + Tippen.
- **`describeConflict`: `forbidden` ist `RETRYABLE`**: Retry sinnlos, aber harmlos.
- **`togglePlainText`-Seiteneffekte im `setMode`-Updater unter StrictMode**: doppelter Aufruf ist idempotent; als Wartbarkeitshinweis in R-02 aufgenommen.
- **`mailto:` mit `%2B`**: korrekt dekodiert in Pfad und Query — nur das rohe `+` ist betroffen (R-13).
- **Nacktes HTTP 400 beim Upload**: wird `JmapHttpError` → `server` mit Retry; nicht von R-54 betroffen.

### PIM
- **PIM-22 (verworfen als Duplikat)**: „Maintenance-Schritt 1c kann Occurrences einer laufenden Materialisierung löschen, bevor deren Fensterzeile geschrieben ist“ — wortgleich SYNC-08 (R-72), dort mit demselben Lösungsansatz; der PIM-Aspekt (`refresh()` nach `createEvent`) ist in R-72 enthalten.
- **Ob Stalwart v0.16.18 `recurrenceRule` in einem Override ablehnt oder ignoriert**: nicht gemessen; jscalendarbis-18 §3.3.4 verlangt Ignorieren, R-06 gilt unabhängig davon wegen `start`/`alerts`.
- **`invitesGoOut()` setzt `sendSchedulingMessages: true` bei jeder Teilnehmerlisten-Änderung**: ob der Server alle oder nur die geänderten Teilnehmer anschreibt, ist ohne Fixture nicht messbar.
- **Ob IndexedDB (structured clone) eine eigene Property `__proto__` erhält**: für R-60 unerheblich (Import- und Server-Pfad laufen über `JSON.parse`).
- **Kontaktfenster: `reconcileWatchedContacts` (`engine.ts:1807`) überspringt fehlende Zeilen ebenfalls**: da jeder Sweep `lastUsedAt` stempelt (`delta.ts:666`), tritt der R-05-Ablauf dort nur nach ≥ 2 Tagen ohne erfolgreichen Sweep ein; nicht reproduziert, der R-05-Fix (1) und (3) deckt ihn mit ab.
- **`loadCalendars` läuft nicht bei `online`-Wechsel**: nach Wiederverbindung fängt der „Try again“-Balken das ab.
- **`FilesPage.load()` ruft bei jedem Ordner-, Sortier- und Suchwechsel `engine.refreshFileTree()`**: vermutlich beabsichtigt und billig.
- **`ContactList`: `aria-activedescendant` auf eine gerade nicht gerenderte virtuelle Zeile**: `moveTo` scrollt sie nach; nicht als Problem belegbar.
- **`IcsImportDialog.read()` ohne Unmount-Guard**: unter React 19 folgenlos.
- **`ContactImportExportDialog`: Kommentar „one round trip per card“**: falsch (es ist eine Outbox-Enqueue), das Verhalten korrekt; der Rerun-Preis je Enqueue steht in R-21.

### Sync
- **SYNC-01 als „Regression durch W-13“**: nein — vor dem Fix erzeugte dieselbe Überlappung eine veraltete Server-Kopie mit falschem `synced` (W-13 selbst); der Fix ist unvollständig, keine Regression (R-25 entsprechend formuliert).
- **SYNC-05 „doppelte Kontaktkarte“ auf Stalwart**: nein — Stalwart prüft die `uid` beim Create (`assert_is_unique_uid`), der Re-Send wird mit `invalidProperties` abgelehnt; Folge ist ein falscher Dead Letter, kein Duplikat (in R-27 korrigiert). Duplikate bleiben bei Drafts und Adressbüchern.
- **SYNC-05 „W-16-Timeout erzeugt die Situation regelmäßig“**: nein — ein `/set`, das serverseitig länger als 30 s braucht, ist kein Regelfall.
- **Port bricht Anfragen bei `stop()` nicht ab** (W-16-Empfehlung „Signal durchreichen“ nicht umgesetzt): für dispatchte Zeilen bewusst (W-15-Kommentar: eine dispatchte Zeile muss bis zum Reconcile durchlaufen); der Sign-out ist über `SIGN_OUT_STOP_BUDGET_MS` begrenzt. Für R-28 ist das die Voraussetzung, dass ein zweiphasiger Stop hilft; die API-Lücke für die Delta-Legs bleibt R-94.
- **Drain-Obergrenze bricht einen legitimen Resync ab**: nein — `maxChanges` wird nicht gesetzt, 500 Seiten sind unerreichbar; Recovery ist der Vollabgleich.
- **Stall-Guard (`hasMoreChanges && newState === state`) trifft einen konformen Server**: nein — RFC 8620 §5.2 verlangt bei `hasMoreChanges` einen weiterbewegten Zwischenstand.
- **Await auf Nicht-Dexie-Promises innerhalb einer Transaktion**: in `enqueueAction`, `retryFailed`, `discardFailed`-Claim, `deleteIfUnchanged`, `applyOptimistic`, `applyUndo` geprüft — `refetchEmails` holt VOR der Transaktion; keine Verletzung.
- **Transaktionsscope von `enqueueAction`**: für alle 19 Intent-Arten gegen `applyOptimistic` abgeglichen — vollständig (nur `retryFailed` ist auseinandergelaufen, R-26).
- **Dexie-Migrationen v1–v8**: append-only, indizierte Felder mit `.upgrade()`; kein Befund.
- **Eviction trifft Outbox-Zeilen oder ungesendete Entwürfe**: nein — Wartungstransaktionen nennen `outbox`/`drafts` nicht; `planEviction` schließt protected Ids aus.
- **Snapshot-Stabilität von `useAccountEngine`/`useSharedMailboxes`/`useEngineStatus`/`useQuota`**: referenzstabil; kein Re-Render-Loop.
- **Quota-Modul**: `pickPrimaryQuota`, `quotaLevel`, TTL-Store, Notifier — keine Auffälligkeit.
- **`collectBodyBlobIds`-Bound (W-34)**: geteiltes `visited` ist als Gesamtbudget beabsichtigt.
- **W-15-Chain bei schnellem `connected`-Wechsel**: `cancelled`-Flag verhindert den Start, Kette bleibt konsistent.

### App
- **Wrapping-Key-Race zwischen zwei Tabs (`SecretStore.wrappingKey`)**: der Key wird nur bei `put` erzeugt; `get` ohne Datensatz berührt ihn nicht — beim Boot zweier Tabs nicht erreichbar.
- **`sweepEphemeral` löscht die gerade angelegte ephemere DB**: `knownEphemeralNames` liest den Index vor `markEphemeral`, Read-Modify-Write behält später hinzugekommene Namen.
- **`endSession`: ein werfender Schritt überspringt `logout()`**: alle Schritte davor sind `never throws` oder haben `.catch`.
- **Sign-out-Budget (5 s) vs. laufende Engine-Writes**: dokumentierter Trade-off, blockierte Deletes werden als `incomplete` gemeldet.
- **`?mailto=` geht durch den `/` → `/mail`-Redirect verloren**: `useMailtoHandler` strippt den Parameter selbst vor dem Redirect; nur der OAuth-Erstanmeldungsfall (R-81) verliert ihn.
- **`HAS_EXTENSION` im Navigation-Denylist trifft App-Routen**: JMAP-IDs sind `[A-Za-z0-9_-]`, `[^?]*` stoppt vor der Suche.
- **Vacation `datetime-local` ↔ UTC**: kein Defekt gefunden.
- **`wipeWebStorage` beim ephemeren Plain-Sign-out löscht Präferenzen anderer Nutzer**: bewusst name-blind, dokumentiert.
- **`renderBootFailure`/`index.html`-Fallback unübersetzt**: begründet (i18n-Chunk kann fehlen).
- **`AccountMenu` zeigt ephemeren Nutzern „Switch to <früherer durable Nutzer>“**: Folge von W-17/ADR-037, nicht neu.
- **APP-01 auf Stalwart**: Stalwart-Refresh-Tokens sind stateless und bleiben nach Ausgabe eines neuen bis zum eigenen Ablauf gültig — das Rennen endet dort mit zwei gültigen Tokens, kein `invalid_grant` (R-30 herabgestuft).
- **APP-16 als unhandled rejection**: `engine.runMaintenance` fängt den Lauf selbst ab (`engine.ts:1053`); der Befund bleibt nur als Verwechslung von Fehler und Leerergebnis (R-87).
- **Ephemere OAuth-Anmeldung lässt ein fremdes durables Refresh-Token im Store**: erreichbar nur, wenn ein durables Restore an `connectSession` scheiterte; das Token gehört dann dem Gerätebesitzer und soll die Gast-Session überleben — Design.
- **U+0085 (NEL) in Regelnamen**: kein JS-LineTerminator, Round-Trip intakt.

### Lib
- **`renderPlainText` läuft bei jedem Render von `MessageView`** (`MessageView.tsx:515-517`, nicht in `useMemo`): gemessen 10–14 ms für einen gutartigen 1-MB-Body, < 1 ms für übliche Größen — kein Befund; mit R-36 gegenstandslos, falls dort ein `useMemo` mit erledigt wird.
- **SSE ohne Idle-Watchdog** (`push/sse.ts`): ein still gestorbener Socket lässt `reader.read()` hängen und den Status auf `open`; die App fängt das über den 60-s-Safety-Sweep auf, nur die Statusanzeige wäre falsch. Ohne Netz nicht reproduziert.
- **`onSessionStateChange` feuert bei jedem Call nach einer Änderung** (`client.ts:137-139`): die App verdrahtet den Hook nicht.
- **Fehlende physische Antwort für einen Chunk wird still zu einem Teilergebnis gemergt** (`chunking.ts:211-238`): erfordert einen Server, der RFC 8620 §3.4 verletzt; kein realistischer Pfad.
- **Transportfehler nach teilweise angewandtem Multi-Request-Batch** (`client.ts:113-134`): im App-Code kein Batch, der eine nicht-idempotente `/set` mit einer splitbaren Call kombiniert.
- **W-16-Deadline vs. große `Email/get`-Bodies**: 30 s pro physischem Request; die App begrenzt Bodies (W-33) und chunked nach `maxObjectsInGet`; `TimeoutError` wird als Retry bzw. `sendInterrupted` behandelt — konsistent.
- **`url(/**/https://…)`, `\75rl(`, Newline in unquoted `url()`**: `@csstools/css-tokenizer` bestätigt — im unquoted `url()` ist `/*` kein Kommentar (relative URL gegen `about:srcdoc`, lädt nichts); `\75rl(` tokenisiert zu `url-token` und wird vom W-04-Fix blockiert; Newline ergibt `bad-url-token` und wird zusätzlich blockiert. Kein Bypass.
- **`rel="opener"` und `download` überleben DOMPurify auf `<a>`**: abgefangene Links werden nie navigiert, freigegebene bekommen `rel` überschrieben; `download` cross-origin wird ignoriert.
- **`content-length` nicht numerisch → `onProgress({ total: NaN })`** (`blob.ts:186`): kosmetisch, kein Aufrufer nutzt `total` für Logik.
- **`UID`/`MEMBER` werden text-escaped, obwohl URI-typisiert** (`to-vcard.ts:361, 382`): für `urn:uuid:`-Werte ohne `,;\` folgenlos.
- **Ob Stalwart ein nicht-RFC-3339-`updated` (R-88) oder einen Nicht-URI-`media.uri` (R-35) ablehnt**: ohne Server nicht geprüft; beide Befunde stützen sich auf die RFCs und den App-Pfad, der die Werte unverändert sendet.
- **Outlook-2.1-Exportform (R-89)**: nicht gegen eine echte Exportdatei geprüft; die Reproduktion folgt der 2.1-Spezifikation.

### UI
- **UI-08 (verworfen): `pushsubscriptionchange` wird im Service Worker nicht behandelt**: Fundstelle stimmt, aber der Worker hält per ADR-017 kein Token und kann den Server nicht über den neuen Endpoint informieren; ein Handler könnte nur das Browser-Abonnement erneuern, was `browserSubscription()` beim nächsten Start ohnehin tut. Die beschriebene Auswirkung bliebe mit dem Fix identisch; ADR-017 nennt den Zustand als „expected steady state“. Übrig bleibt der veraltete Kommentar (R-101).
- **Dialog-Scroll-Lock bei Geschwister-Dialogen** (`Dialog.tsx:99-106`): nur fehlerhaft, wenn ein äußerer Dialog schließt, während ein Geschwister offen bleibt; kein solcher Ablauf gefunden.
- **`en`-Fallback-Bundle für Nicht-`en`-Sprachen nie geladen** (`i18n/index.ts:161`): das Locale-Gate erzwingt Schlüsselparität; dynamische `t()`-Aufrufe arbeiten auf geschlossenen Mengen oder tragen `defaultValue`. Latent.
- **Kontrast `accent`/`danger`/`archive` auf `surface-selected-idle`** (Dark 4,11/3,86/4,11) fehlt im Test: kein Stylesheet zeichnet diese Tokens als Text auf dieser Fläche.
- **Demo-Modus**: DEV-gated, per DCE entfernt; Demo-Strings nur en/de — dev-only.
- **RTL**: keine RTL-Locale ausgeliefert (ADR-036); der Kommentar `Menu.tsx:205-207` („V1 ships (en, de)“) ist veraltet, die Aussage bleibt richtig.
- **VAPID-Rotation bei verlorenem Registrierungsdatensatz** (`push-subscribe.ts:151`): nur bei unabhängig verlorener IndexedDB erreichbar. Härtungsidee: `PushSubscription.options.applicationServerKey` vergleichen.
- **`Menu`/`useDismiss` re-subscriben bei Inline-`contextTarget`-Gettern jeden Render**: nur solange offen, kein Fehlverhalten (Escape-Reihenfolge: R-39).
- **`Tooltip` ohne Aufrufer außerhalb der Gallery**: tree-shaken, `size-limit` wacht.
- **Touch-Ziele / feste Pixelhöhen / `outline: none`**: dokumentiert bzw. vom Fokus-Guard abgedeckt.
- **UI-03 in Chromium**: `key: 'Process'` während der Komposition macht die `event.key`-Vergleiche dort zufällig harmlos — kein eigener Befund, aber der Grund, warum das Problem in Chromium-basierten Tests nie auffällt (in R-40 vermerkt).

### Infra
- **INFRA-10, Teil „Platzhalter-Test“** (`calendar-series.test.ts:186-196`, `expect(true).toBe(true)`): der Kommentar begründet ausdrücklich, warum es eine Aussage und keine Assertion ist („a fact about the server, not about this code“); bewusst so entschieden.
- **INFRA-09, Teil „zwei Tag-Pushes konkurrieren um dieselbe Release-Seite“**: `action-gh-release` legt pro `github.ref_name` ein eigenes Release an; nur die `latest`-Zuordnung bleibt als theoretischer Rest (in R-108).
- **INFRA-06, Aussage „tar ist byte-stabil“**: widerlegt — beide Formate tragen die mtime; das Ergebnis des ersten Scratch-Skripts war ein Artefakt seiner Schleifenreihenfolge (in R-105 korrigiert).
- **INFRA-08, Aussage „`engine-strict` würde bei `pnpm install` stoppen“**: unter pnpm 11.1.1 aus `.npmrc` nicht — daraus wurde R-112; der Kern von R-107 (Range zu weit) bleibt.
- **`dist-release/`, `playwright-report/`, `test-results/` im Baum**: alle in `.gitignore`, nicht versioniert.
- **Interpolations-Drift in den 13 Übersetzungen**: `locale-rules.mjs` erlaubt das Weglassen von Platzhaltern bewusst (außer `product`); Scan aller Bundles: 0 weggelassene Nicht-`count`-Platzhalter.
- **Unbenutzte Locale-Keys**: das Gate prüft sie nicht; ein Check bräuchte Extraktion aller `t()`-Aufrufe inkl. dynamischer Keys — nicht bewertet.
- **`pnpm-workspace.yaml`-Overrides**: `pnpm why` zeigt für alle sechs genau eine aufgelöste Version innerhalb der Elternranges; wirksam und harmlos.
- **`waitForTimeout`-Sleeps** (23 Stellen): Negativ-Assertions, Gesten-Frames oder Debounce-Warten; `write.spec.ts:246` (4 s gegen 3 s Autosave) knapp, aber ohne belegte Retries — kein Flake.
- **`public-computer.spec.ts:113`** ohne `toPass`-Polling: schlimmstenfalls fail-closed-Rot, kein grüner Fehltest.
- **`security.spec.ts` (W-39/W-40-Umfeld)**: die drei B25-Tests prüfen das Behauptete (Positivkontrolle für den Paste-Pfad, `securitypolicyviolation`-Event, Script-Injektion als Sandbox-Nachweis).
- **`unit`-Projekt ohne `restoreMocks`**: einziger `vi.spyOn` ohne Restore ist `auth/controller.test.ts:638` auf einem pro Test frischen Store-Objekt — kein Leck.
- **`check:nul` extension-basiert**: unbekannte Dateinamen werden gelesen statt übersprungen (fail-safe).
- **`e2e/tsconfig.json` `include: ["**/*.ts"]`**: `node_modules` per TS-Default ausgeschlossen; `audit/` und `shots/` werden mit typgeprüft.
- **SECURITY.md „621 packages“**: Lockfile hat 622 `resolution:`-Einträge — im Rahmen.

## Anhang: Zuordnung der Bereichs-IDs

| Bereichs-ID | R-ID | Bereichs-ID | R-ID | Bereichs-ID | R-ID |
| --- | --- | --- | --- | --- | --- |
| MAIL-01 | R-01 | PIM-01 | R-04 | APP-01 | R-30 |
| MAIL-02 | R-07 | PIM-02 | R-05 | APP-02 | R-03 (mit COMP-02) |
| MAIL-03 | R-46 | PIM-03 | R-06 | APP-03 | R-31 |
| MAIL-04 | R-08 | PIM-04 | R-16 | APP-04 | R-32 |
| MAIL-05 | R-09 | PIM-05 | R-17 | APP-05 | R-77 |
| MAIL-06 | R-10 | PIM-06 | R-59 | APP-06 | R-33 |
| MAIL-07 | R-11 | PIM-07 | R-18 | APP-07 | R-78 |
| MAIL-08 | R-47 | PIM-08 | R-19 | APP-08 | R-79 |
| MAIL-09 | R-48 | PIM-09 | R-60 | APP-09 | R-80 |
| MAIL-10 | R-49 | PIM-10 | R-20 | APP-10 | R-81 |
| MAIL-11 | R-50 | PIM-11 | R-21 (mit COMP-12) | APP-11 | R-82 |
| MAIL-12 | R-51 | PIM-12 | R-22 | APP-12 | R-83 |
| COMP-01 | R-02 | PIM-13 | R-23 | APP-13 | R-84 |
| COMP-02 | R-03 (mit APP-02) | PIM-14 | R-61 | APP-14 | R-85 |
| COMP-03 | R-25 (mit SYNC-01) | PIM-15 | R-24 | APP-15 | R-86 |
| COMP-04 | R-12 | PIM-16 | R-62 | APP-16 | R-87 |
| COMP-05 | R-13 | PIM-17 | R-63 | LIB-01 | R-34 |
| COMP-06 | R-14 | PIM-18 | R-64 | LIB-02 | R-88 |
| COMP-07 | R-15 | PIM-19 | R-65 | LIB-03 | R-35 |
| COMP-08 | R-52 | PIM-20 | R-66 | LIB-04 | R-89 |
| COMP-09 | R-53 | PIM-21 | R-67 | LIB-05 | R-90 |
| COMP-10 | R-54 | PIM-22 | verworfen (Duplikat von SYNC-08 → R-72) | LIB-06 | R-36 |
| COMP-11 | R-55 | PIM-23 | R-68 | LIB-07 | R-37 |
| COMP-12 | R-21 (mit PIM-11) | SYNC-01 | R-25 (mit COMP-03) | LIB-08 | R-91 |
| COMP-13 | R-56 | SYNC-02 | R-69 | LIB-09 | R-92 |
| COMP-14 | R-57 | SYNC-03 | R-26 | LIB-10 | R-93 |
| COMP-15 | R-58 | SYNC-04 | R-70 | LIB-11 | R-94 |
| UI-01 | R-38 | SYNC-05 | R-27 | LIB-12 | R-95 |
| UI-02 | R-39 | SYNC-06 | R-28 | LIB-13 | R-96 |
| UI-03 | R-40 | SYNC-07 | R-71 | LIB-14 | R-97 |
| UI-04 | R-41 | SYNC-08 | R-72 | INFRA-01 | R-44 |
| UI-05 | R-42 | SYNC-09 | R-73 | INFRA-02 | R-45 |
| UI-06 | R-43 | SYNC-10 | R-74 | INFRA-03 | R-102 |
| UI-07 | R-98 | SYNC-11 | R-75 | INFRA-04 | R-103 |
| UI-08 | verworfen (unbegründet; Rest → R-101) | SYNC-12 | R-76 | INFRA-05 | R-104 |
| UI-09 | R-99 | SYNC-13 | R-29 | INFRA-06 | R-105 |
| UI-10 | R-100 | | | INFRA-07 | R-106 |
| UI-11 | R-101 | | | INFRA-08 | R-107 |
| | | | | INFRA-09 | R-108 |
| | | | | INFRA-10 | R-109 |
| | | | | INFRA-11 | R-110 |
| | | | | INFRA-12 | R-111 |
| | | | | INFRA-13 | R-112 |
