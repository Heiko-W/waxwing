# Security- und Code-Review Waxwing — 29.08.2026

**Commit:** `1eb3789`
**Geprüfte Bereiche:** HTML-/CSS-Sanitizing und Zitat-Pfad (`packages/mail-html`, `apps/web/src/compose`),
Authentifizierung und Credential-Speicher (`apps/web/src/auth`, `SessionProvider`), Transport- und
Protokollschicht (`packages/jmap`, `packages/jscontact`), Sync-Engine und Outbox
(`apps/web/src/sync`), lokale Persistenz und Datenlebenszyklus, Service Worker / PWA / Deployment-Doku,
Code- und Supply-Chain-Qualität (Skripte, CI-Checks).

**Methodik:** 7 parallele Prüfdimensionen (sanitizing, auth, transport, sync, persistenz, sw-pwa,
qualitaet), anschließend adversariale Gegenprüfung jedes einzelnen Befunds — jeder Eintrag unten wurde
im Code nachvollzogen und, wo möglich, empirisch reproduziert (jsdom, `@csstools/css-tokenizer`,
Playwright/Chromium, Node gegen die gebauten Pakete). Befunde, deren Schadensbild sich in der
Gegenprüfung nicht halten ließ, wurden in Severity und Formulierung korrigiert; die Korrekturen sind in
den Einträgen eingearbeitet.

| Severity | Anzahl |
| --- | --- |
| critical | 0 |
| high | 2 |
| medium | 16 |
| low | 22 |
| **Summe** | **40** |

> **Stand 29.08.2026, abends: alle 40 Befunde sind abgearbeitet** — Branch
> `fix/code-review-2026-08`, ein Commit je Befundgruppe, jeder Fix mit Regressionstest und
> Mutationsprobe (Fix entfernt ⇒ Test rot). Zwei Abweichungen von den Empfehlungen sind unten am
> jeweiligen Befund vermerkt: W-17 wird nur zur Hälfte behoben (der Credential-Pfad; die
> Store-Isolation braucht Kontoarbeit, siehe ADR-037), und W-18 prunt Kalender-Occurrences, aber
> keine Kontaktkarten (die sind das Objekt, nicht sein Cache).
>
> Nebenbefund aus der Abarbeitung, nicht aus dem Review: der `FakeServer` der Chaos-Suite wendete
> `Email/set`-Patches teilweise an, bevor er sie ablehnte (RFC 8620 §5.3 verlangt Atomizität je
> Objekt) — er verdeckte damit, welcher von Rollback und Delta-Pass zuletzt schrieb.

Ausgangsbasis waren 49 bestätigte Einzelbefunde; 9 davon sind Mehrfachfunde derselben Ursache aus
verschiedenen Dimensionen und hier zu jeweils einem Eintrag zusammengefasst (alle Fundstellen sind
genannt).

## Zusammenfassung

Der schwerste Befund ist eine Divergenz zwischen dem eigenen CSS-Deklarations-Splitter und dem
Browser-Tokenizer: CSS-Kommentare sind im Splitter kein Zustand, dadurch reitet beliebiges CSS im Wert
einer erlaubten Deklaration mit — bis hin zu einem bildschirmfüllenden `position:fixed`-Overlay im
App-DOM des Composers. Daneben stehen zwei Themenblöcke, die sich durch mehrere Dimensionen ziehen:
der Public-Computer-Modus hält seine Zusage nicht vollständig (Re-Auth verliert den Modus und
persistiert wieder Refresh-Token und AuthRecord; die Kontoregistry mit E-Mail-Adresse und Serverursprung
überlebt jeden Sign-out), und die Multi-Account-UI wurde ohne die in ADR-004 beschriebene
Store-Isolation ausgeliefert. In Sync und Transport überwiegen Robustheitslücken gegenüber einem
fehlerhaften oder feindlichen Server (unbegrenzte Drain-Schleife, Downloads ohne Größengrenze, fehlende
Timeouts) sowie schmale Race-Fenster in der Outbox.
Gut gelöst ist die Sanitizer-Architektur selbst: fail-closed als Grundhaltung, ein Manifest für alles
Verworfene, eine mehrschichtige CSP (Meta-Policy plus eigene Frame-CSP, die den Tracking-Request in
allen hier gefundenen Bypässen tatsächlich stoppt), Web-Locks-Leader-Wahl und transaktionale
Claim-Muster in der Outbox, gepinnte Actions mit eigenem Tiefenprüfer sowie ungewöhnlich ehrliche
Code-Kommentare und ADRs, die bekannte Grenzen benennen statt zu beschönigen.

## Befunde

### W-01 — [HIGH] `splitDeclarations` kennt keine CSS-Kommentare — Allowlist-Bypass in beiden Sanitizer-Kopien

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** xss / Sanitizing
- `apps/web/src/compose/quoted-html.ts:240`
- `packages/mail-html/src/sanitize.ts:669`

**Problem:** Beide Kopien von `splitDeclarations` führen für Strings und Klammern einen Zustand, aber
nicht für CSS-Kommentare. Ein `"` innerhalb von `/* … */` öffnet für den Splitter einen String, der bis
zum Attributende offen bleibt; ein `(` im Kommentar erhöht denselben depth-Zähler dauerhaft. Danach gilt
kein `;` mehr als Deklarationsgrenze, das ganze `style`-Attribut wird zu EINER Deklaration. Der Browser
entfernt Kommentare dagegen bereits im Tokenizer und sieht ganz normale Grenzen. `filterQuotedStyle`
bzw. `filterAnchorStyle` prüfen nur den Property-Namen vor dem ERSTEN `:`, finden `color` auf der
Allowlist und behalten das gesamte Stück wörtlich. Genau diese Divergenzklasse ist im Modulkopf für
den Newline-Fall dokumentiert und geschlossen — die Kommentar-Variante ist offen, und der Kommentar an
`isInsideAnchor` (Deskendanten-Regel sei "wieder ganz") stimmt damit nicht mehr.

**Auswirkung:** Verifiziert mit jsdom, Spec-Tokenizer und realem Chromium: Der Mail-Body
`<div style='color:red/*"*/;position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;background:#fff'>`
überlebt `sanitize()` und `sanitizeQuotedHtml()` unverändert (CSSOM: `position=fixed`,
`zIndex=2147483647`); `NEGATIVE_VALUE`/`VIEWPORT_UNIT` greifen nicht, weil `100%` keine Viewport-Einheit
ist. Beim Antworten/Weiterleiten landet das über `buildReplyDraft` → `openDraft` →
`RichTextEditor.setHTML` → Squire im APP-Dokument (die Composer-DOMPurify-Instanz behält `style`):
ein bildschirmfüllendes gefälschtes Login-Panel über der App-UI, in einem Entwurf, der bereits an den
Angreifer adressiert ist — die Eingabe wird als Mail-Body zurückgeschickt. Über
`packages/mail-html/src/sanitize.ts` fährt zusätzlich `direction:rtl;unicode-bidi:bidi-override` in
einem `<span>` unter einem `<a>` mit, sodass `classifyLink` einen umgedrehten Linktext als `ok`
einstuft und das Warn-Interstitial ausbleibt.

**Empfohlene Maßnahme:** Kommentare vor dem Split behandeln — entweder `/* … */` in beiden
`splitDeclarations` als eigenen Zustand mit Vorrang vor Strings führen (wie im CSS-Tokenizer), oder
fail-closed und billiger: jede Deklaration verwerfen, deren Rohtext `/*` enthält.

```ts
// fail-closed, in beiden Kopien:
if (raw.includes('/*')) continue // Kommentar im Wert -> Splitter und Browser können divergieren
```

Regressionstests mit `color:red/*"*/;position:fixed` UND `color:red/*(*/;display:none` (Klammer-Variante
über den depth-Zähler) pinnen; die Zusicherung im Kopf von `isInsideAnchor` und in ADR-016
entsprechend korrigieren.

**Aufwand:** M

### W-02 — [HIGH] Re-Auth per OAuth verliert den Public-Computer-Modus und persistiert Refresh-Token und AuthRecord

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** auth
- `apps/web/src/app/session/SessionProvider.tsx:580` (`resolveReauthOAuth`)
- `apps/web/src/app/session/SessionProvider.tsx:397-400` (Stash wird zu früh gelöscht)
- `apps/web/src/auth/controller.ts:159-173`, `:215`, `:233-238`

**Problem:** `resolveReauthOAuth` startet den OAuth-Redirect mit `startLogin({ method: 'oauth' })` ohne
`publicComputer` und schreibt `STASH_PUBLIC_KEY` nicht erneut. Der Flag wird beim ERSTEN Callback in
`boot()` gelesen und sofort gelöscht, `ephemeralRef` überlebt den Full-Page-Redirect ohnehin nicht.
Die neue PkceTransaction hat damit kein `ephemeral: true`, `TokenStore.setEphemeral()` entfällt,
`completeRedirect` schreibt wieder einen `AuthRecord`, und `markEphemeral()` wird nicht gerufen.

**Auswirkung:** Anmeldung am Bibliotheks-/Hotel-Terminal mit gesetztem Haken "Öffentlicher oder
geteilter Computer". Nach permanentem Refresh-Fehlschlag (abgelaufenes oder entzogenes Refresh-Token,
Passwortwechsel) erscheint der Reauth-Dialog; ein Klick auf "Erneut anmelden" genügt. Danach liegt ein
bis zu 30 Tage gültiges, laut ADR-006 serverseitig nicht widerrufbares Refresh-Token verschlüsselt in
`waxwing-auth`, ein `AuthRecord` daneben, und die Replica läuft ab diesem Zeitpunkt wieder unter dem
dauerhaften Namen `waxwing-replica` — von keinem Sweep mehr erfasst. Der nächste Kaltstart am Gerät
meldet den nächsten Benutzer als diesen Nutzer an; das ist genau das, was FR-AUTH-09 ausschließt. (Die
zuvor angelegte ephemere Replica bleibt unclaimed und wird beim nächsten Start gelöscht — der Schaden
liegt vollständig auf der Auth-Seite.)

**Empfohlene Maßnahme:** Ephemeral-Zustand über den Redirect tragen:

```ts
if (ephemeralRef.current) writeStored(session(), STASH_PUBLIC_KEY, true)
await controller.startLogin({ method: 'oauth', publicComputer: ephemeralRef.current === true })
```

und in `boot()` `STASH_PUBLIC_KEY` erst nach erfolgreichem `completeRedirect` entfernen bzw. für die
Dauer der Session gesetzt lassen.

**Aufwand:** S

### W-03 — [MEDIUM] Plain-Text-Nachrichten umgehen das Link-Interstitial vollständig

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Sanitizing
- `packages/mail-html/src/text.ts:94` (`target="_blank"` fest gesetzt)
- `packages/mail-html/src/frame.ts:473` (Keep-Zweig von `prepareLinks` entfernt kein vorhandenes `target`)
- `packages/mail-html/src/frame.ts:434` (Click-Handler steigt bei `target="_blank"` aus)

**Problem:** `renderPlainText` schreibt `target="_blank"` auf jeden linkifizierten Anker. `prepareLinks`
entfernt ein bestehendes `target` nicht, wenn der Gate den Link BEHALTEN will (`gated !== false` →
nur `continue`), und `onClick` tritt für jeden Anker mit `target="_blank"` beiseite. Für text/plain-Bodies
ist der Pfad `onLink` → `classifyLink` → `LinkWarningDialog` damit unerreichbar, egal was `gateLink`
entscheidet. Der Early-Return ist mit "wird von prepareLinks nur für freigegebene Links geschrieben"
begründet — das gilt für HTML-Mail (DOMPurify strippt `target`), nicht für den eigenen Plain-Text-Renderer.
Die in ADR-029 festgeschriebene Invariante ("kept → no target is written, and the click is intercepted")
ist verletzt.

