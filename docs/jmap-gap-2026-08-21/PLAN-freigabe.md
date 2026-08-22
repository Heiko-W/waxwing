# Freigabe- und Delegations-Plan (S-1 … S-7)

Erarbeitet 21.08.2026. **Referenz bei Zweifel ist Stalwart v0.16.18.** Die Messungen im
Bericht `berichte/D-sharing-pim.md` stammen von v0.16.14 — v0.16.17 hat einen Fehler behoben,
durch den ACL-Freigaben gar nicht erst in der Session auftauchten. Was neu zu messen ist,
steht unten.

## Reihenfolge

1. **A — Fundament (M).** `packages/jmap`: `Mailbox.shareWith` + `MailboxRights.mayShare`
   (fehlen im Typ), `Calendar.shareWith`, URN `mail:share`, Möglichkeit `using` je Request zu
   ergänzen, `ShareNotification/changes|query`.
   Neu: `apps/web/src/sharing/` — Rollenmodell und generischer `ShareDialog`, hochgezogen aus
   `files/sharing.ts` + `files/ShareDialog.tsx`.
2. **B — S-3 + S-1 (M).** Mailordner freigeben, eingehende Freigaben sichtbar. Läuft **ohne**
   S-4, weil nur der Mail-Bereich schon kontofähig ist — das erste end-to-end sichtbare Ergebnis.
3. **C — S-2 + S-4 als ein Paket (L).** `sharedAccountsFor(session, urn)` neben
   `secondaryMailAccounts`; Kontoabschnitte in Kontakte/Dateien; **neues Kalender-Rail** (es gibt
   heute keins — `CalendarPage` lädt `calendars` nur für den Termin-Dialog); `shareWith` für
   Kalender/Adressbuch; `?account=` auf `/calendar|/contacts|/files` ausweiten
   (`carryAccount` in `RouterProvider.tsx:37` filtert hart auf `/mail`).
4. **D — S-5 (S/M).** Dritte `RecipientSuggestionSource` über `Principal/query`. Unabhängig,
   kann vorgezogen werden. Mindestens 2 Zeichen, 250 ms Verzögerung, ein Fehler löscht **nie**
   lokale Treffer.
5. **E — S-6 (M).** Kein Teilnehmer-Wähler, sondern „Verfügbarkeit von X einblenden" als
   Hintergrundstreifen in `WeekView` — der Teil, der ohne K-3 trägt. Braucht C.

**S-7** ist kein Feature, sondern ein Wächtertest gegen `Methods.principalSet`
(`Principal/set` reißt die **gesamte** Anfrage mit HTTP 400 `notRequest` weg).

## Drei tragende Entwurfsentscheidungen

### 1. Drei Rollen tragen — außer zweimal, und das muss man sagen
- **Adressbuch** passt exakt: Ansehen = `mayRead`, Bearbeiten = + `mayWrite`,
  Verwalten = + `mayDelete` + `mayShare`.
