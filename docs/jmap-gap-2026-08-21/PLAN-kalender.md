# Kalender-Umsetzungsplan (K-1 … K-10)

Erarbeitet 21.08.2026 gegen `draft-ietf-calext-jscalendarbis-18` (31.07.2026, an die IESG
übergeben, obsoletet RFC 8984) und die Messberichte. **Referenz bei Zweifel ist Stalwart
v0.16.18**, nicht der Entwurfstext.

## Reihenfolge
K-6+K-7 (Typen, blockiert alles) → K-1 (Kalenderverwaltung) → K-5 (Erinnerungen, baut das
Zeilen-Layout für K-2/K-3) → K-2 (Serien) → K-4 (ICS-Import) → K-10 → K-3 (Teilnehmer/RSVP).

---

## Wire-Fakten (alle gemessen, nicht vermutet)

### `baseEventId` — der fehlende Verknüpfungsschlüssel
Stalwart liefert ihn auf **jeder** expandierten Instanz: `{"id":"iaaaaaf","baseEventId":"f"}`.
Im Typ fehlt er. Er ersetzt die Signatur-Heuristik in `resolveIdentity` als **sicherster
Zweig** (die Signatur bleibt als Rückfall — der Dateikopf von `calendar-client.ts` sieht
genau das seit jeher als „dritten, sichereren Zweig" vor). Ohne ihn ist keine
Serienbearbeitung möglich, weil jeder `recurrenceOverrides`-Patch den Master adressieren muss.
`CalendarEvent/query` mit Expansion: *"Only 'id' and 'baseEventId' properties are supported in results"*.

### `recurrenceRule` statt `recurrenceRules`
- `recurrenceRules: [...]` → `{"type":"invalidProperties","properties":["recurrenceRules"]}`
- `recurrenceRule: {...}` → `created`. Auch beim **Lesen** Singular.

### `Calendar` — fehlende Eigenschaften (alle belegt)
`isVisible` (bool), `includeInAvailability` (`'all'|'attending'|'none'`),
`defaultAlertsWithTime` / `defaultAlertsWithoutTime` (`Record<Id, Alert>|null`),
`shareWith` (`Record<Id, CalendarRights>|null`).

**Falle:** `Calendar/get` **ohne** `properties` liefert nur
`id, name, description, color, timeZone, sortOrder, isDefault, isSubscribed, myRights`.
`isVisible`, `shareWith`, `defaultAlerts*`, `includeInAvailability` kommen **nur auf
ausdrückliche Anfrage**. `listCalendars()` stellt heute gar keine `properties` — wer
`isVisible` in den Typ schreibt und die Anfrage nicht anpasst, bekommt überall `undefined`.
**Regel: `isVisible === false` heißt versteckt, alles andere (auch `undefined`) sichtbar.**

**Abgelehnt:** `participantIdentities` am Kalender → `invalidProperties`. Stattdessen
`ParticipantIdentity/*`.

### `CalendarEvent` — weitere Abweichungen
| heute | richtig |
|---|---|
| — | `baseEventId?: Id` |
| — | `organizerCalendarAddress?: string` |
| — | `method?: string` — **immutable**, `{"description":"This property is immutable."}` |
| — | `sentBy?: string` — **KORREKTUR 21.08.: gehört zu `Participant`, nicht zu `CalendarEvent`.** Auf dem Draht nie gesehen. |
| `recurrenceOverrides: Record<..., Record<string,unknown>\|null>` | `Record<LocalDateTime, PatchObject>` mit `excluded?: true` als Mitglied |

`calendarIds`, `isOrigin`, `isDraft`, `baseEventId` stammen aus `draft-ietf-jmap-calendars`,
**nicht** aus JSCalendar — der Dateikopf sollte das trennen.
**KORREKTUR 21.08.:** `recurrenceId` gehört zu JSCalendar, nicht zur JMAP-Schicht.

`RecurrenceRule`: **`byMonth` ist `String[]`** (`"1"`…`"12"`, Schaltmonate mit `L`-Suffix),
nicht `number[]`. **KORREKTUR 21.08.: das ist KEINE bis-Abweichung** — RFC 8984 typisiert es
genauso; Waxwing hatte das Feld schlicht gar nicht.

`minDateTime`/`maxDateTime` sind als `LocalDateTime` typisiert, Stalwart sendet aber
`"0001-01-01T00:00:00Z"` — mit `Z`. Kommentar setzen, Typ nicht verbiegen.

### `Participant` — `calendarAddress`, nicht `sendTo`
`sendTo: {imip: "mailto:…"}` wird **still verworfen** — `/set` meldet `created`, das Event
hat danach schlicht keine `participants`. Richtig:
```jsonc
{ "@type":"Participant", "calendarAddress":"mailto:carol@waxwing.test",
  "roles":{"owner":true,"attendee":true}, "participationStatus":"accepted" }
```
**Falle:** Beim Rücklesen ergänzt der Server einen **dritten Eintrag** mit der Adresse des
Organisators und nur `name`. Die Teilnehmerliste muss nach `calendarAddress` **entdoppelt**
werden, sonst steht der Organisator zweimal da.
`scheduleStatus` wurde nie zurückgeliefert — als „readonly, may never appear" kommentieren.

### `alerts`
Steht in **keiner** Property-Liste des Clients — wird nicht einmal abgefragt. Form:
`{"k1":{"@type":"Alert","action":"display","trigger":{"@type":"OffsetTrigger","offset":"-PT15M"}}}`.
Ganztägig: `offset:"-PT9H"` (relativ zum Mitternachtsbeginn).

`draftToEvent()` ist ein **Patch** — `alerts` darf nicht bedingungslos hinein:
`undefined` = unangetastet (nicht im Patch), `[]` = ausdrücklich geleert (`alerts: null`).

### `recurrenceOverrides` — nur Zeiger-Patches
Beim Rücklesen enthält die Karte **nur noch** den `excluded`-Eintrag; ein verschobener Termin
ist als eigenständige Instanz materialisiert (behält synthetische Id und `baseEventId`).
**Die Karte darf nie als Ganzes gelesen, verändert und zurückgeschrieben werden.** Nur:
```jsonc
update: { "<masterId>": { "recurrenceOverrides/2026-09-14T09:00:00": { start:"…" } } }
```
**Ungeprüft:** ob ein *Patch* `"recurrenceOverrides/<rid>": {"excluded":true}` genauso
angenommen wird wie derselbe Wert beim `create`. Sonde vor dem Bau.

### `CalendarEvent/parse` — Array je Blob
```jsonc
{"parsed":{"<blobId>":[ { "@type":"Event", "uid":"…", "title":"…",
  "recurrenceRule":{…}, "alerts":{…}, "organizerCalendarAddress":"mailto:…",
  "iCalendar":{"convertedProperties":{…},"name":"vevent"} } ]}}
```
Der Wert ist ein **Array** — eine VCALENDAR kann mehrere VEVENTs enthalten. Ein Client, der
ein Objekt erwartet, verliert schweigend den zweiten Termin.

Vor dem `create` zu entfernen: `iCalendar`, `method` (immutable; ein geparstes `"request"`
ließe den Termin dauerhaft wie eine Einladung aussehen), `id`/`created`/`updated`/`isOrigin`.
Zu ergänzen: `calendarIds`. **Zu behalten: `uid`** — dadurch entdoppelt ein erneuter Import.

### ICS-Export ist über JMAP **nicht möglich** (gemessen)
`CalendarEvent/get` mit `properties: ["iCalendar"|"blobId"|"iCalendarBlobId"|"ical"]` liefert
jedes Mal nur `{"id":"e"}` — still verworfen. `CalendarEvent/export` → `unknownMethod`. Es
gibt **keinen Blob und keine `downloadUrl`** für einen Termin. Über CalDAV geht es
(`GET /dav/cal/<mail>/<kalender>/<uid>` → 200), aber das bricht FR-DEP-05 (Cross-Origin) und
der Pfad steht in keiner JMAP-Session.
→ **Eigener Serialisierer im Client**, Gegenstück zu `contact-io.ts`. Ehrlich benennen, was
er weglässt: für „weitergeben" gedacht, nicht als Sicherung. Gehört in den Modulkopf, nicht
in den Dialog.

### `ParticipantIdentity` — drei Fallen
- `isDefault` ist **schreibgeschützt** in `create` *und* `update` (`"Field could not be set."`).
  **Nie senden.**
- `/changes` antwortet **immer** `cannotCalculateChanges` — nie aufrufen.
- Die Session nennt `accounts[…].calendars.calendarAddress` — billigerer Weg zur eigenen
  Adresse, reicht für den RSVP-Abgleich.
- **Warnung:** Bei der Erhebung wurde damit die Standard-Identität eines Testkontos zerstört
  und ließ sich nur mit abweichender Id wiederherstellen. **Die E2E-Write-Suite darf gegen die
  geteilte Fixture ausschließlich `ParticipantIdentity/get` fahren.**

### RSVP — belegt
```jsonc
CalendarEvent/set { update: { "e": { "participants/pa/participationStatus": "accepted" } } }
→ {"updated":{"e":null}}   // der Organisator liest "accepted" zurück
```
Setzt `myRights.mayRSVP` auf dem Kalender voraus.

### Einladungen verschicken — **nicht belegt**
Auf v0.16.14 gemessen: **null** — keine Mail, kein Warteschlangeneintrag, kein Termin beim
Eingeladenen, auch mit `sendSchedulingMessages:true` / `scheduleAgent:"server"` /
`scheduleForceSend:"request"`. Zeitgleich lag ein fremder, erfolgreicher Mailversand im Log,
die Zustellkette funktioniert also.
Die v0.16.18-Anmerkungen nennen genau das als behoben — **das ist eine Release-Notiz, keine
Messung.** Erster Arbeitsschritt vor jeder Zeile UI:
> Sonde gegen v0.16.18: Konto A legt Termin mit Teilnehmer B an; nach 10 s prüfen: `Email/query`
> in B, `queue.*` im Serverlog, `CalendarEvent/query` in B, `CalendarEventNotification/get` in B.

Schlägt sie fehl, schrumpft K-3 auf „Teilnehmer auf einem **freigegebenen** Kalender" und
setzt damit S-1/S-2 voraus.

### `CalendarEvent/participantReply` gibt es nicht (`unknownMethod`)
Eine Antwort an einen **externen** Organisator müsste der Client als iTIP-REPLY-Mail selbst
bauen und über `Email/set` + `EmailSubmission/set` versenden. Eigenes L, außerhalb dieses Plans.

### Capability-Verdrahtung
`capabilityForMethod()` schließt heute allein vom Präfix. `CalendarEvent/parse` braucht aber
`urn:ietf:params:jmap:calendars:parse`. Nötig ist eine **Methoden-Übersteuerung vor der
Präfix-Tabelle**:
```ts
const METHOD_TO_CAPABILITY = {
  'CalendarEvent/parse': Capabilities.calendarsParse,
  'ContactCard/parse':   Capabilities.contactsParse,
  'Principal/getAvailability': Capabilities.principalsAvailability,
}
```
Ehrlich: dass Stalwart die Methode *ohne* diese URN ablehnt, wurde **nicht gemessen** —
vermutlich nimmt er sie auch so. Der Entwurf verlangt es, es kostet nichts.

---

## UI-Entscheidungen (Leitbild: Apple)

### Termin-Editor = Navigationsstapel in *einem* Dialog
`EventDialog` bekommt `page: 'main' | 'repeat' | 'repeat-custom' | 'repeat-end' | 'alerts' | 'participants'`.
Titel wechselt mit, links ein Zurück-Pfeil statt „Abbrechen". **Keine verschachtelten Dialoge** —
eine Fokusfalle in einer Fokusfalle ist eine Fehlerquelle mit Ansage, und Apple macht es auch
nicht so. Fokus springt auf die Überschrift der neuen Seite; `Escape` geht eine Ebene zurück
(nur auf `main` schließt es). Auf dem Telefon eine bildschirmhohe Lasche, am Schreibtisch eine
mittige Tafel — **dieselbe Struktur**.

### Bereichswahl kommt *nach* „Sichern"
Apple fragt nicht vorher, sondern danach: Aktionslasche von unten mit **zwei** Antworten —
„Nur dieser Termin" / „Alle künftigen Termine" (auf dem **ersten** Vorkommen als „Alle Termine"
beschriftet), plus „Abbrechen". Kein dritter Knopf: „alle künftigen" ist auf dem ersten
Vorkommen dasselbe wie „alle", und ein dritter Knopf schafft nur die Frage nach dem Unterschied.
Beim Löschen dieselbe Lasche, beide Antworten destruktiv.

### „Alle künftigen" ist nicht transaktional — das gehört gesagt
JSCalendar kennt kein „Serie teilen". Es ist immer Abschneiden + Neuanlegen:
```
create { neu: {…Draft…, recurrenceRule: {…ab hier…}, uid: <neue uid>} }
update { <masterId>: { "recurrenceRule/until": <letztes Vorkommen davor> } }
```
Beides in **einem** `/set`, erst `create`, dann `update`. Landet das `update` in `notUpdated`,
das eben Erzeugte sofort zerstören und den Fehler melden. Ein Restfenster bleibt
(Verbindungsabbruch zwischen Antwort und Aufräumen) — **Preis des Formats, nicht des Entwurfs.**
Die neue Serie braucht eine **eigene `uid`** (`crypto.randomUUID()`, nur hier, mit Kommentar,
warum die allgemeine „keine uid senden"-Regel an dieser Stelle nicht gilt).

Ändert man im Bereich „Alle" Anfangszeit oder Dauer, ziehen einzeln verschobene Vorkommen
nicht mit. Apple löscht sie dann still. **Wir nicht** — die Lasche bekommt eine Hinweiszeile:
„Einzeln geänderte Termine dieser Serie behalten ihre Zeit."

### Kalenderliste (K-1)
Apple: eine Zeile ist **ein farbiger Punkt, ein Häkchen und der Name** — mehr nicht. Kein
Zahnrad je Zeile; Bearbeiten liegt hinter „Info" bzw. Kontextmenü.
- **Ab 40em:** Leiste links, Form wie `AddressBookList` / Ordnerbaum. Name auf eigener Zeile,
  Marker darunter (dieselbe Lehre wie bei den Adressbüchern, wo Namen von Badges abgeschnitten
  wurden). Kopf: ein `+`.
- **Unter 40em:** keine Leiste. Das vorhandene Ansichten-`Menu` bekommt „Kalender…" und öffnet
  einen bildschirmhohen Dialog — eins zu eins Apples Lasche.
- **Farbe:** acht benannte Farben aus den Design-Tokens, **kein** `<input type="color">` (das
  ist ein Betriebssystem-Dialog ohne Gestaltungshoheit und mit schlechter Tastaturbedienung).
  Jede Schaltfläche trägt den Farbnamen als Beschriftung, die gewählte ein Häkchen — Farbe ist
  nie alleiniger Informationsträger (WCAG 1.4.1). Ein Fremdwert vom Server wird als neunter,
  „eigener" Punkt gezeigt und nicht überschrieben.
- **Sichtbarkeit ist echter Serverzustand** (`isVisible`), kein lokaler Filter — wirkt damit
  auch in der Kalender-App des Telefons. Optimistisch umschalten, bei Ablehnung zurücknehmen.
- **Löschen** ist die eine Stelle mit **Rückfrage** (anders als beim Termin, wo bewusst Undo
  statt Rückfrage steht): ein gelöschter Kalender nimmt alle Termine mit, und die
  Wiederherstellung wäre eine Nachbildung, keine Rückgängigmachung. Dialog nennt Namen und
  Zahl der Termine; Standardkalender steht gar nicht zur Auswahl.

**Folgewirkung, die den Aufwand rechtfertigt:** `eventsInRange(from, to, calendarIds?)` hat den
Parameter seit jeher und **keinen Aufrufer**. K-1 füllt ihn — damit hört „ausblenden" auf, ein
Zeichentrick zu sein.

### Erinnerungen (K-5)
Apple: Zeile „Hinweis", Wert rechts in Sekundärfarbe. Feste Werte, keine Zahleneingabe.
„Zweiter Hinweis" erscheint erst, wenn der erste gesetzt ist.
Ganztägig in Apples Form: „Am Tag des Termins (9:00)" → `-PT9H`, „1 Tag vorher (9:00)" →
`-PT33H`, usw. Die Messung von `defaultAlertsWithoutTime` (`-PT9H`) bestätigt das Muster.
**Nicht modellierte Alarme** (`action:"email"`, `AbsoluteTrigger`) erscheinen als eigene,
nicht bearbeitbare Zeile („1 E-Mail-Erinnerung") und werden **unverändert mitgeführt** —
dieselbe Haltung, mit der `EventFacts` heute Ort und Teilnehmer schützt.

### Wiederholung (K-2)
Zeile „Wiederholen" mit Wert rechts („Nie / Jeden Tag / Jede Woche / Alle 2 Wochen / Jeden
Monat / Jedes Jahr / Eigene…"). „Ende der Wiederholung" erscheint **erst dann**. Das ist
Apples Reihenfolge und sie ist richtig: die Mehrheit wählt einen der fünf Vorschläge und sieht
die Detailebene nie.

### Teilnehmer (K-3)
Apple: Zeile „Teilnehmer", Wert rechts („Keine" / „3 Personen"); Unterseite mit Token-Feld
oben und Liste darunter. Je Person: Avatar, Name, rechts ein Statuszeichen (Häkchen /
Fragezeichen / x / nichts), Organisator mit Beisatz. Status **nie nur farbig** kodiert.
Vorschläge zuerst aus dem **Kontakt-Replikat** (offlinefähig, schon da), zusätzlich
`Principal/query` mit `filter:{text}` — **`text`, nicht `name`**; der `name`-Filter liefert
belegt leer.
Zu-/Absage: dreiteilige Leiste „Annehmen · Vielleicht · Ablehnen", aktuelle Antwort gefüllt,
`aria-pressed`. Erscheint **nur**, wenn ein Teilnehmer die eigene `calendarAddress` trägt
**und** `myRights.mayRSVP` wahr ist.

### Der Fall, für den sich K-4 wirklich lohnt
Eine `.ics` als **Mailanhang**: im Lesebereich zur Terminkarte machen (Titel, Zeitraum, Ort,
Teilnehmer) mit „Zum Kalender hinzufügen". Braucht **keinen** iCal-Parser im Client und
**kein** K-9. Es ist der einzige Weg, auf dem eine Einladung von außen heute in Waxwing
ankommt — und damit wertvoller als der Dateiimport.

---

## Was nicht baubar ist (ehrlich)
- **ICS-Export über JMAP** — gemessen unmöglich, nur eigener Serialisierer (verlustbehaftet).
- **Einladungs-Posteingang** — `CalendarEventNotification` war in jedem Szenario leer, Ursache
  offen (K-9). Ersatz: die `text/calendar`-Anhangskarte.
- **RSVP an einen externen Organisator** — `participantReply` existiert nicht.
- **K-3 ist ohne Kalenderfreigabe (S-1/S-2) oder funktionierendes iMIP nur ein
  Anzeige-Feature.** Das RSVP selbst ist belegt und baubar; das Einladen nicht.

## Ein ADR ist fällig
`packages/jmap/src/types/calendar.ts` sagt im Kopf ausdrücklich, das Format sei „final (RFC
8984)". Diese Aussage wird falsch. Nach den Projektregeln gehört das in einen ADR:
**„JSCalendar 2.0 (`jscalendarbis`) ist das Wire-Format, nicht RFC 8984"** — mit den drei
belegten Messungen und der Liste der betroffenen Eigenschaften.

## Dokumentenpflege (I-4)
FR-CAL-01 beschreibt den Kalender noch als „read-only" und nennt RFC 8984 als Format. Beides
wird mit K-6 und K-1 falsch; die Spezifikation gehört im selben Paket nachgezogen.