**Auswirkung:** End-to-end verifiziert: Für einen Body mit `https://evil.tld/<U+202E>nigol/tset.knab`
klassifiziert `gateLink` einen `mismatch` und will den Link behalten; der Anker behält trotzdem
`target="_blank"`, `defaultPrevented === false`, `onLink` wird nie gerufen, der Browser navigiert direkt.
Weil im Plain-Text-Renderer Linktext == href ist, ist ein `mismatch` praktisch nur über U+202D/U+202E
erreichbar und der Host bleibt sichtbar — der reale Verlust ist also nicht ein überzeugender Host-Spoof,
sondern die bewusst fail-closed gemeinte Warnung ("wir wissen nicht, was gelesen wurde"), die laut
`use-link-opener.ts` nicht abschaltbar sein soll.

**Empfohlene Maßnahme:** Im Keep-Zweig von `prepareLinks` `target` (und `rel`) aktiv entfernen statt nur
`continue`, alternativ `renderPlainText` kein `target` mehr setzen lassen und die Freigabe allein
`prepareLinks` überlassen. Test ergänzen, der `renderPlainText`-Ausgabe in `mountMailFrame` montiert und
für einen `mismatch` `defaultPrevented === true` erwartet.

**Aufwand:** S

### W-04 — [MEDIUM] CSS-escaptes `url(` umgeht die Remote-Content-Firewall und die UI meldet "kein Remote-Inhalt"

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** privacy / Sanitizing
- `packages/mail-html/src/sanitize.ts:249` (Rewriting sucht literal `url(`)
- `packages/mail-html/src/sanitize.ts:253` (Residual-Check unescapet zuerst, strippt danach)

**Problem:** Das Rewriting sucht `url(` im ROHTEXT, der Residual-Check unescapet ZUERST und strippt
DANN `url(...)`. Ein escapter Funktionsname (`u\72 l(`, `\75 rl(`, `UR\4C(`) wird von beiden Stufen
verfehlt: das Rewriting sieht kein `url(`, und der Residual-Check macht durch das Unescapen erst ein
wohlgeformtes `url(...)` daraus, das er anschließend selbst wegstrippt. Per CSS Syntax §4.3.4 wird die
Ident-Sequenz beim Vergleich escape-aufgelöst; Chromium rechnet für alle drei Schreibweisen
`backgroundImage = url("…")`.

**Auswirkung:** `<div style="background:u\72 l(https://tracker.example/p.gif)">` kommt aus `sanitize()`
wörtlich heraus, mit `blockedRemote: []` und `hasRemoteContent: false` — der Leserin wird also aktiv
gesagt, die Mail enthalte nichts Remotes, sie kann das Blockieren weder sehen noch aufheben. Im
Lese-Frame verhindert die innere CSP (`img-src blob: data:`) den Request tatsächlich; ein echter
Netzabfluss entsteht über den Zitat-Pfad in den Composer (dort erlaubt die App-CSP `img-src … https:`,
`sanitizeQuotedHtml` trägt die Deklaration unverändert weiter, und die URL wandert zusätzlich in die
gesendete Mail) oder wenn Remote-Inhalte ohnehin freigegeben sind.

**Empfohlene Maßnahme:** Den Residual-Check auf dem ROHTEXT strippen und erst danach unescapen — oder
robuster: `sanitizeStyle` auf `cssUnescape(css)` arbeiten lassen bzw. jeden Style verwerfen, dessen
unescapete Form ein `url(` enthält, das im Rohtext nicht steht. Testvektoren `u\72 l(`, `\75 rl(`,
`UR\4C(` in `sanitize-css.test.ts` aufnehmen (dort wird bisher nur das escapte SCHEMA `\68 ttps:` geprüft).

**Aufwand:** S

### W-05 — [MEDIUM] Kontoregistry und Präferenzen in localStorage überleben Sign-out und Public-Computer-Modus

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** privacy / Persistenz — zusammengefasst aus 5 Einzelbefunden (Dimensionen auth, sw-pwa, persistenz, qualitaet)
- `apps/web/src/auth/wipe.ts:46` (`wipeLocalData` fasst kein Web-Storage an)
- `apps/web/src/auth/controller.ts:358` (`logout({wipeData:true})` ruft genau dieses `wipeLocalData`)
- `apps/web/src/app/session/SessionProvider.tsx:754-770` (`registerAccount` läuft unbedingt, auch ephemer)
- `apps/web/src/app/session/SessionProvider.tsx:700-705` (`endSession` löscht nur zwei andere Schlüssel)
- `apps/web/src/auth/registry-store.ts:16` / `:70` (`waxwing.accounts`, `clearRegistry` ohne Aufrufer)
- `apps/web/src/auth/use-account-registry.ts:41` (`unregisterAccount` ohne Aufrufer)
- `apps/web/src/auth/forget-account.ts:37` (`forgetAccount` ohne Aufrufer, nicht in `auth/index.ts` exportiert)
- `apps/web/src/auth/AccountMenu.tsx:43-57` (rendert die Fremdkonten)
- `apps/web/src/app/services.tsx:60-67` (macht es im U2-Pfad richtig: `localStorage.clear()`)

**Problem:** `wipeLocalData` räumt Cache Storage, IndexedDB und Service-Worker-Registrierungen ab, aber
weder localStorage noch sessionStorage. Der Registry-Effekt schreibt nach JEDEM erfolgreichen Connect
`{scope, issuer, username, label, addedAt}` nach `localStorage['waxwing.accounts']`, ohne `ephemeralRef`
zu prüfen. Kein Produktivpfad entfernt den Eintrag jemals: `clearRegistry`, `unregisterAccount` und
`forgetAccount` sind implementiert, getestet — und haben ausschließlich Test-Aufrufer. Zusätzlich ist
`MAX_ACCOUNTS = 5` mit stillem No-op bei vollem Register kombiniert, ohne Entfernen-Pfad.

**Auswirkung:** Nach "Abmelden & Daten entfernen" oder nach einer Public-Computer-Session bleiben
E-Mail-Adresse und Serverursprung der Vorgängerin dauerhaft im Browserprofil — sofort per DevTools
lesbar und, sobald sich die nächste Person anmeldet, als "Wechseln zu alice@example.com" im
Kontowechsler sichtbar. Das widerspricht dem Anmeldetext "Keeps no mail and no sign-in on this device"
und dem erklärten Zweck von SECURITY.md §3.1 (Verlassen soll nicht vom richtigen Menüpunkt abhängen).
Ebenfalls überleben die Präferenzschlüssel (`waxwing.theme`, `waxwing.accent`, `waxwing.readingPane`,
`waxwing.folderRail`, `waxwing.cacheDays`, `waxwing.ephemeralDbs`, `i18nextLng`, SplitPane-Fraktionen),
obwohl der Bestätigungsdialog ausdrücklich "mail and settings" verspricht. Credentials und Mailinhalte
sind NICHT betroffen — es handelt sich um Metadaten-Preisgabe; SECURITY.md §3 selbst nennt korrekt nur
IndexedDB, Cache Storage und Service-Worker.

**Empfohlene Maßnahme:** Drei kleine Änderungen: (1) Registry-Effekt bei `ephemeralRef.current === true`
überspringen; (2) in `endSession` bei `wipeData || ephemeralRef.current` `clearRegistry()` bzw.
`unregisterAccount(scope)` aufrufen; (3) `wipeLocalData` um die Waxwing-eigenen Schlüssel (oder
`localStorage.clear()` + `sessionStorage.clear()` wie in `resetLocalData`) erweitern. Alternativ die
Dialogzusage auf "mail" reduzieren. `forgetAccount` entweder an das Kontomenü anschließen oder löschen —
nicht ungenutzt stehen lassen. `controller.test.ts:355` um eine Assertion auf `waxwing.accounts`
erweitern; SECURITY.md §3.1 die Registry benennen, falls sie bewusst bleiben soll.

**Aufwand:** S

### W-06 — [MEDIUM] Methodenwechsel lässt das Geheimnis der jeweils anderen Anmeldeart im Store liegen

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** auth
- `apps/web/src/auth/controller.ts:192-195` (`startBasicLogin` löscht `RefreshToken` nicht)
- `apps/web/src/auth/controller.ts:228-238` (`completeRedirect` löscht `BasicCredentials` nicht)

**Problem:** `startBasicLogin` räumt nur `BasicCredentials` und `AuthRecord` weg, `SecretName.RefreshToken`
bleibt liegen; umgekehrt löscht `completeRedirect` nie `BasicCredentials`. Weil alle Instanzen denselben
Store `waxwing-auth` benutzen (siehe W-17), entsteht die Vermischung auf Store-Ebene, nicht nur innerhalb
einer Controller-Instanz.

**Auswirkung:** Erreichbarer Pfad ohne XSS: erfolgreicher OAuth-Callback (Refresh-Token + AuthRecord
persistiert), anschließendes `connectSession` scheitert (`NoAccountError`, HTTP 403 auf
`/.well-known/jmap`, `JmapSessionOriginError`), `boot()` zeigt das Login-Formular, der
`controllerRef` bleibt gesetzt. Die Nutzerin meldet sich mit Passwort an und lässt "Angemeldet bleiben"
bewusst leer — es liegt trotzdem weiterhin ein bis zu 30 Tage gültiges, serverseitig nicht
widerrufbares Refresh-Token verschlüsselt in IndexedDB. Der umgekehrte Fall ist der unangenehmere:
nach einem Basic-Login mit "Angemeldet bleiben" und späterem Wechsel auf OAuth bleibt das PASSWORT als
`basic.credentials` liegen — für `restore()` inert, am Gerät aber weiterhin entschlüsselbar und
serverseitig gültig.

**Empfohlene Maßnahme:** In `startBasicLogin` zusätzlich `await this.tokens.clear()` (bzw.
`store.delete(SecretName.RefreshToken)`), in `completeRedirect` nach erfolgreichem `tokens.apply`
`store.delete(SecretName.BasicCredentials)`. Invariante: der Store hält immer nur das Geheimnis der
aktiven Methode.

**Aufwand:** S

### W-07 — [MEDIUM] vCard-Import: dateikontrollierte Strings treffen ungeschützt die Prototypkette

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit — zusammengefasst aus 2 Einzelbefunden
- `packages/jscontact/src/from-vcard.ts:186-207` (`idAllocator` gibt die PROP-ID ungeprüft als Objektschlüssel zurück)
- `packages/jscontact/src/from-vcard.ts:326`, `:348`, `:372`, `:394`, `:411`, `:435` (Schreiben auf Objektliterale)
- `packages/jscontact/src/from-vcard.ts:139-141`, `:345-346` (`CONTEXTS[type]` / `PHONE_FEATURES[type]` nur gegen `undefined` geprüft)
- `apps/web/src/contacts/contact-io.ts:104-108` / `:144` (`REJECT_ON_IMPORT` existiert nur für den JSON-Pfad)

**Problem:** (a) Eine frei gewählte `PROP-ID` wird ungeprüft als Objektschlüssel benutzt.
`out['__proto__'] = {...}` legt keine eigene Property an, sondern ersetzt den Prototyp des
Ergebnisobjekts; danach ist `Object.keys(out).length === 0` und die Funktion liefert `undefined`.
(b) `CONTEXTS` und `PHONE_FEATURES` sind gewöhnliche Objektliterale, und die lowercase-Prüfung ist nur
`!== undefined` — `CONTEXTS['constructor']` liefert die `Object`-Funktion, `CONTEXTS['__proto__']`
`Object.prototype`; beide werden als Schlüssel stringifiziert.

**Auswirkung:** (a) Empirisch bestätigt: `EMAIL;PROP-ID=__proto__:victim@example.com` liefert eine Card
ganz OHNE `emails`-Feld, `skipped` bleibt leer. Eine präparierte `.vcf` (Mailanhang, geteiltes
Adressbuch, Export eines fremden Servers) importiert scheinbar erfolgreich — der Nutzer sieht
"x Kontakte importiert" —, aber alle E-Mail-Adressen bzw. Telefonnummern der Karte fehlen still. Das
bricht die Zusage im Dateikopf ("nothing here is dropped in silence"). Der Prototyp-Effekt ist auf das
jeweilige Gruppenobjekt begrenzt, nicht global. (b) `TEL;TYPE=constructor,__proto__,home` erzeugt
Boolean-Set-Schlüssel wie `function Object() { [native code] }`, die per `ContactCard/set` als
RFC-9553-invalide Daten an den Server geschrieben und in der Kontaktansicht als unsinnige Labels
angezeigt werden.