- **Kalender braucht vier** Stufen, weil `mayReadFreeBusy` allein eine echte, in iCloud übliche
  Stufe ist („nur Verfügbarkeit").
- **Mail bricht das Muster:** „Ansehen" **muss** `maySetSeen: false` setzen, sonst markiert der
  Leser dem Eigentümer die Post als gelesen — der Erklärtext muss das benennen. `maySubmit`
  bleibt in **allen** Rollen `false` (ADR-020: kein Senden aus fremdem Konto).
  `mayCreateChild` / `mayRename` / `mayDelete` betreffen den Ordner, nicht die Post, gehören
  also zu „Verwalten".

### 2. Die Capabilities lügen bei S-4 — nachgemessen am 21.08. gegen v0.16.18
Ein Fremdkonto erscheint mit dem **vollen** Capability-Satz, sobald **irgendein** Objekt geteilt
ist. **Auch auf v0.16.18** — der v0.16.17-Fix ändert daran nichts. Gemessen: carol gibt alice
**nur einen Kalender** frei; alices Session führt carol daraufhin mit allen 17 Capabilities,
einschließlich `mail`, `contacts` und `filenode`. Der heutige Mail-Filter
(`session.ts:239-252`) auf die URN liefert für Kalender/Kontakte/Dateien also Falsch-Positive.

**Aber die Sondierung ist billiger als gedacht.** Ein nicht freigegebener Typ antwortet nicht
mit einer leeren Liste, sondern mit einem klaren Fehler:
```
Mailbox/get   { accountId: "d" } → error forbidden "You do not have access to account d"
AddressBook/get, FileNode/query  → dasselbe
Calendar/get  { accountId: "d" } → OK, ein Kalender
```
Das ist **besser** als eine leere Liste, die auch „freigegeben, aber leer" heißen könnte.

**Und `forbidden` ist ein lokaler Fehler** — gemessen: ein Batch aus fünf Aufrufen, von denen
drei `forbidden` liefern, gibt trotzdem alle fünf Teilantworten zurück. (Anders als
`Principal/set`, das die ganze Anfrage mit `notRequest` wegwirft — siehe S-7.)

**Regel: ein einziger Batch mit je einem Sondier-Aufruf pro Typ und Fremdkonto.
`forbidden` ⇒ Abschnitt nicht rendern, `OK` ⇒ rendern.**
Der Test, der das festnagelt, ist der wertvollste des ganzen Pakets.

### 3. iCloud-Muster statt Kontowechsler
Eigene und fremde Inhalte als Abschnitte im **selben** Rail (genau `AccountTrees`). Freigeben
über ein Popover am Objektnamen. Eingehende Freigabe als **ruhige Karte** oben im betroffenen
Rail („Carol hat den Kalender ‚Projekt' freigegeben — Öffnen / Ausblenden") — kein Modal, kein
roter Zähler; Sammelliste in den Einstellungen.
Telefon/Tablet: Rail als Drawer wie der Mail-Ordner-Drawer, Rollenwahl als nativer `Select`,
Personenzeile zweizeilig (44 px bleiben). Der Dialog braucht eine Sheet-Variante — das wäre
eine Änderung am Design-System und gehört in ein eigenes Paket.

## Neu zu messen (gegen v0.16.18)

- ~~Ob der v0.16.17-Fix die Session-Sichtbarkeit granular macht.~~ **Am 21.08. gegen v0.16.18
  gemessen: nein, sie bleibt grobkörnig.** Siehe Entscheidung 2 — die Sondierung über
  `forbidden` ersetzt sie.
- Liefert `AddressBook/get` **ohne** `properties` überhaupt `shareWith`? Das heutige
  „Shared"-Badge (`AddressBookList.tsx:72`) hängt daran und ist womöglich seit jeher tot;
  `port.ts:326` fragt keine `properties` an. Für `Calendar` ist belegt: nur auf Anfrage.
- ~~Verlangt `Mailbox/set … shareWith` die URN `urn:ietf:params:jmap:mail:share` im `using`
  (die e2e-Fixture sendet sie), und reißt eine dem Server unbekannte `using`-URN die Anfrage ab?~~
  **Am 21.08. gegen v0.16.18 gemessen: nein und ja.** `Mailbox/get properties:['shareWith']` und
  `Mailbox/set … shareWith` gelingen beide mit `using: [core, mail]` allein. Eine dem Server
  unbekannte URN wirft dagegen die **ganze** Anfrage weg — HTTP 400 `notRequest`, keine einzige
  Teilantwort, dieselbe Bruchstelle wie `Principal/set`. Die URN gehört deshalb **nicht** in
  `PREFIX_TO_CAPABILITY` (sie käme sonst in jede Mailbox-Anfrage), sondern als Konstante
  `Capabilities.mailShare` für den Opt-in über `CallOptions.using`.
- **Neu gemessen: `Mailbox/get` liefert `shareWith` NUR auf Anfrage.** Ohne `properties` kommen elf
  Schlüssel zurück und `shareWith` ist keiner davon; der Sync-Motor (`port.ts`) fragt keine
  `properties` an, also hat keine Replica-Zeile je eine Freigabekarte gehalten. Ein Dialog muss sie
  selbst holen. Dasselbe zu prüfen für `AddressBook` (S-2, offen).
- **Neu gemessen: `myRights` hat zehn Schlüssel, nicht die neun aus RFC 8621.** `mayShare` kommt
  bei jedem `Mailbox/get` mit. Alle zehn werden in `shareWith` akzeptiert; ein erfundener elfter
  (`mayFlibber`) wird **pro Objekt** mit `invalidProperties: 'Invalid permission "mayFlibber"'`
  abgelehnt, die Anfrage überlebt. Der Server normalisiert: `{mayReadItems:true}` liest sich als
  alle zehn Schlüssel mit dem Rest auf `false`.
- Was löschen `Calendar.mayDelete` / `AddressBook.mayDelete` — den Container oder den Inhalt?
  Entscheidet, ob sie zu „Bearbeiten" oder „Verwalten" gehören. Konservativ bis dahin:
  „Verwalten".
- ~~Trägt `StateChange` einen `ShareNotification`-Typ? Sonst muss S-1 pollen statt zu lauschen.~~
  **Am 21.08. gemessen: ja — S-1 lauscht.** Über WebSocket mit `WebSocketPushEnable` liefert der
  Server beim Freigeben durch carol auf alices Verbindung
  `{"@type":"StateChange","changed":{"b":{"ShareNotification":"sqcwidwels9imcba"}}}` — alices
  **eigene** Konto-Id, ein eigener Typname, ein eigener Frame (der `Mailbox`-Frame geht an die
  Eigentümerin). Der Name muss in den `dataTypes` der Push-Anmeldung stehen, sonst filtert der
  Server ihn weg; `WATCHED_TYPES` in `sync/engine/engine.ts` führt ihn jetzt.
- **Neu gemessen, und es kostet eine Entwurfsentscheidung: `ShareNotification.changedBy` kann die
  falsche Person nennen.** Eine Freigabe, die carol per `Mailbox/set` erteilt hat, kam mit
  `{principalId:"d333333", name:"Recovery admin account", email:"admin"}` an — während ein
  `Calendar/set` desselben Kontos korrekt Carol nannte. Ebenso ist `ShareNotification.name`
  durchgehend der **leere String**, nie der Objektname. Die Karte nimmt den Namen deshalb aus
  `objectAccountId` (die Session führt geteilte Konten namentlich) und den Ordnernamen aus der
  Replica; `changedBy` ist nur Rückfalloption und wird verworfen, wenn es ein Administrationskonto
  nennt.
- **Neu gemessen: `ShareNotification/changes` und `/query` funktionieren** (`query` meldet sogar
  `canCalculateChanges: true`, `filter: {objectType:"Mailbox"}` filtert korrekt). `/changes` mit
  `sinceState: "0"` antwortet `invalidArguments` — es braucht einen echten State-String.
- Kommt eine Freigabe an einen **Gruppen**-Principal bei den Mitgliedern an? Solange offen:
  Gruppen im Wähler nicht anbieten.
- FileNode-Vererbung: Download eines Kindknotens gelingt, `myRights` meldet trotzdem alles
  `false` (§4.3) — für S-4/Dateien dürfen Aktionen **nicht allein** an `myRights` hängen.

## Wichtigste Dateien
- `apps/web/src/files/sharing.ts`, `apps/web/src/files/ShareDialog.tsx` (die Vorlage)
- `packages/jmap/src/session.ts`
- `apps/web/src/mail/AccountTrees.tsx`
- `apps/web/src/calendar/CalendarPage.tsx`


---

## Nachtrag 22.08.2026 — die vier offenen Messfragen zu S-2/S-6

Gegen die laufende Fixture (v0.16.18) beantwortet, nachdem S-2/S-6 gebaut waren:

**1. `myRights` enthält `mayShare` — bei beiden Typen.** Das war die kritische Frage: hätte es
gefehlt, wäre das Freigabe-Bedienelement im Kontakte-Rail nie erschienen, also ein toter Pfad wie
seinerzeit beim Kontaktfoto.
```
AddressBook myRights: mayDelete, mayRead, mayShare, mayWrite            (4 Schlüssel)
Calendar    myRights: mayDelete, mayRSVP, mayReadFreeBusy, mayReadItems,
                      mayShare, mayUpdatePrivate, mayWriteAll, mayWriteOwn  (8 Schlüssel)
```
Damit ist zugleich **Frage 4 beantwortet**: die aus dem Bericht übernommenen Schlüssel stimmen
exakt. Anders als beim Mailordner, wo es zehn statt neun waren, gibt es hier keine Überraschung.

**2. `Principal/getAvailability` verlangt seine URN NICHT.** Derselbe Aufruf liefert mit und ohne
`urn:ietf:params:jmap:principals:availability` im `using` dieselben Frei/Belegt-Zeiten.

**Aber eine Freigabe verlangt es sehr wohl — und das hatte ich falsch.** Die Messung oben lief
gegen das *eigene* Konto und sagte daher nichts über den interessanten Fall. Sauber nachgemessen
am 22.08. (alice fragt bobs Kalender ab, in dem ein Termin liegt):
```
ohne Freigabe                       → {"list":[]}
mit shareWith { mayReadFreeBusy }   → {"list":[{"utcStart":"…08:00:00Z","utcEnd":"…10:00:00Z",
                                                "busyStatus":"confirmed","event":null}]}
```
Frei/Belegt ist damit **keine** Auskunft, die das Verzeichnis von sich aus gibt. Ein E2E-Test für
S-6 muss die Freigabe folglich einrichten — das ist Vorbedingung, nicht Schönfärberei.

**Der Gegentest ist dabei der eigentliche Ertrag:** eine *unbekannte* URN im `using` lässt die
Antwort ohne `methodResponses` zurückkommen — die ganze Anfrage fällt aus. Genau das war die
Begründung, die Übersteuerungstabelle **nicht** zu bauen und die URN nur dann mitzusenden, wenn die
Session sie führt. Die Entscheidung ist damit belegt und nicht bloß vorsichtig.

**3. `Calendar/AddressBook.mayDelete` — Container oder Inhalt?** Weiterhin ungemessen. Die Antwort
ließe sich nur durch einen echten Löschversuch auf fremdem Gut finden, und der Preis eines Irrtums
(die Termine eines anderen) rechtfertigt die Neugier nicht. Beide bleiben konservativ in
„Verwalten"; das ist die Einordnung, die im Zweifel zu wenig erlaubt statt zu viel.