**Empfohlene Maßnahme:** In `idAllocator` gefährliche PROP-IDs (`__proto__`, `constructor`, `prototype`)
verwerfen und auf den generierten Fallback ausweichen; Zielobjekte mit `Object.create(null)` anlegen
oder per `Object.defineProperty` schreiben. Für die Tabellen `Object.hasOwn(CONTEXTS, type)` prüfen bzw.
sie als `Map<string,string>` führen.

**Aufwand:** S

### W-08 — [MEDIUM] Rohe NUL-Bytes in versionierten Quelldateien machen Diffs und Suche unbrauchbar

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** supply-chain / Prozess
- `apps/web/src/mail/AttachmentList.tsx:75` (`const SAVE_ALL_BUSY = '<NUL>save-all'`)
- `apps/web/src/files/FileMoveDialog.tsx:83` / `:87` (`.join('<NUL>')` / `.split('<NUL>')`)
- `apps/web/src/mail/safe-filename.test.ts:43`
- `packages/jmap/src/push/sse-parser.test.ts:102`
- `apps/web/src/contacts/contact-io.test.ts:145`

**Problem:** Fünf versionierte Textdateien — davon zwei produktive TSX-Dateien — enthalten ein literales
0x00-Byte statt der Escape-Sequenz. Git klassifiziert solche Dateien als binär: `git log --numstat`
liefert `-  -`, `git grep` antwortet `Binary file … matches` ohne Trefferzeilen, `file(1)` meldet `data`.
Auch `* text=auto eol=lf` aus `.gitattributes` greift für sie nicht.

**Auswirkung:** Jede Änderung an `AttachmentList.tsx` (rendert absenderkontrollierte Dateinamen, erzeugt
`blob:`-URLs, baut das Attachment-ZIP) und an `FileMoveDialog.tsx` erscheint im PR-Review, in
`git diff`, `git log -p` und in der GitHub-Diff-Ansicht ausschließlich als "Binary files differ" —
ein eingeschleuster oder versehentlicher Code-Wechsel dort ist im Review nicht sichtbar. Zweitens sind
die Dateien für `git grep`, plain `grep` und die GitHub-Codesuche unsichtbar; in dieser Prüfung selbst
lieferten dadurch zwei Greps falsche Ergebnisse. Kein Laufzeitfehler, keine ausnutzbare Schwachstelle —
ein Loch in der Review-Kette, kein Produktdefekt.

**Empfohlene Maßnahme:** Rohbytes durch Escape-Sequenzen ersetzen (`'\0save-all'`, `.join('\0')`,
`.split('\0')`, in den Tests analog). Danach einen CI-Check in `scripts/ci.mjs` aufnehmen, der
versionierte Nicht-Binärdateien auf 0x00 prüft — mit Ausnahmen für Binärendungen sowie
`docs/site/shots/` und `apps/web/public/branding/`, die legitim NUL enthalten.

**Aufwand:** S

### W-09 — [MEDIUM] `Foo/changes`-Drain ist eine vom Server steuerbare Endlosschleife

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** dos / Sync
- `apps/web/src/sync/engine/delta.ts:110-142` (`drainChanges`)
- Nutzer: `delta.ts:203`, `:256`, `:288`, `:503`, `:526`, `:692`, `:752`, `:915`
- Gegenbeispiel im selben Repo: `delta.ts:963` (`walkFileTree` mit `FILE_MAX_PAGES` und Fortschrittsprüfung), `files-client.ts:259`

**Problem:** `drainChanges` läuft ohne Seitenlimit, ohne Fortschrittsprüfung (`page.newState === state`)
und ohne AbortSignal; einzige Abbruchbedingung ist das serverseitige `hasMoreChanges`. Die
Akkumulator-Sets wachsen dabei unbegrenzt. Die `SyncEngine` prüft ihren `stopController` nur zwischen
Schritten, nicht innerhalb der Schleife — `stop()` unterbricht sie also nicht.

**Auswirkung:** Ein feindlicher oder schlicht fehlerhafter JMAP-Server antwortet auf `Mailbox/changes`,
`Email/changes`, `AddressBook/changes` usw. dauerhaft mit `{hasMoreChanges: true, newState: <unverändert>}`.
Der Client sendet unendlich oft dieselbe Anfrage: der Sync-Zyklus kehrt nie zurück, kein Fehler erreicht
die UI, Netz und Akku werden dauerbelastet. Liefert der Server je Seite neue Ids, wächst zusätzlich der
Speicher bis zum Tab-Tod. Selbst-DoS, keine Rechteverletzung.

**Empfohlene Maßnahme:** Analog zu `walkFileTree` absichern: harte Obergrenze (`MAX_CHANGES_PAGES`) plus
Abbruch bei `page.newState === state`, beides als "unvollständiges Delta" behandeln und einen
Full-Resync anstoßen. Zusätzlich `stopController.signal` bis in `drainChanges` durchreichen.

**Aufwand:** S

### W-10 — [MEDIUM] Fire-and-forget-Dispatches ohne `catch` — Sendeverlust ohne jede Spur

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Sync — zusammengefasst aus 2 Einzelbefunden
- `apps/web/src/compose/use-draft-sync.ts:298` (Sendepfad, `void engine.dispatch(...)`, danach `return { ok: true }`)
- `apps/web/src/compose/use-draft-sync.ts:150`, `:224` (Autosave, Discard)
- `apps/web/src/mail/use-message-actions.ts:57`, `apps/web/src/mail/use-folder-actions.ts:41`
- `apps/web/src/compose/use-draft-autosave.ts:35`, `:54`
- `apps/web/src/compose/ComposerWindow.tsx:216-232` (schließt das Fenster bei `ok`)
- `apps/web/src/compose/use-draft-restore.ts:28` (überspringt `sending`)

**Problem:** Kein einziger Aufrufer von `SyncEngine.dispatch` bzw. `draftSync.flush` hängt einen `catch`
an; einen globalen `unhandledrejection`-Handler gibt es nicht. `dispatch` awaitet `stateGuard`,
`enqueueAction` und `refreshQueueCounts` — reines IndexedDB-I/O, das werfen kann. Im Sendepfad ist das
besonders scharf: `send()` schreibt die drafts-Zeile durabel auf `status: 'sending'`, startet den
Dispatch fire-and-forget und meldet sofort Erfolg.

**Auswirkung:** Wirft `enqueueAction` (realistisch: `QuotaExceededError` beim `put` mit dem vollen
Mail-Body), ist die Nachricht nirgends mehr: keine Outbox-Zeile, kein `QueuedSends`-Chip, kein Dead
Letter, keine Problemmeldung — und `use-draft-restore` überspringt `sending`-Zeilen, so dass auch ein
Reload das Fenster nicht wieder öffnet. Die Nutzerin hat "Sending…" gesehen, das Fenster ist zu, die
Mail wurde nie versendet und ist nicht wiederherstellbar. Genau der Fall, den der Kommentar darüber für
`engine === null` bereits ausschließt. Auf den übrigen Pfaden bleibt in Kombination mit W-31 eine
bereits angewandte optimistische Änderung ohne jede Spur stehen. (Der Teardown-Fall trägt nicht: dort
liefert `getEngineFor` bereits `null`.)

**Empfohlene Maßnahme:** Im Sendepfad `await engine.dispatch(...)` in `try/catch`, bei Fehler die
drafts-Zeile auf `pending`/`error` zurücksetzen und `{ ok: false, reason }` liefern, damit
`ComposerWindow` das Fenster offen lässt. Für die übrigen Aufrufstellen eine gemeinsame Hilfsfunktion
`dispatchOrToast(engine, intent, opts)` mit `danger`-Toast einführen.

**Aufwand:** M

### W-11 — [MEDIUM] Blob-Download liest den Server-Stream ohne jede Größengrenze in den Speicher

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** dos / Transport
- `packages/jmap/src/blob.ts:145-172` (`readBody`, beide Zweige)
- Aufrufer: `apps/web/src/mail/use-blob.ts:37`, `use-message-source.ts:119`, `files-client.ts:407`, `sieve-client.ts:138`
- Gegenbeispiel: `packages/jmap/src/push/sse-parser.ts:55/111/184` (`MAX_SSE_BUFFER_CHARS`)

**Problem:** `readBody` puffert den gesamten Response-Body im RAM — im Streaming- wie im
`arrayBuffer()`-Zweig. Es gibt keinen Maximalwert, keinen Abgleich gegen den aus `EmailBodyPart.size`
bekannten Sollwert und keinen gegen `content-length` (das nur für die Fortschrittsanzeige gelesen wird).
Weil kein App-Aufrufer beim Download ein `onProgress` übergibt, greift in der Praxis der
`arrayBuffer()`-Zweig. `MAX_CACHED_BLOB_BYTES` (10 MB) greift erst NACH dem vollständigen Download und
schützt nur die IndexedDB, nicht den Heap.

**Auswirkung:** Ein kompromittierter oder feindlicher Server beantwortet einen beliebigen
Anhangs-/Inline-Bild-/EML-Download mit einem unendlichen Byte-Strom — ein Klick genügt für den OOM-Kill
des Tabs. Auch ohne Angreifer: eine sehr große legitime Datei aus dem Files-Bereich wird vollständig in
den Heap geladen.

**Empfohlene Maßnahme:** `downloadBlob` eine `maxBytes`-Option geben (Default z. B. 100 MB; Aufrufer
können den bekannten `size`-Wert plus Toleranz übergeben), im Leseloop nach jedem Chunk prüfen und bei
Überschreitung `reader.cancel()` + `JmapError`; im Nicht-Streaming-Zweig `content-length` vorab prüfen
und ebenfalls streamen statt `arrayBuffer()` zu nutzen.

**Aufwand:** M

### W-12 — [MEDIUM] `QuotaExceededError` im Delta-Schreibpfad blockiert die Synchronisierung ohne Eviction und ohne Meldung

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Persistenz
- `apps/web/src/sync/engine/engine.ts:1495-1508` (Early-Return VOR `runMaintenance()`)
- `apps/web/src/sync/engine/delta.ts:292` (`putEmails` ohne `withQuotaRecovery`)
- verdrahtet ist die Recovery nur in `engine.ts:966-973` und `blob-cache.ts:90-100`

**Problem:** `withQuotaRecovery` und `reportStorageFull` hängen nur am `fetchBody`- und am
Blob-Cache-Pfad. Der Envelope-/Kontakt-/Kalender-/Datei-Schreibpfad hat nichts davon. Ein
`QuotaExceededError` dort wird zu `deltaError`, und der Early-Return überspringt genau den
Wartungslauf, der Platz schaffen würde. Einen eigenen Wartungstimer gibt es nicht —
`MAINTENANCE_INTERVAL_MS` ist nur eine Throttle-Schwelle innerhalb des Aufrufs am Ende eines
ERFOLGREICHEN Passes.

**Auswirkung:** Ist das Origin-Quota voll (fremde Origin-Daten, kleines Browser-Quota, die
unbegrenzt wachsenden Tabellen aus W-18), scheitert jeder Delta-Pass am Envelope-Write und geht mit
Backoff in `phase: 'error'`, ohne je in die Eviction zu laufen. Die Nutzerin sieht "Sync problem —
retrying" statt "Storage is full" und bekommt keinen Hinweis auf den einzigen Ausweg ("Free up space").
Ohne Nutzeraktion (Nachricht öffnen, Anhang laden, Einstellungen) erholt sich der Zustand nicht.

**Empfohlene Maßnahme:** `putEmails` und die entsprechenden Contact-/Calendar-/FileNode-Writes in
`withQuotaRecovery(..., () => this.runMaintenance({ force: true, needBytes }), ...)` kapseln und im
`deltaError`-Zweig bei `isQuotaExceeded(deltaError)` `reportStorageFull()` melden sowie einen
erzwungenen Wartungspass anstoßen, bevor zurückgekehrt wird.

**Aufwand:** M

### W-13 — [MEDIUM] Autosave-/Discard-Intent wird still verworfen, wenn er eine `inflight`-Outbox-Zeile überschreibt

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** race / Sync
- `apps/web/src/sync/engine/outbox.ts:2766` (`db.outbox.delete` ohne Re-Read)
- `apps/web/src/sync/repo.ts:680-682` (einziger Schreiber: unbedingtes `put`)
- `apps/web/src/compose/use-draft-sync.ts:103`, `:158`, `:227` (stabile Zeilen-Id `draft:<localId>`)

**Problem:** `enqueueAction` schreibt die Outbox-Zeile mit einem unbedingten `put`, ohne den Status zu
prüfen. `replayOutbox` claimt die Zeile zwar transaktional auf `inflight`, löscht sie am Ende aber
unbedingt über die alte Zeilen-Kopie — ohne zu prüfen, ob sie inzwischen ersetzt wurde. Drafts benutzen
als einzige eine stabile Zeilen-Id, damit ein späterer Save den früheren coalesced; genau diese Annahme
bricht, sobald die frühere Zeile bereits `inflight` ist. Der Claim schützt nur gegen `cancelSend`, nicht
gegen ein Re-Enqueue.

**Auswirkung:** Die Nutzerin tippt weiter, während der vorherige Autosave unterwegs ist (bei mobiler
Latenz oder zwei `visibilitychange`-Flushes normal). Der zweite Flush überschreibt die `inflight`-Zeile;
die laufende Anfrage kommt erfolgreich zurück, `reconcileDraftSave` setzt die drafts-Zeile auf `synced`
und das anschließende `delete` entfernt die soeben eingereihte neue Zeile. Der lokale Stand bleibt
erhalten (die drafts-Zeile wurde vorher durabel geschrieben), aber die SERVER-Kopie behält den alten
Stand — auf einem anderen Gerät oder im Webmail sichtbar — und die UI behauptet `synced`. Schärfer ist
der Discard-Fall: ein `discardDraft`, das eine `inflight`-Save-Zeile überschreibt, wird gelöscht, während
der laufende Save gerade eine neue Server-Kopie anlegt — der verworfene Entwurf taucht im Drafts-Ordner
wieder auf. Fenster ist ein Netzwerk-Roundtrip.

**Empfohlene Maßnahme:** Optimistic Concurrency auf der Zeile: eine monoton wachsende `seq` in
`OutboxRow` mitführen, in `enqueueAction` inkrementieren und den Abschluss transaktional machen
(`db.transaction('rw', db.outbox, …)` mit Re-Read, `if (current?.seq !== row.seq) return`). Minimal:
in `enqueueAction` eine `inflight`-Zeile nicht überschreiben, sondern eine Folgezeile mit neuer Id
einreihen.

**Aufwand:** M

### W-14 — [MEDIUM] `discardFailed` wendet ein geschuldetes Undo ohne transaktionalen Claim an

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** race / Sync
- `apps/web/src/sync/engine/engine.ts:606-623` (`discardFailed`: read, act, delete)
- `apps/web/src/sync/engine/outbox.ts:2508-2527` (`drainOwedUndos` setzt `undo: null` erst NACH `applyUndo`)
- `apps/web/src/sync/engine/outbox.ts:2621-2647` (`deadLetter` schreibt `undo` und rollt danach zurück)
- Gegenbeispiel: `engine.ts:516-527` (`cancelSend`), `engine.ts:552-585` (`retryFailed`)

**Problem:** `cancelSend` und `retryFailed` claimen ihre Zeile ausdrücklich in einer `rw`-Transaktion und
begründen das im Kommentar; `discardFailed` liest, wendet das Undo an und löscht danach. `drainOwedUndos`
läuft im Leader zu Beginn JEDES Replay-Passes über exakt dieselben `error`-Zeilen mit `undo != null`,
und der `refetchEmails`-Zweig von `applyUndo` macht dazwischen sogar einen Netzwerk-Roundtrip — das
Fenster ist breit. `applyUndo` ist nicht idempotent: die Deltas werden rein aus dem persistierten Undo
rekonstruiert und `adjustMailboxCounts` rechnet relativ.

**Auswirkung:** Klick auf "Verwerfen" im Problems-Dialog (auch aus einem Follower-Tab), während der
Leader `drainOwedUndos` fährt: beide wenden denselben Rollback an, die `totalEmails`/`unreadEmails`-Badges
des Ordners werden doppelt zurückgerechnet und driften dauerhaft — `Mailbox/changes` meldet den Ordner
erst wieder, wenn sich dort real etwas ändert. Über Tabs hinweg gibt es dafür keinerlei Serialisierung.
Voraussetzung ist eine Zeile mit geschuldetem Undo, also ein zuvor fehlgeschlagener Rollback.

**Empfohlene Maßnahme:** `discardFailed` denselben Claim geben wie `cancelSend`: in einer `rw`-Transaktion
re-lesen, `undo` auf `null` setzen (oder Status auf einen `discarding`-Zwischenzustand), `applyUndo`
danach außerhalb laufen lassen und bei Fehlschlag das `undo` transaktional zurückschreiben.
`drainOwedUndos` und `deadLetter` analog claimen.

**Aufwand:** M

### W-15 — [MEDIUM] Fleet-Teardown wartet nicht auf `stop()`, und `replayOutbox` ignoriert das Abort-Signal

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** race / Sync
- `apps/web/src/sync/engine/fleet.ts:136-146` (`void engine.stop()`)
- `apps/web/src/sync/engine/outbox.ts:2623-2634` (`ReplayOptions` kennt kein `signal`)
- `apps/web/src/sync/engine/outbox.ts:2545-2571` (`recoverStranded` dead-lettert `inflight`-Zeilen)
- `apps/web/src/sync/engine/leader.ts:48-58` (Lock wird beim `abort` sofort freigegeben)

**Problem:** Das Effect-Cleanup startet `stop()` nur als `void`. `stopController.abort()` gibt den Web
Lock sofort frei, aber `replayOutbox` prüft das Signal an keiner Stelle und läuft mit seinen
`inflight`-Zeilen weiter. Der unmittelbar danach gestartete neue Fleet gewinnt den Lock und fährt
`recoverStranded` über genau diese Zeilen.

**Auswirkung:** Bei einem `connected`-Wechsel (Re-Auth, Änderung der geteilten Accounts, StrictMode im
Dev-Modus), während ein Send unterwegs ist, dead-lettert der neue Leader ihn als `sendInterrupted` und
`stampSendError` markiert den Entwurf als fehlgeschlagen — obwohl die alte Engine die Submission gleich
erfolgreich abschließt. Die Nutzerin bekommt "Senden fehlgeschlagen, prüfe den Sent-Ordner" für eine
versendete Mail, bzw. je nach Verschränkung eine gelöschte drafts-Zeile plus verwaisten Dead Letter. Der
Schaden ist auf nicht-idempotente `sendEmail`-Zeilen begrenzt; ein `set` wird nur auf `pending`
zurückgesetzt und harmlos wiederholt.

**Empfohlene Maßnahme:** Teardown awaitbar machen (Fleet-Funktion gibt eine `Promise<void>` zurück, die
der Host über eine `teardownRef`-Kette serialisiert, wie `SessionProvider` es bereits tut) und
`replayOutbox` eine `signal`-Option geben, die vor jedem Claim-Schritt geprüft wird.

**Aufwand:** M

### W-16 — [MEDIUM] Kein Timeout auf JMAP-Requests: Sign-out kann minutenlang hängen

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** auth / Transport
- `packages/jmap/src/transport.ts:43-59` (`postApi` setzt `signal` nur, wenn der Aufrufer eines übergibt)
- `apps/web/src/sync/engine/port.ts` (kein Aufruf übergibt ein Signal)
- `apps/web/src/sync/engine/engine.ts:454-460`, `:1929-1933` (`stop()`/`stopAllEngines()` awaiten die Pässe)
- `apps/web/src/app/session/SessionProvider.tsx:645-696` (`endSession` awaitet `stopAllEngines()` zuerst)
- Gegenbeispiel: `apps/web/src/app/config.ts:285` (`AbortSignal.timeout` für `loadConfig`)

**Problem:** Weder `postApi` noch `createJmapPort` setzen einen Timeout. Ein hängender Socket (Captive
Portal, Server nimmt TCP an und antwortet nie) lässt `replayOutbox`/`runSyncPass` offen; `stop()` wartet
auf genau diese Pässe, `stopAllEngines()` auf alle `stop()`, und `endSession` awaitet das als erste
Aktion.

**Auswirkung:** Auf einem geteilten Gerät drückt die Nutzerin "Abmelden", der Login-Screen erscheint
sofort — aber `wipeReplica()`, `closeAllNotifications()`, `tearDownPushSubscription()` und
`controller.logout()` laufen erst, wenn der Socket abbricht (Browser/OS tun das nach Minuten, nicht nie).
In diesem Fenster bleiben die IndexedDB-Mailkopie, die OS-Benachrichtigungen mit Betreffzeilen und die
Credentials auf der Maschine, und der `signOutIncomplete`-Hinweis erscheint nicht. Dieselbe hängende
Anfrage blockiert die Outbox-FIFO in `inflight` und trifft ebenso den Kontowechsel/Fleet-Rebuild.

**Empfohlene Maßnahme:** Default-Timeout in `postApi` (`AbortSignal.timeout(30_000)`, mit einem
übergebenen Signal via `AbortSignal.any` kombiniert), `stopController.signal` durch `createJmapPort` bis
in `builder.send()` durchreichen und `stopAllEngines()` im Sign-out-Pfad mit einem harten Deadline-Race
versehen.

**Aufwand:** M

### W-17 — [MEDIUM] Multi-Account ohne Store-Isolation: alle Konten teilen sich eine `waxwing-auth`-Datenbank

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** auth — zusammengefasst aus 2 Einzelbefunden (Dimensionen auth, persistenz)
- `apps/web/src/app/services.tsx:38-39` (einziger Produktions-Konstruktor, ohne `accountId`)
- `apps/web/src/auth/controller.ts:104-107` (→ `new SecretStore({})` → DB `waxwing-auth`)
- `apps/web/src/auth/secret-store.ts:31-33` (`scopedDbName(undefined)`)
- `apps/web/src/app/session/SessionProvider.tsx:288-297` (`ensureController` reicht nur den Issuer durch)
- `apps/web/src/auth/AccountMenu.tsx:43-56` (Switch ruft `signOut()`; Kommentar behauptet das Gegenteil)
- `apps/web/src/auth/controller.ts:352-360` (`logout()` wipe't den gemeinsamen Store immer)

**Problem:** `AuthControllerOptions.accountId` wird an der einzigen produktiven Konstruktionsstelle nie
gesetzt; die Registry berechnet zwar per `deriveScope` einen Scope, aber `registry.activeScope` wird im
gesamten Produktivcode nur als Filter für die Menüeinträge gelesen. Die in ADR-004 beschriebene
Per-Account-Isolation ist im Produktivpfad nicht verdrahtet — ADR-004 dokumentiert das für V1
ausdrücklich, neu und undokumentiert ist, dass die Multi-Account-UI (M5.14) trotzdem ausgeliefert wurde.
Der Kommentar in `AccountMenu.tsx:52-56` ("the other account's credentials live in its own store
(ADR-004), and this account's survive for switching back") ist nachweislich falsch.

**Auswirkung:** (a) Feature-/Doku-Integrität: Jeder Switch und jedes "Add another account" löscht den
gemeinsamen Store, FR-AUTH-07 ("fast switching") erzwingt also bei jedem Wechsel eine vollständige
Neuanmeldung, und der Switcher listet Konten, zu denen nichts zurückzuwechseln ist. Eine echte
Kreuz-Exposition entsteht dabei nicht, weil nie zwei Credentials gleichzeitig existieren. (b) Schmaler
Cross-Tab-Pfad: Tab 1 ist bei Server X angemeldet, in Tab 2 meldet sich derselbe Profilnutzer bei
Server Y an; Tab 1 hat seine Verbindung wegen `db.onversionchange` geschlossen, und beim nächsten
stillen Refresh (nach Ablauf des 1-h-Access-Tokens) liest `TokenStore.getRefreshToken()` aus der neu
geöffneten DB Y's Refresh-Token und POSTet es an den Token-Endpoint von Server X.

**Empfohlene Maßnahme:** `makeAuthController` den aktiven Scope durchreichen
(`(issuer, scope) => new AuthController({ oauth: {...}, accountId: scope })`) und `boot()`/`ensureController`
an `getAccountRegistry().activeScope` koppeln. Solange das nicht getragen wird: den falschen Kommentar
korrigieren und den Umschalter als "abmelden und neu anmelden" kennzeichnen oder die Switch-Einträge
nicht ausliefern.

**Aufwand:** L

### W-18 — [MEDIUM] Kontakte, Kalender, Dateien und Adress-Statistiken werden nie gezählt, geprunet oder evictet

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** datenlebenszyklus / Persistenz
- `apps/web/src/sync/cache-usage.ts:49-68` (`collectCacheUsage` zählt nur Bodies, Blobs, Envelopes)
- `apps/web/src/sync/engine/maintenance.ts:245-252` (`planWindowReap` wird nur mit `queryCacheRows` aufgerufen)
- `apps/web/src/sync/engine/eviction.ts:253-260` (einziger Leser von `lastUsedAt`)
- `apps/web/src/sync/db.ts:900`, `:909` (ungenutzte `[accountId+lastUsedAt]`-Indizes)
- `apps/web/src/sync/engine/delta.ts:597`, `:637`, `:866` (schreiben `lastUsedAt`, das nie gelesen wird)
- `apps/web/src/settings/StorageSection.tsx:155-158` (die Bytes landen unsichtbar in "Other")

**Problem:** Die Tabellen `contactCards`, `contactQueryCache`, `calendars`, `calendarEvents`,
`calendarQueryCache`, `fileNodes` und `addressStats` haben außer `clearAccount`/`wipeReplica` keinen
Löschpfad. `planWindowReap` nimmt strukturell `Pick<QueryCacheRow,'key'|'lastUsedAt'>` entgegen, wäre also
ohne Änderung auch auf die Kontakt-/Kalenderfenster anwendbar — es wird nur nie damit aufgerufen. Für
Kalenderereignisse existiert lediglich eine Teilbereinigung (Occurrences eines serverseitig zerstörten
Masters).

**Auswirkung:** Jeder im Kalender besuchte Monat hinterlässt dauerhaft eine Fensterzeile plus alle
expandierten Occurrences (Titel, Ort, Teilnehmer, Beschreibung); jeder synchronisierte Kontakt bleibt
mit Adressen, Telefonnummern, Notizen und Foto liegen; `addressStats` sammelt jede je gesehene
Korrespondenzadresse. Nichts davon fällt unter das in SECURITY.md §3 als Expositionsgrenze genannte
`offline.cacheDays`-Fenster, nichts erscheint in der Settings-Aufschlüsselung, nichts kann über
"Free up space" freigegeben werden. Auf einem geteilten Gerät wächst der sensibelste Teil der Replica
unbegrenzt und ohne Verfallsdatum; zusätzlich meint das Eviction-Budget eine andere Größe als die
Anzeige.

**Empfohlene Maßnahme:** `planWindowReap` auch mit `contactQueryCache`/`calendarQueryCache` aufrufen (die
`lastUsedAt`-Indizes existieren bereits), nicht mehr referenzierte `calendarEvents`/`contactCards`
mitprunen und die Kategorien in `collectCacheUsage` als eigene Zeilen ausweisen.

**Aufwand:** L

### W-19 — [LOW] SECURITY.md nennt 30 Tage Offline-Fenster, ausgeliefert werden 90

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Dokumentation
- `SECURITY.md:153`
- `apps/web/src/app/config.ts:78` (`cacheDays: 90`, mit Begründungskommentar)
- `apps/web/public/config.json:27`, `docs/configuration.md:191`

**Problem:** SECURITY.md §3 ("Shared device") beziffert die Verteidigung mit "30 days by default … a month
of mail, not a decade". Der ausgelieferte Default ist 90 Tage (bewusste Entscheidung, im Code kommentiert);
`docs/configuration.md` wurde nachgezogen, SECURITY.md nicht. Zusätzlich beschreibt der Satz seit ADR-030
den falschen Mechanismus: `cacheDays` begrenzt nur noch die Eviction, nicht mehr das Anzeigefenster, und
ist über `app/offline-prefs.ts` von der Leserin änderbar.

**Auswirkung:** Ein Betreiber, der auf Basis von SECURITY.md entscheidet, ob Waxwing für Schulungs- oder
Kioskrechner tragbar ist, rechnet mit einem Monat unverschlüsselter Mail in IndexedDB und bekommt drei.
Dieses Dokument ist die einzige Stelle, an der das Fenster für diese Entscheidung quantifiziert wird.

**Empfohlene Maßnahme:** Satz korrigieren, den Mechanismus (Eviction-Horizont, nur Default) richtig
benennen und den konkreten Wert durch einen Verweis auf `docs/configuration.md` ersetzen, damit er nicht
erneut driftet.

**Aufwand:** S

### W-20 — [LOW] Ausgeliefertes `index.html` behauptet, ein CSP-Response-Header überschreibe die `<meta>`-Policy

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** sauberkeit / Dokumentation
- `apps/web/index.html:46` (identisch in `apps/web/dist/index.html`)
- Gegenstück: `SECURITY.md:77-78`, `docs/deployment.md:325-345`, `:391-397`

**Problem:** Der Kommentar im ausgelieferten Artefakt enthält zwei Aussagen, die das Projekt anderswo
ausdrücklich als falsch markiert hat: (a) ein Header überschreibe `<meta>` — nach CSP3 werden alle
Policies unabhängig erzwungen, die effektive Policy ist die Schnittmenge; (b) das Pinnen sei "mandatory
for same-origin (Stalwart)" — auf dem empfohlenen Stalwart-Application-Pfad gibt es überhaupt keinen
Hook für Response-Header.

**Auswirkung:** Ein Betreiber, der dem Kommentar in der Datei folgt, die er gerade ausrollt (statt der
separaten `deployment.md`), formuliert eine vollständige Ersatz-Policy im Header, typischerweise mit
`default-src 'self'`. Weil Policies geschnitten werden, sind danach die `data:`/`blob:`-Bilder und die
`frame-src blob:`-PDF-Vorschau tot, und der Fehler sieht aus wie ein Caching-Problem — exakt die Falle,
die `deployment.md` beschreibt. Auf dem Stalwart-Pfad sucht er zusätzlich nach einem Hook, den es nicht
gibt.

**Empfohlene Maßnahme:** Kommentarblock auf den Stand von SECURITY.md bringen ("a response header is
enforced independently and can only tighten this policy; name only the directives you want to change and
never restate `default-src`") plus Verweis auf `docs/deployment.md#content-security-policy`.
`csp.shipped.test.ts` prüft nur die Direktiven — ein Textabgleich zwischen `index.html` und SECURITY.md
wäre der Gate gegen künftige Drift.

**Aufwand:** S

### W-21 — [LOW] nginx-Rezept: `add_header` in den `location`-Blöcken verwirft die Security-Header des `server`-Blocks

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** deployment / Dokumentation
- `docs/deployment.md:213-215` (location-Blöcke mit `add_header Cache-Control`)
- `docs/deployment.md:352-355` ("add to the `server` block from §2")

**Problem:** nginx vererbt `add_header` von der übergeordneten Ebene nur, wenn auf der aktuellen Ebene
KEIN einziges `add_header` steht. Die drei `location`-Blöcke aus §2 enthalten je ein
`add_header Cache-Control`, also fallen für `/sw.js`, `/config.json` und `/assets/*` alle drei im
CSP-Abschnitt empfohlenen Header ersatzlos weg. Das `always`-Flag steuert nur das Setzen bei
Fehlerantworten, nicht die Vererbung. Die beiden Abschnitte stehen rund 140 Zeilen auseinander.

**Auswirkung:** Wer beide Rezepte wie dokumentiert kombiniert und danach
`curl -I https://<host>/assets/index-abc.js` prüft, bekommt kein `X-Content-Type-Options: nosniff` und
kein `Referrer-Policy: no-referrer` — genau auf den Pfaden, auf denen er sie gerade gesetzt zu haben
glaubt. Praktisch relevant ist vor allem der `nosniff`-Verlust unter `/assets/` und auf `/config.json`;
der CSP-Verlust auf diesen Pfaden ist weitgehend folgenlos, weil CSP das Dokument bindet. Das
Hauptdokument (`location /`) behält seine Header.

**Empfohlene Maßnahme:** Die drei Security-Header in ein Snippet auslagern
(`include snippets/waxwing-headers.conf;` in jedem `location`-Block) oder die Cache-Control-Werte über
`map $uri $waxwing_cache_control` setzen, sodass in den `location`-Blöcken kein `add_header` mehr nötig
ist. Den Vererbungsfallstrick im Text benennen.

**Aufwand:** S

### W-22 — [LOW] Übergroßer Inline-Style wird verworfen, ohne im Remote-Manifest zu landen

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** sauberkeit / Sanitizing
- `packages/mail-html/src/sanitize.ts:236` (Längen-Cutoff)
- Gegenbeispiele im selben Modul: `:237-241` (STYLE_DANGER), `:254-262` (Residual)

**Problem:** Der Längen-Cutoff ist der dritte fail-closed-Pfad in `sanitizeStyle`, schreibt aber weder
`collector.hasRemote` noch einen `blocked`-Eintrag; die beiden anderen Drop-Pfade tun beides.

**Auswirkung:** Eine Mail, deren gesamter Remote-Inhalt in einem einzigen Style-Attribut über
`MAX_STYLE_LENGTH` steckt, verliert sichtbar ihr Styling, während `hasRemoteContent` false bleibt: kein
RemoteContentBanner, die Leserin erfährt weder, dass etwas blockiert wurde, noch dass die Mail Remotes
referenziert. Kein Datenabfluss, aber eine stille Falschaussage der UI.

**Empfohlene Maßnahme:** Vor dem Return `collector.hasRemote = true` setzen und
`collector.blocked.push({ url: css.trim().slice(0, 128), kind: 'style' })` analog zu den anderen Pfaden.

**Aufwand:** S

### W-23 — [LOW] Ein blockierter SecretStore-Wipe bricht den Rest von "Abmelden & Daten entfernen" ab

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / auth
- `apps/web/src/auth/controller.ts:357-360`
- `apps/web/src/auth/secret-store.ts:219` (`SecretStoreBlockedError` bei `onblocked`)
- `apps/web/src/app/session/SessionProvider.tsx:691-693`

**Problem:** `await this.store.wipe()` steht ohne `try`/`finally` vor `if (options.wipeData) await
wipeLocalData(...)`. Lehnt der Wipe wegen `onblocked` ab, wird `wipeLocalData` gar nicht mehr erreicht.

**Auswirkung:** Ein eingefrorener oder bfcached zweiter Tab blockiert `deleteDatabase('waxwing-auth')`.
Die Nutzerin bekommt nur die unspezifische Meldung `auth.error.signOutIncomplete`; zusätzlich überleben
Cache Storage, alle übrigen IndexedDB-Datenbanken und die Service-Worker-Registrierungen, obwohl diese
Schritte vom blockierten Delete unabhängig sind. Der Mail-Replica-Wipe läuft bereits vorher und ist
nicht betroffen, und die Cache Storage enthält laut `sw-routes.ts` keine JMAP-Bytes — es überleben also
App-Shell-Caches und Registrierungen, keine Mailinhalte.

**Empfohlene Maßnahme:** Reihenfolge entkoppeln und den Fehler zuletzt werfen:

```ts
const wipeErr = await this.store.wipe().then(() => null, (e: unknown) => e)
if (options.wipeData) await wipeLocalData(this.resolveWipeEnv())
if (wipeErr) throw wipeErr
```

Zusätzlich in `endSession` unterscheiden, WAS unvollständig blieb.

**Aufwand:** S

### W-24 — [LOW] `boot()` wird ohne Rejection-Handler gestartet — ein Fehler ergibt eine weiße Seite

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit
- `apps/web/src/main.tsx:73` (`void boot()`)
- `apps/web/src/i18n/index.ts:82-85`, `:148-167` (`initI18n` mit dynamischem Chunk-Import, ohne try/catch)
- `apps/web/index.html` (nur `<div id="root"></div>`, kein Fallback, kein `window.onerror`)

**Problem:** `boot()` ist async und wird mit `void` gestartet. Nur `loadConfig` ist intern abgesichert;
`loadThemeOverride`, `applyBranding`, `initTheme`, `initAccent`, `initScrollbarMetrics`,
`initViewportMetrics` und vor allem `await initI18n()` können werfen. Eine React-ErrorBoundary greift
nicht, weil `createRoot(...).render()` erst nach den Awaits läuft.

**Auswirkung:** Schlägt einer dieser Schritte fehl (fehlgeschlagener Chunk-Load nach einem Deploy, Wurf
aus i18next), rendert die App nie: komplett weiße Seite ohne Text, einziger Hinweis ist eine unhandled
rejection in der Konsole. Genau der Fehlermodus, den `app/config.ts:96-101` für eine einzelne Ursache
beschreibt und behebt — die allgemeine Form ist offen.

**Empfohlene Maßnahme:** `boot().catch(...)` mit `console.error` plus einem minimalen,
übersetzungsfreien Fehlertext in `#root`, und einen statischen Fallback-Absatz in `#root` in
`index.html`, den React beim ersten Render ersetzt. Der Fallbacktext muss übersetzungsfrei sein, weil
`initI18n` der wahrscheinlichste Fehlerpunkt ist.

**Aufwand:** S

### W-25 — [LOW] Capability-Sonden werfen `TypeError`, wenn die Session `capabilities`/`accounts` nicht enthält

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Transport
- `packages/jmap/src/session.ts:175`, `:196`, `:261` (Zugriff ohne `?.`)
- `packages/jmap/src/session.ts:50` (`getSession` castet ungeprüft `as Session`)
- Gegenbeispiel: `session.ts:309-315` (`hasCapability` liest bewusst defensiv, mit Begründung)

**Problem:** `getSession` castet die Antwort ohne Strukturprüfung, `normalizeSession` berührt nur die
vier `*Url`-Felder. `hasCapability` greift die fehlenden Maps bewusst mit `?.` ab; `getCoreCapability`,
`getMailCapability` und `getContactsCapability` tun das nicht.

**Auswirkung:** Ein nicht konformer oder feindlicher Server liefert eine Session ohne `capabilities`.
`JmapClient.call()` ruft `resolveLimits()` → `getCoreCapability()` bei jeder Anfrage auf, jeder Request
scheitert also mit einem untypisierten `TypeError`; zusätzlich crasht `useAttachmentUpload` beim Öffnen
des Composers. Der praktisch wahrscheinlichere Fall (Antwort ohne `accounts`/`primaryAccounts`) fällt
schon vorher in die behandelte Onboarding-Fehleranzeige — erreichbar bleibt die kuriose Form
"accounts vorhanden, capabilities fehlt". Robustheit, kein Sicherheitsdefekt.

**Empfohlene Maßnahme:** In den Capability-Sonden defensiv lesen (`session.capabilities?.[...]`,
`session.accounts?.[accountId]`) und in `getSession` den geparsten Body mit einem `isSession()`-Guard
narrowen (Objekt mit `apiUrl`/`downloadUrl`/`uploadUrl`/`eventSourceUrl` als Strings), sonst `JmapError`
statt eines späteren `TypeError`.

**Aufwand:** S

### W-26 — [LOW] `JmapMethodError` wird aus einem ungeprüften Serverwert konstruiert

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Transport
- `packages/jmap/src/errors.ts:175-177` (`isMethodError` prüft nur `invocation[0] === 'error'`)
- `packages/jmap/src/request.ts:165` (`first[1] as MethodErrorObject`)
- `packages/jmap/src/request.ts:172-176` (`methodErrors()`, identische Lücke)
- `packages/jmap/src/errors.ts:81` (Konstruktor liest sofort `error.description ?? error.type`)
- Vorbild im selben File: `errors.ts:180` (`isProblemDetails`)

**Problem:** Das zweite Element der Invocation wird behauptet statt geprüft; `transport.ts` sagt im
Kommentar ausdrücklich, dass die einzelnen Invocations unvalidiert bleiben. Antwortet der Server
`["error", null, "c0"]`, wirft der Konstruktor einen rohen `TypeError` statt des vorgesehenen
`JmapError`.

**Auswirkung:** Untypisierter Fehler statt typisiertem — auf Lesepfaden bricht der Sync-Pass mit einer
Meldung ab, die nicht sagt, was los ist. Nur über einen feindlichen oder grob RFC-widrigen Server
auslösbar, der in SECURITY.md nicht modelliert ist; die Outbox meldet transiente Fehler ab
`STUCK_AFTER_ATTEMPTS = 6` weiterhin als "still trying", die Nutzerin bleibt also nicht stumm.

**Empfohlene Maßnahme:** `isMethodError` das zweite Element mitprüfen lassen (Objekt, nicht `null`,
`typeof .type === 'string'`) — analog `isProblemDetails` —, den Cast streichen, eine nicht erkennbare
Fehler-Invocation als `JmapError('Malformed method error response')` werfen und `methodErrors()` gleich
mit erfassen. Testfall neben den bestehenden Malformed-Envelope-Fällen in `client.test.ts`.

**Aufwand:** S

### W-27 — [LOW] Mailbox-Patch kopiert servergenannte Properties über die Prototypkette

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Sync
- `apps/web/src/sync/engine/delta.ts:229-238` (`if (prop in source)`)
- `apps/web/src/sync/engine/port.ts:114` (`updatedProperties` roh durchgereicht)
- `apps/web/src/sync/engine/delta.ts:138`

**Problem:** `changedProps` kommt unverändert aus der Serverantwort, es gibt keine Allowlist gegen die
tatsächlichen `MailboxRow`-Felder, und der Test ist `prop in source`, das die Prototypkette durchsucht.
Für jedes Objekt sind `'constructor'`, `'toString'`, `'__proto__'` wahr; `patch.constructor = Object`
schreibt einen Funktionswert in den Patch.

**Auswirkung:** Ein feindlicher Server steuert, welche Schlüssel in eine IndexedDB-Zeile geschrieben
werden. Ein Funktionswert ist nicht strukturklonbar, der Mailbox-Delta-Durchlauf bricht also mit einem
`DataCloneError` ab, der Pass wird beim nächsten Sweep wiederholt. Die `__proto__`-Variante ist ein
No-op (der Patch bleibt für diese eine Property leer); daneben genannte echte Properties werden weiterhin
geschrieben. Nur über einen nicht modellierten feindlichen Server erreichbar.

**Empfohlene Maßnahme:** `Object.hasOwn(source, prop)` statt `prop in source` UND eine explizite Allowlist
der patchbaren `MailboxRow`-Felder (die es im Repo noch nicht gibt, sie muss angelegt werden). Testfall in
`delta.test.ts`: `updatedProperties: ['constructor', '__proto__', 'totalEmails']` darf ausschließlich
`totalEmails` schreiben.

**Aufwand:** S

### W-28 — [LOW] `maxSizeUpload` und `maxConcurrentUpload` werden ungeprüft aus der Session übernommen

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Transport
- `packages/jmap/src/session.ts:180-189` (`isCoreCapability` prüft beide Felder nicht)
- `apps/web/src/compose/use-attachment-upload.ts:141-143`, `:154-156`
- `apps/web/src/compose/attachment-upload.ts:82-84` (`size > limits.maxSizeUpload`)
- Vorbild: `packages/jmap/src/client.ts:197-201` (`sanitizeLimits` für die anderen vier Limits)

**Problem:** `??` ersetzt nur `null`/`undefined`, also passieren `0`, `-1`, `NaN` und zur Laufzeit auch
Nicht-Zahlen unverändert. Genau diese Fehlerklasse ist für die anderen vier Limits dokumentiert und
behoben.

**Auswirkung:** Ein Server, der `maxSizeUpload: 0` meldet, lässt `validateFile()` jede Datei als
`tooLarge` ablehnen — Anhänge sind unbenutzbar, und der Toast lautet irreführend
`compose.attachTooLarge` mit `formatBytes(0)`. Ein String-Wert macht den Größenvergleich wirkungslos.
`maxConcurrentUpload` ist teilweise abgesichert (`setUploadConcurrency` übernimmt nur `limit > 0`), nur
ein absurd großer Wert hebt den Pool auf.

**Empfohlene Maßnahme:** Beide Felder in `isCoreCapability` mitprüfen bzw. beim Auslesen durch dieselbe
`usable()`-Logik wie `sanitizeLimits` schicken (endliche Ganzzahl > 0, sonst Fallback).

**Aufwand:** S

### W-29 — [LOW] vCard-Lexer wirft `RangeError` bei wiederholtem Parameter mit vielen Werten

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** dos / Transport
- `packages/jscontact/src/vcard/lex.ts:234-236` (`bucket.push(...values)`)
- `packages/jscontact/src/vcard/lex.ts:205` (Doc-Zusage "Never throws")
- `apps/web/src/contacts/ContactImportExportDialog.tsx:166` (mappt alles auf `failed`)
- Gegenbeispiel: `packages/jmap/src/client.ts:394-396`, `chunking.ts` (`appendAll`)

**Problem:** `bucket.push(...values)` spreizt eine dateikontrollierte Liste in die Argumentliste; ab
etwa 125 000 Werten sprengt das den Call-Stack. Verifiziert:
`TEL;TYPE=a;TYPE=<300k komma-getrennte Werte>:+49` lässt `fromVCard` mit
`RangeError: Maximum call stack size exceeded` durchfallen, obwohl `parseContentLines` und `fromVCard`
beide "Never throws" dokumentieren. Dasselbe Anti-Pattern ist in `packages/jmap` ausdrücklich vermieden.

**Auswirkung:** Eine präparierte `.vcf` lässt den gesamten Import mit einem generischen "failed"
fehlschlagen, statt wie zugesagt die guten Karten zu importieren und die kaputten Zeilen zu melden. Kein
Datenverlust — es wird nichts geschrieben, der Import ist nach Bereinigung der Datei wiederholbar; der
Defekt ist der gebrochene Vertrag plus die nichtssagende Meldung.

**Empfohlene Maßnahme:** Elementweise anhängen (`for (const v of values) bucket.push(v)`), identisch zu
`appendAll()`, und optional eine Obergrenze für die Anzahl Parameterwerte pro Zeile.

**Aufwand:** S

### W-30 — [LOW] Fail-open im Deep-Pin-Check: eine nicht auflösbare Action wird still als geprüft gezählt

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** supply-chain
- `scripts/check-action-tree.mjs:112-114` (`fetchDefinition` gibt `null` zurück)
- `scripts/check-action-tree.mjs:132`, `:134` (`walk` schluckt `null` bzw. nicht parsbare Referenzen)
- `scripts/check-action-tree.mjs:35-40` (eigene Regel: "an unreachable API here is a FAILURE, not a skip")

**Problem:** `fetchDefinition` liefert `null`, wenn `action.yml` UND `action.yaml` mit 404 antworten —
laut eigenem Kommentar ein Fall, der gesagt statt geschluckt werden soll. `walk` kehrt still zurück, der
Zähler `resolved` wurde vorher hochgezählt, und die Abschlusszeile meldet weiter "N action references
resolved … all pinned". Der `!response.ok`-Zweig setzt dieselbe Regel korrekt per `throw` um.

**Auswirkung:** Wird eine gepinnte Action umbenannt, privat gestellt oder ihr Unterpfad geändert, meldet
`pnpm check:actions:deep` grün für eine Action, deren Definition er nie gelesen hat — ausgerechnet der
einzige Check, der bemerkt, dass ein Composite-Action-Aufruf intern auf ein bewegliches Tag zeigt. Der
geschützte Job hält in `release.yml` `contents: write` und `attestations: write`. Das Fenster ist eng:
eine gelöschte oder umgezogene Action fällt ohnehin zur Laufzeit auf, Rate-Limits (403/429) sind bereits
per `throw` abgedeckt.

**Empfohlene Maßnahme:** Den Null-Fall als Befund behandeln statt zu returnen:

```js
if (definition === null) { problems.push(chain(trail, `${reference} — action.yml/action.yaml nicht auflösbar (404)`)); return }
```

Den `parsed === null`-Zweig gleich mitnehmen.

**Aufwand:** S

### W-31 — [LOW] `enqueueAction` ist nicht atomar: optimistische Mutation und Outbox-Zeile liegen in zwei Transaktionen

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Sync
- `apps/web/src/sync/engine/outbox.ts:1941-1960`
- `apps/web/src/sync/engine/outbox.ts:1391-1396` (`applyOptimistic` committet eigene Transaktion)
- `apps/web/src/sync/repo.ts:680-682` (zweite, getrennte Transaktion)
- Vorbild: `apps/web/src/sync/engine/engine.ts:552-585` (`retryFailed` hält alles in EINER Transaktion)

**Problem:** `db.outbox` ist in keiner der Apply-Transaktionen enthalten. Das Modul begründet an anderer
Stelle ausdrücklich, warum Envelope-Patch und Window-Edit in einer Transaktion liegen müssen — für die
Outbox-Zeile, die den kompletten Undo trägt, gilt das Argument stärker. Eine Design-Entscheidung für den
Split ist nirgends dokumentiert.

**Auswirkung:** Stirbt der Tab genau zwischen den beiden IndexedDB-Transaktionen, bleibt die optimistische
Mutation im Replica stehen, ohne Outbox-Zeile, ohne Undo, ohne Dead Letter. Das Fenster ist sehr klein
(Sub-Millisekunden), und der Quota-Fall trägt kaum, weil die erste Transaktion deutlich mehr Bytes
schreibt und zuerst scheitern würde. Fenster und Ordnerzähler werden beim nächsten Sync gegen den Server
rekonziliert; dauerhaft falsch bleibt vor allem `mailboxIds` der betroffenen Envelope-Zeile.

**Empfohlene Maßnahme:** Beide Schritte in eine gemeinsame Dexie-Transaktion legen, die `db.outbox`
einschließt (`applyOptimistic` als Sub-Transaktion; Dexie verlangt dafür nur eine Obermenge der
Tabellen, wie `retryFailed` es vormacht).

**Aufwand:** M

### W-32 — [LOW] `saveDraft`: die `destroy`-Hälfte des `Email/set` wird nie auf Ablehnung geprüft

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** korrektheit / Sync
- `apps/web/src/sync/engine/outbox.ts:2066-2073` (create + destroy in einem Call)
- `apps/web/src/sync/engine/outbox.ts:2151-2153` (`rejections()` sammelt nur `notCreated`)
- `apps/web/src/sync/engine/conflict.ts:85-95` (`isDestroy` enthält `saveDraft` nicht)

**Problem:** Ein Draft-Save ist create-neu + destroy-alt in einem `Email/set`; `result.notDestroyed`
wird nirgends gelesen, während `discardDraft`, `destroyEmails`, `deleteMailbox` und andere ihr
`notDestroyed` korrekt auswerten. Ein Kommentar, der das als best effort begründet, fehlt.

**Auswirkung:** Scheitert nur der Destroy (serverseitiges Refuse genau auf diesem Objekt), gilt die Zeile
als vollständig erfolgreich und die alte Server-Kopie bleibt als Karteileiche im Drafts-Ordner liegen,
ohne dass der Client das je meldet. `forbidden`/`accountReadOnly` würden auch den Create verhindern, der
Auslöser ist also selten; bei systematischer Ablehnung sammeln sich pro Autosave-Intervall weitere
Kopien.

**Empfohlene Maßnahme:** `notDestroyed` für `saveDraft` auswerten — aber nicht naiv: `saveDraft` steht
nicht in `isDestroy`, ein `notFound` auf `priorServerId` (Alltagsfall: Vorentwurf auf einem anderen Gerät
gelöscht) würde sonst als `messageGone`-Conflict den erfolgreich gespeicherten Autosave dead-lettern.
Nötig ist eine eigene Behandlung: Destroy-Ablehnung nur bei nicht-`notFound` melden bzw. die
Destroy-Hälfte mit `isDestroy`-Semantik klassifizieren.

**Aufwand:** M

### W-33 — [LOW] Body-Sync fordert Nachrichtentexte ohne `maxBodyValueBytes` an

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** dos / Transport
- `apps/web/src/sync/engine/port.ts:190-199` (`getEmailBodies`)
- Vorbild: `apps/web/src/mail/use-parsed-message.ts:79` mit `MAX_PARSED_BODY_BYTES` und `isTruncated`-Auswertung

**Problem:** `getEmailBodies` setzt kein `maxBodyValueBytes`, obwohl RFC 8621 das Argument dafür vorsieht
und der Nachbarpfad es korrekt nutzt. Eine Antwortgrößen-Grenze existiert auf JMAP-Ebene nicht; der
Chunker begrenzt nur die Anzahl der Ids.

**Auswirkung:** Eine einzelne sehr große Mail wird ungekürzt geholt, geparst, in IndexedDB geschrieben
und durch den Sanitizer geschickt — blockierter Main-Thread bis Tab-OOM. Kein Verstärkungsfaktor: beide
Aufrufstellen holen genau eine Id pro Request, ein Ordner-Öffnen löst das also nicht aus.

**Empfohlene Maßnahme:** `maxBodyValueBytes` großzügig setzen (1–2 MB), `isTruncated` in `EmailBodyWire`
mitführen, im Reader anzeigen und den vollen Body bei Bedarf gezielt nachladen — ohne das entsteht eine
still beschnittene Offline-Mail, was dem Zweck der Replica widerspricht.

**Aufwand:** M

### W-34 — [LOW] Unbegrenzte Rekursion über servergelieferte `subParts`

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** dos / Transport
- `apps/web/src/mail/message-body.ts:59-79` (`collectCidParts`)
- `apps/web/src/sync/db.ts:328-341` (`collectBodyBlobIds`, im Schreibpfad über `repo.ts:488` und in der Migration `db.ts:873`)

**Problem:** Beide Walks laufen rekursiv über die `bodyStructure`, deren Verschachtelungstiefe der
Server bestimmt; es gibt keine Tiefen- oder Knotengrenze. `JSON.parse` in V8 ist iterativ (nachgemessen
bis 50 000 Ebenen), die Struktur kommt also unbeschadet an — erst der Walk sprengt den Stack.

**Auswirkung:** Die betroffene Nachricht lässt sich nicht anzeigen bzw. der Sync-Schritt bricht mit einem
untypisierten `RangeError` ab und läuft beim nächsten Sweep erneut. Der Vektor ist breiter als nur ein
feindlicher Server: `bodyStructure` ist die vom Server geparste MIME-Struktur, ein ABSENDER kann sie mit
tief verschachtelten multipart-Teilen aufblähen — in der Praxis begrenzen serverseitige MIME-Parser die
Tiefe, was den Fall selten macht.

**Empfohlene Maßnahme:** Beide Walks iterativ mit explizitem Stack schreiben oder eine Tiefen-/Knotengrenze
(z. B. 64 Ebenen bzw. 10 000 Knoten) einziehen und darüber hinausgehende Teile ignorieren.

**Aufwand:** M

### W-35 — [LOW] SW-Deployment-Cache ignoriert den Query-String

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** cache-poisoning / PWA
- `apps/web/src/pwa/sw-routes.ts:100` (`isDeploymentConfig` vergleicht nur `url.pathname`)
- `apps/web/src/sw/sw.ts:104-108` (`NetworkFirst` mit `maxEntries: 8`, ohne `cacheKeyWillBeUsed`/`ignoreSearch`)
- `packages/mail-html/src/sanitize.ts:180`, `frame.ts:173`, `frame.ts:406` (Erreichbarkeitskette)

**Problem:** Das Prädikat ist gegenüber `?…` blind, während der Cache-Key der Cache API die komplette
URL inklusive Search ist. `/config.json?1` … `?8` matchen also alle die Route, werden als acht Einträge
abgelegt und stoßen über `maxEntries: 8` die echten Einträge für `config.json`, `theme.css` und
`manifest.json` per LRU heraus. Erreichbar auch ohne `CACHE_URLS`: eine Mail mit acht pfad-absoluten
`<img src="/config.json?N">` überlebt die Sanitizer-Klassifikation (relative/pfad-absolute URLs werden
unverändert durchgereicht), und nach Freigabe der Remote-Inhalte erlaubt die Frame-CSP
`img-src blob: data: https:` genau diese Same-Origin-Bilder; das `srcdoc`-Dokument erbt Origin und
SW-Controller der App.

**Auswirkung:** Startet die App danach offline, findet der NetworkFirst-Handler keine der drei Dateien
und bootet auf `DEFAULT_CONFIG`: kein Hoster-Branding, kein Theme-Override, `server.sessionUrl` fällt auf
same-origin `/.well-known/jmap` zurück und `allowCustomServer` auf `true` — bei einer
Cross-Origin-Installation also ein Serverfeld, das die Nutzerin plötzlich selbst ausfüllen soll. Der
Zustand heilt beim nächsten Online-Load; das Fenster ist der Offline-Start zwischen präparierter Mail
(inklusive bewusster Remote-Freigabe) und nächstem Online-Load.

**Empfohlene Maßnahme:** `isDeploymentConfig`/`isBrandingAsset` nur bei leerem `url.search` matchen
lassen (kleinste Änderung, passt zur "Anker statt Denylist"-Argumentation des Moduls); alternativ den
Strategien einen `cacheKeyWillBeUsed`-Plugin geben, der `url.search` verwirft.

**Aufwand:** S

### W-36 — [LOW] Abgebrochener OAuth-Redirect lässt die PKCE-Transaktion in der dauerhaften Auth-Datenbank zurück

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** crypto / auth
- `apps/web/src/auth/controller.ts:165-170` (Schreiben in den regulären SecretStore)
- `apps/web/src/auth/controller.ts:206-212` (`PKCE_MAX_AGE_MS` wird nur beim Einlösen geprüft)
- `apps/web/src/auth/controller.ts:224-227` (Löschung nur im `finally` von `completeRedirect`)

**Problem:** Auch im Public-Computer-Modus wird die PKCE-Transaktion in die dauerhafte
`waxwing-auth`-Datenbank geschrieben (der Store kennt kein ephemeres Pendant zur Replica); ein
Aufräumpfad beim Start existiert nicht.

**Auswirkung:** Bricht die Nutzerin beim IdP ab oder stürzt der Browser, bleiben `code_verifier`, `state`
und die aufgelöste OAuth-Config (Issuer, Redirect-URI) liegen, zusammen mit einer angelegten
`waxwing-auth`-Datenbank samt Wrapping-Key — obwohl in diesem Modus nichts Anmeldebezogenes bleiben
soll. Der Verifier ist ohne den zugehörigen Code wertlos; es bleibt ein Metadaten-Hinweis darauf, wer
sich hier wo anzumelden versuchte. Nach erfolgreichem Redirect und bei jedem Sign-out ist der Eintrag
weg, ein späterer Start überschreibt ihn.

**Empfohlene Maßnahme:** Beim Start (analog `sweepEphemeral`) eine abgelaufene `PkceTransaction` löschen
und im ephemeren Modus zusätzlich spätestens beim Sign-out
`store.delete(SecretName.PkceTransaction)` aufrufen.

**Aufwand:** S

### W-37 — [LOW] Zweite, eigenständige `escapeHtml`-Implementierung neben der geteilten

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** sauberkeit
- `apps/web/src/compose/html-to-text.ts:41-47`
- `packages/mail-html/src/escape.ts:15-17`
- Gegenbeispiel: `apps/web/src/mail/search/snippet.ts:9` (importiert die geteilte Variante)

**Problem:** Dieselbe Sicherheitshilfsfunktion existiert zweimal mit identischer Semantik, aber
getrennter Implementierung. `apps/web` hängt bereits an `@waxwing/mail-html` und nutzt die geteilte
Variante an anderer Stelle — die lokale Kopie ist reine Duplizierung.

**Auswirkung:** Heute keine Fehlfunktion und kein Angriffspfad; beide Kopien sitzen aber an einer
Vertrauensgrenze (servergelieferte Suchsnippets bzw. Klartext-Rendering fremder Mail auf der einen
Seite, `plainTextToHtml` in das contenteditable des Composers auf der anderen). Wird eine der beiden
erweitert — etwa um Backtick oder `=` für unquotierte Attributkontexte — bleibt die andere zurück, und
niemand sieht es, weil zwischen ihnen keine Referenz besteht.

**Empfohlene Maßnahme:** Die lokale Funktion löschen und `escapeHtml` aus `@waxwing/mail-html`
importieren. Der Dateikopf von `html-to-text.ts` ("intentionally dependency-free") ist dabei anzupassen —
der Import einer reinen Funktion aus einem Workspace-Paket verletzt weder Testbarkeit noch
Seiteneffektfreiheit.

**Aufwand:** S

### W-38 — [LOW] Navigation im Public-Computer-Modus hinterlässt Suchbegriffe und Ordnernamen im Browserverlauf

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** privacy
- `apps/web/src/mail/search/use-search.ts:151-165` (`goto` ohne `replace`), `:171-176`
- `apps/web/src/mail/search/SearchBox.tsx:88-91` (Absenden)
- `apps/web/src/app/route/RouterProvider.tsx:65-69` (`history.pushState`)

**Problem:** `setQuery` beim Absenden, `setScope` und `removeChip` navigieren ohne `replace`, erzeugen
also je einen History-Eintrag; der ephemere Modus ist der Suche nicht bekannt. (Tippen erzeugt keine
Einträge — die SearchBox debounct mit `replace: true`.)

**Auswirkung:** Auf einem öffentlichen Rechner überlebt der Browserverlauf alle drei in SECURITY.md §3.1
genannten Löschwege, die nur IndexedDB betreffen: `…/mail/inbox?q=from:anwalt%20kündigung` steht weiter
in der Zurück-Liste, zusammen mit dem gesetzten Dokumenttitel. Der Angreifer ist der Folgenutzer
desselben Profils und braucht kein Werkzeug außer Strg+H. Die Exposition ist nicht suchspezifisch — jede
Ordner-/Nachrichtennavigation pusht ebenfalls URLs mit Ordnernamen und Message-Ids, und keine Web-App
kann den Browserverlauf löschen.

**Empfohlene Maßnahme:** Primär diese Grenze in SECURITY.md §3.1 benennen, wo die Grenzen des Modus
ohnehin explizit stehen; sekundär im ephemeren Modus grundsätzlich mit `{ replace: true }` navigieren.

**Aufwand:** S

### W-39 — [LOW] Bekannte Bypass-Klassen fehlen in den Sanitizer-Testvektoren

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** test-coverage
- `packages/mail-html/src/sanitize.test.ts:430-431`, `:690` (Kommentar-Vektoren nur ohne `"`/`(`)
- `packages/mail-html/src/quoted-html.test.ts` (kein Kommentar-Vektor)
- `packages/mail-html/src/sanitize-css.test.ts:35` (nur escaptes SCHEMA, kein escapter Funktionsname)
- `packages/mail-html/src/frame.test.ts:311` (nie ein Anker, der bereits mit `target="_blank"` ankommt)

**Problem:** Die Suite pinnt die Splitter-Divergenzen sehr sorgfältig (unbalanciertes `(`,
unterminierter String, streuendes `)`, Newline im String), aber genau drei bekannte Klassen fehlen und
alle drei sind heute live: CSS-Kommentar mit `"` bzw. `(` darin, escapter Funktionsname `u\72 l(`, und
ein bereits mit `target` ankommender Anker.

**Auswirkung:** Derivativ — die eigentliche Fehlerfolge steckt in W-01, W-03 und W-04. Weil die
Kommentare in `sanitize.ts`, `quoted-html.ts` und `link-host.ts` diese Klassen als geschlossen
beschreiben, wird ein Reviewer sie ohne Test auch künftig nicht nachprüfen.

**Empfohlene Maßnahme:** Je einen Vektor ergänzen: `color:red/*"*/;position:fixed` und
`color:red/*(*/;display:none` gegen `filterAnchorStyle` und `filterQuotedStyle`;
`background:u\72 l(https://evil.example/x.png)` gegen `sanitizeStyle` (erwartet: blockiert und im
Manifest); ein `mountMailFrame`-Test, der `renderPlainText`-Ausgabe montiert und pinnt, dass ein vom
Gate BEHALTENER Link kein `target` behält und `preventDefault()` bekommt.

**Aufwand:** S

### W-40 — [LOW] Public-Computer-Testabdeckung prüft nur IndexedDB, nie Re-Auth und nie das Web-Storage

**Status:** [x] erledigt

**Kategorie / Fundstelle(n):** test-coverage — zusammengefasst aus 2 Einzelbefunden (Dimensionen auth, persistenz)
- `e2e/tests/public-computer.spec.ts:23-26` (einzige Messgröße `indexedDB.databases()`)
- `e2e/tests/public-computer.spec.ts:94` (localStorage nur als Fixture-Aufräumen)
- `apps/web/src/app/session/SessionProvider.test.tsx:336ff` (Public-Computer-Block deckt nur den ERSTEN Login ab)
- `apps/web/src/app/session/SessionProvider.test.tsx:241-263` (Reauth-Tests ohne Public-Computer-Kontext)
- `apps/web/src/sync/ephemeral.test.ts` (prüft nur den Ephemeral-Index)

**Problem:** Kein Test ruft `resolveReauthOAuth` in einer Public-Computer-Session auf und prüft danach die
`startLogin`-Argumente oder das Ausbleiben von AuthRecord/Refresh-Token; und für `waxwing.accounts`
existiert weder in den Unit- noch in den E2E-Tests eine einzige Zusicherung. Die Zusage "Keeps no mail
and no sign-in on this device" ist nirgends als ausführbare Aussage über den gesamten Origin-Speicher
formuliert, sondern nur über eine von drei Speicherarten. (Für den ERSTEN OAuth-Login prüft das E2E-Spec
die Auth-Hälfte sehr wohl.)

**Auswirkung:** Derivativ — genau in dieser Lücke liegen W-02 und W-05, die beiden Befunde mit dem
größten Bezug zu FR-AUTH-09.

**Empfohlene Maßnahme:** (1) Unit-Test: Public-Computer-OAuth-Login → `reportAuthExpired()` →
`resolveReauthOAuth()` → `expect(spies.startLogin).toHaveBeenLastCalledWith({ method:'oauth', publicComputer:true })`.
(2) E2E: nach Sign-out/Reload über `Object.keys(localStorage)` und `sessionStorage` gegen eine Allowlist
assertieren (erlaubt: reine Präferenzschlüssel), dieselbe Prüfung für den FR-AUTH-05-Pfad. Zusammen mit
dem Fix zu W-05 umsetzen, sonst schlägt die Assertion sofort fehl.

**Aufwand:** S

## Abarbeitungsreihenfolge

### Sofort

1. **W-01** — einziger Befund mit einem Angriff bis in das App-DOM des Composers; die fail-closed-Variante ist eine Zeile pro Splitter.
2. **W-02** — bricht die zentrale Zusage von FR-AUTH-09 mit einem einzigen Klick und ist mit zwei Zeilen behoben.
3. **W-05** — Identität der Vorgängerin auf geteilten Geräten, drei kleine Änderungen an bereits vorhandenen, nur nie aufgerufenen Funktionen.
4. **W-03** — stellt das nicht abschaltbare Link-Interstitial für Plain-Text-Mail wieder her, ein `removeAttribute`.
5. **W-04** — schließt den Firewall-Bypass und beendet die Falschaussage "kein Remote-Inhalt", reine Reihenfolgeänderung.
6. **W-06** — verhindert, dass Passwort oder Refresh-Token der jeweils anderen Anmeldeart am Gerät liegen bleiben; zwei `delete`-Aufrufe.
7. **W-39** und **W-40** — die Regressionstests zu 1–6 direkt mitziehen, sonst kehren die Defekte lautlos zurück.

### Nächste Iteration

8. **W-07** — stiller Datenverlust beim vCard-Import, Fix ist eine Handvoll Zeilen in einer Datei.
9. **W-08** — stellt Reviewbarkeit und Durchsuchbarkeit zweier Produktivdateien wieder her; ein Zeichen pro Stelle plus CI-Wächter.
10. **W-09** — beendet die vom Server steuerbare Endlosschleife nach dem im Repo bereits vorhandenen Muster.
11. **W-10** — schließt den stillen Sendeverlust; der Sendepfad zuerst, die übrigen Dispatches über eine gemeinsame Hilfsfunktion.
12. **W-12** — ohne diesen Fix führt jeder volle Speicher zu dauerhaft blockiertem Sync mit falscher Meldung.
13. **W-11** — Größengrenze für Downloads, betrifft jeden Anhangsklick.
14. **W-16** — Timeouts sind Voraussetzung dafür, dass der Sign-out-Wipe zuverlässig durchläuft.
15. **W-13** und **W-14** — die beiden Outbox-Rennen mit demselben Claim-Muster beheben, das `cancelSend`/`retryFailed` bereits vormachen.
16. **W-15** — Teardown awaitbar machen und das Abort-Signal in `replayOutbox` durchreichen; verwandt mit 15 und sinnvoll im selben Durchgang.
17. **W-19**, **W-20**, **W-21** — drei Dokumentationsfehler, die Betreiber aktiv in falsche Konfigurationen führen; zusammen eine kurze Sitzung.
18. **W-17** — entweder Scope verdrahten oder den Switcher ehrlich beschriften; die Zwischenlösung ist billig, die volle Lösung nicht.

### Backlog

19. **W-22**, **W-23**, **W-24** — kleine Korrektheits- und Meldelücken, jede für sich ein kurzer Patch.
20. **W-25**, **W-26**, **W-27**, **W-28** — Härtung gegen nicht konforme Serverantworten; sinnvoll gebündelt, weil alle dieselbe Klasse betreffen.
21. **W-29**, **W-30**, **W-35**, **W-36**, **W-37** — Einzeiler bis Kleinstpatches ohne Alltagsauswirkung.
22. **W-31**, **W-32**, **W-33**, **W-34** — erfordern Design-Entscheidungen (Transaktionszuschnitt, Conflict-Klassifikation, Truncation-UI) und gehören daher hinter die einfachen Fixes.
23. **W-18** — größter Einzelaufwand, aber der einzige Befund, bei dem der sensibelste Teil der Replica unbegrenzt wächst; nicht dauerhaft liegen lassen.
24. **W-38** — primär eine Ergänzung in SECURITY.md §3.1, weil die Ursache außerhalb der App liegt.
