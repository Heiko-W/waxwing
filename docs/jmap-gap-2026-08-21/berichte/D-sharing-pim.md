# D — Freigabe/Delegation, Kalender, Kontakte, Dateien: Server vs. Waxwing-Client

**Fixture:** Stalwart `v0.16.14-alpine`, `http://localhost:18080`
**JMAP-Endpunkt:** `POST http://localhost:18080/jmap/` — **nicht** `/jmap/api` (das liefert HTTP 404).
Die Session meldet `apiUrl: "http://localhost:18080/jmap/"`.
**Konten:** alice = accountId `b`, bob = `c`, carol = `d` (Principal-ids sind hier identisch mit den accountIds).
Alle Aufrufe unten als `carol@waxwing.test`, lesend zusätzlich als `alice@waxwing.test`.
Alle im Test angelegten Freigaben und Objekte wurden am Ende **zurückgenommen/gelöscht** (alice' Session enthält
wieder nur ihr eigenes Konto, die Probe-Gruppe ist entfernt).

---

## 1. Freigabe / Delegation

### 1.1 Server kann

**`shareWith` funktioniert auf allen vier Typen.** Belege (jeweils echter Aufruf als carol):

```jsonc
// Calendar/set {accountId:"d", update:{ b:{ shareWith:{ b:{ mayReadFreeBusy:true, mayReadItems:true,
//   mayWriteAll:true, mayWriteOwn:true, mayUpdatePrivate:true, mayRSVP:true, mayShare:false, mayDelete:false }}}}}
{"accountId":"d","oldState":"sae","newState":"sam","updated":{"b":null}}

// Mailbox/set  update.a.shareWith  -> {"updated":{"a":null}}
// AddressBook/set update.b.shareWith -> {"updated":{"b":null}}
// FileNode/set update.b.shareWith  -> {"updated":{"b":null}}
```

**Der Empfänger sieht das Konto sofort in seiner Session mit `isPersonal: false`:**

```
# GET /jmap/session als alice, NACH der Freigabe
b alice@waxwing.test isPersonal=true  isReadOnly=false
d carol@waxwing.test isPersonal=false isReadOnly=false   <-- Fremdkonto
```

Nach dem Zurücknehmen aller Freigaben verschwindet Konto `d` wieder aus alice' Session. Die
Sichtbarkeit ist also **konto-, nicht objektweise**: sobald *irgendein* Objekt freigegeben ist,
erscheint das ganze Fremdkonto mit dem vollen `accountCapabilities`-Satz (mail, contacts, calendars,
filenode, mail:share).

Alice kann die freigegebenen Objekte auch wirklich lesen:

```jsonc
// Mailbox/get {accountId:"d"} als alice -> nur die freigegebene Inbox, mit reduzierten Rechten
[{"id":"a","name":"Inbox","role":"inbox","myRights":{"mayReadItems":true,"mayAddItems":true,
  "mayRemoveItems":true,"maySetSeen":true,"maySetKeywords":true,"mayCreateChild":false,
  "mayRename":false,"maySubmit":false,"mayDelete":false,"mayShare":false}}]

// ContactCard/query {accountId:"d"} als alice -> {"ids":["b","c"]}
// Calendar/get {accountId:"d"} als alice   -> myRights gespiegelt, shareWith: null (nur der Eigentümer sieht es)
```

### 1.2 Rechte-Schlüssel — pro Typ ein **anderer, streng validierter** Satz

| Typ | akzeptierte Schlüssel |
|---|---|
| `Mailbox` | `mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen`, `maySetKeywords`, `mayCreateChild`, `mayRename`, `maySubmit`, `mayDelete`, `mayShare` |
| `Calendar` | `mayReadFreeBusy`, `mayReadItems`, `mayWriteAll`, `mayWriteOwn`, `mayUpdatePrivate`, `mayRSVP`, `mayShare`, `mayDelete` |
| `AddressBook` | `mayRead`, `mayWrite`, `mayDelete`, `mayShare` |
| `FileNode` | `mayRead`, `mayAddChildren`, `mayRename`, `mayDelete`, `mayModifyContent`, `mayShare` |

`mayAdmin` gibt es **nirgends**. Fremde Schlüssel werden hart abgelehnt (kein stilles Ignorieren):

```jsonc
// AddressBook/set update.b.shareWith.b = {mayReadItems:true, mayAdmin:true}
{"notUpdated":{"b":{"type":"invalidProperties",
  "description":"Invalid permission \"mayReadItems\".","properties":["shareWith"]}}}
```

Ein `Calendar` kann bereits **beim Anlegen** mit `shareWith` erzeugt werden; fehlende Schlüssel
werden mit `false` aufgefüllt.

### 1.3 `ShareNotification` — funktioniert vollständig, echt

Baseline vor dem Test: `ShareNotification/get {accountId:"b"}` als alice → `list: []`.
Nach den vier Freigaben:

```jsonc
{"accountId":"b","state":"sqc7idsf0wlgmcba","list":[{
  "id":"jazrspmqawqa","name":"",
  "changedBy":{"principalId":"d","name":"Carol Chen (Waxwing e2e)","email":"carol@waxwing.test"},
  "created":"2026-08-21T15:51:08Z",
  "objectAccountId":"d","objectId":"b","objectType":"Calendar",
  "oldRights":{"mayReadFreeBusy":false, ...alles false...},
  "newRights":{"mayReadFreeBusy":true,"mayReadItems":true,"mayWriteAll":true,"mayWriteOwn":true,
               "mayUpdatePrivate":true,"mayRSVP":true,"mayShare":false,"mayDelete":false}}]}
```

Es kam **je eine Benachrichtigung pro Typ** an — `Calendar`, `Mailbox`, `AddressBook`, `FileNode`.
Ebenfalls belegt:

- `ShareNotification/changes {sinceState:"n"}` → `created: [5 ids], hasMoreChanges:false` ✔
- `ShareNotification/query {filter:{}}` → 5 ids ✔
- `ShareNotification/set {destroy:[id]}` → `{"destroyed":["jazsiuiac1aa"]}` ✔ (Wegklicken geht)

### 1.4 `Principal/get` und `Principal/query` — echtes Org-Verzeichnis

```jsonc
// Principal/get {accountId:"d", ids:null} als carol — OHNE jede Freigabe
{"list":[
 {"id":"b","type":"individual","name":"alice@waxwing.test","description":"Alice Anderson (Waxwing e2e)","email":"alice@waxwing.test"},
 {"id":"c","type":"individual","name":"bob@waxwing.test","description":"Bob Baker (Waxwing e2e)","email":"bob@waxwing.test"},
 {"id":"d","type":"individual","name":"carol@waxwing.test","description":"Carol Chen (Waxwing e2e)","email":"carol@waxwing.test"}]}
```

Jeder Benutzer sieht also **alle** Benutzer der Organisation — das ist ein vollwertiges
Unternehmens-Adressbuch, ganz ohne vorherige Freigabe.

Vollständige Properties (explizit angefragt):

```jsonc
{"id":"b","type":"individual","name":"alice@waxwing.test","description":"Alice Anderson (Waxwing e2e)",
 "email":"alice@waxwing.test","timezone":null,          // <-- KLEIN geschrieben: "timezone", nicht "timeZone"
 "capabilities":{"urn:ietf:params:jmap:mail":{}, ...contacts, calendars, filenode, principals},
 "accounts":{"b":{ ...,
   "urn:ietf:params:jmap:calendars":{"accountId":"b","mayGetAvailability":true,"mayShareWith":true,
                                     "calendarAddress":"mailto:alice@waxwing.test"},
   "urn:ietf:params:jmap:principals:owner":{"accountIdForPrincipal":"b","principalId":"b"}}}}
```

`accounts[…].calendars.mayShareWith` und `.mayGetAvailability` sind die Flags, an denen ein Client
erkennen darf, ob er einen Principal überhaupt als Freigabeziel/Teilnehmer anbieten soll.
Unbekannte Properties werden **still weggelassen** (`properties:["id","bogusProp"]` → `{"id":"b"}`).

`Principal/query`-Filter:

| Filter | Ergebnis |
|---|---|
| `{}` | `["b","c","d"]` |
| `{text:"Baker"}` | `["c"]` ✔ (sucht auch in `description`) |
| `{email:"bob@waxwing.test"}` | `["c"]` ✔ |
| `{type:"individual"}` | `["b","c","d"]` ✔ |
| `{type:"group"}` | `[]` (bzw. die Gruppe, s.u.) ✔ |
| `{name:"alice"}` | `[]` — **exakter Match**, `name` ist die volle Login-Adresse |
| `{bogusFilter:"x"}` | `{"type":"unsupportedFilter","description":"bogusFilter"}` |

- `Principal/changes {sinceState:"n"}` → `{"type":"cannotCalculateChanges"}` (trotz `canCalculateChanges:true` in der Query-Antwort).
- **`Principal/set` existiert nicht** — und zwar auf Request-Ebene: Stalwart lehnt die *gesamte*
  Anfrage mit HTTP 400 `urn:ietf:params:jmap:error:notRequest` ab, statt nur diesen einen
  Methodenaufruf als `unknownMethod` zu markieren. Für einen Client, der Methoden batcht, heißt das:
  ein einziger unbekannter Methodenname reißt den ganzen Batch mit.

**Gruppen-Principals:** über die Verwaltungs-API (`x:Account/set`, `using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"]`)
lässt sich ein `{"@type":"Group","name":"teamd","domainId":"b"}` anlegen. Der taucht danach für carol
als normaler Principal auf und ist ein gültiges Freigabeziel:

```jsonc
// Principal/get {ids:["e"]} als carol
{"id":"e","type":"group","name":"teamd@waxwing.test","email":"teamd@waxwing.test","description":"Probe D"}
// Calendar/set update.c["shareWith/e"] = {mayReadFreeBusy:true, mayReadItems:true} -> {"updated":{"c":null}}
```

### 1.5 `Principal/getAvailability` — funktioniert, echte Frei/Belegt-Auskunft

Ohne Termine: `{"list":[]}`. Nach Anlegen eines Termins (25.08. 10–12 Uhr Europe/Berlin):

```jsonc
// Principal/getAvailability {accountId:"d", id:"d", utcStart:"2026-08-20T00:00:00Z", utcEnd:"2026-08-30T00:00:00Z"}
{"list":[{"utcStart":"2026-08-25T08:00:00Z","utcEnd":"2026-08-25T10:00:00Z",
          "busyStatus":"confirmed","event":null}]}
```

Kontoübergreifend erlaubt (Abfrage auf `id:"b"`/alice lieferte `[]`, **ohne** Fehler — alice hatte
schlicht keine Termine; ihre `CalendarEvent/query` bestätigt `ids: []`). Mit Details:

```jsonc
// … showDetails:true, eventProperties:["id"]
{"list":[{...,"event":{"id":"iaaaaab","baseEventId":"b"}}]}
// eventProperties:["title","start","duration"] ->
{"type":"invalidArguments","description":"Only 'id' and 'baseEventId' properties are supported in results"}
```

`maxAvailabilityDuration: P52W1D` wird **nicht erzwungen**: eine Abfrage über 10 Jahre lieferte
anstandslos ein Ergebnis statt eines Fehlers.

### 1.6 Client nutzt

- **Einzige vollständige Freigabe-Implementierung im ganzen Client: Dateien.**
  `FileNode.shareWith` wird gelesen, geschrieben und hat eine echte UI —
  `/home/heiko/repositories/waxwing/apps/web/src/files/files-client.ts:251-256` (Schreiben),
  `/home/heiko/repositories/waxwing/apps/web/src/files/sharing.ts:19-129` (Rollenmodell viewer/editor/manager),
  `/home/heiko/repositories/waxwing/apps/web/src/files/ShareDialog.tsx:58-59,119,163,182,254`.
- `Principal/get` und `Principal/query` werden **ausschließlich** vom Datei-Share-Picker benutzt:
  `/home/heiko/repositories/waxwing/apps/web/src/files/files-client.ts:237-248`.
  Der Filter ist korrekt `text` (nicht `name`): `/home/heiko/repositories/waxwing/packages/jmap/src/types/principal.ts:98-101`.
- `AddressBook.shareWith`: **nur gelesen**, zeigt ein „Shared"-Badge —
  `/home/heiko/repositories/waxwing/apps/web/src/contacts/AddressBookList.tsx:72-75,109`.
  Der Schreibpfad kennt nur `name`/`description`:
  `/home/heiko/repositories/waxwing/apps/web/src/sync/engine/contact-mutations.ts:31-39`.
- `Mailbox.shareWith`: **fehlt komplett im Typ** — `/home/heiko/repositories/waxwing/packages/jmap/src/types/mail.ts:104-127`
  (nur `myRights`). Auch die URN `urn:ietf:params:jmap:mail:share` steht in keiner Capability-Tabelle
  (`/home/heiko/repositories/waxwing/packages/jmap/src/capabilities.ts:48-68`) und wird nie gesendet.
- `Calendar.shareWith`: **fehlt komplett im Typ** — `/home/heiko/repositories/waxwing/packages/jmap/src/types/calendar.ts:58-68`.
- `ShareNotification/*`: Typen vorhanden (`/home/heiko/repositories/waxwing/packages/jmap/src/types/principal.ts:107-130`),
  zwei Methoden registriert (`/home/heiko/repositories/waxwing/packages/jmap/src/methods.ts:262-267`),
  **null Aufrufer** in `apps/web/`.
- `Principal/getAvailability`: **nicht vorhanden**, weder Typ noch Methode (nur in `docs/implementation-plan.md:747` erwähnt).
- Fremdkonten: der Client filtert **nicht** auf `isPersonal`, sondern darauf, ob ein Konto
  `urn:ietf:params:jmap:mail` in seinen `accountCapabilities` führt —
  `/home/heiko/repositories/waxwing/packages/jmap/src/session.ts:239-252`. Ergebnis: delegierte Konten
  sind **nur im Mail-Bereich** sichtbar (`/home/heiko/repositories/waxwing/apps/web/src/mail/AccountTrees.tsx:39-70`).
  Kalender, Kontakte und Dateien sind hart auf `connected.accountId` verdrahtet —
  `/home/heiko/repositories/waxwing/apps/web/src/calendar/CalendarPage.tsx:152,158`,
  `/home/heiko/repositories/waxwing/apps/web/src/files/FilesPage.tsx:146,153`.
- In `apps/web/src/settings/` gibt es **keine** Freigabe-/Delegations-UI; nur eine Diagnosezeile
  `principals` in `/home/heiko/repositories/waxwing/apps/web/src/settings/capabilities-model.ts:68`.

### 1.7 Lücke

Stalwart trägt Delegation vollständig — Freigabe, Rechte, Fremdkonto-Sichtbarkeit, Benachrichtigung —
und Waxwing nutzt davon nur die Dateifreigabe, sodass ein Nutzer weder einen Kalender noch ein
Adressbuch noch einen Mailordner an eine Kollegin freigeben kann und, schlimmer, von einer eingehenden
Freigabe **überhaupt nichts mitbekommt** (`ShareNotification` liegt brach) und einen fremden Kalender
oder ein fremdes Adressbuch selbst dann nicht öffnen kann, wenn er freigegeben ist.
Dass jeder Benutzer per `Principal/get` das komplette Firmenverzeichnis abrufen kann, wird ebenfalls
nur im Datei-Dialog genutzt statt als globale Personensuche.

---

## 2. Kalender

### 2.1 `Calendar` — Server kann

`Calendar/get` **ohne** `properties` liefert:
`id, name, description, color, timeZone, sortOrder, isDefault, isSubscribed, myRights`.
Zusätzlich, nur auf explizite Anfrage: `isVisible`, `shareWith`, `defaultAlertsWithTime`,
`defaultAlertsWithoutTime`, `includeInAvailability`.

`Calendar/set create` mit dem vollen Satz funktioniert:

```jsonc
// Anlage mit name/color/sortOrder/isVisible/isSubscribed/timeZone/description/
// includeInAvailability/defaultAlertsWithTime/defaultAlertsWithoutTime/shareWith -> created {"cal2":{"id":"c"}}
// Rücklesen:
{"id":"c","name":"Projekt","color":"#ff8800","sortOrder":3,"isVisible":true,"isSubscribed":true,
 "timeZone":"Europe/Berlin","description":"Testkalender","includeInAvailability":"attending",
 "defaultAlertsWithTime":{"a1":{"@type":"Alert","action":"display",
    "trigger":{"@type":"OffsetTrigger","offset":"-PT10M","relativeTo":"start"}}},
 "defaultAlertsWithoutTime":{"a2":{...offset:"-PT9H"...}},
 "shareWith":{"b":{"mayReadFreeBusy":true,"mayReadItems":true,"mayWriteAll":false, ...}}}
```

**`participantIdentities` gibt es nicht** — der Aufruf scheitert hart:

```jsonc
{"notCreated":{"cal2":{"type":"invalidProperties","description":"Invalid property.",
                       "properties":["participantIdentities"]}}}
```

Stattdessen existiert eine eigene Methode:

```jsonc
// ParticipantIdentity/get {accountId:"d", ids:null}
{"list":[{"id":"a","name":"Carol Chen (Waxwing e2e)","calendarAddress":"mailto:carol@waxwing.test","isDefault":true}]}
```

### 2.2 Teilnehmer — Server kann, aber mit anderem Feldnamen als erwartet

**Wichtigster Befund des Kalenderteils:** Stalwart folgt dem *neueren* JSCalendar-Entwurf und benutzt
`calendarAddress` statt `sendTo`. Ein Participant mit `sendTo: {imip: "mailto:…"}` wird **still
verworfen** — `CalendarEvent/set` meldet Erfolg, das Event hat danach schlicht keine `participants`:

```jsonc
// create mit participants[…].sendTo.imip -> {"created":{"inv":{"id":"c"}}}
// CalendarEvent/get properties:["id","participants",...] -> {"id":"c"}   // participants fehlt
```

Mit `calendarAddress` klappt es:

```jsonc
// create {..., organizerCalendarAddress:"mailto:carol@waxwing.test",
//   participants:{ pc:{...,calendarAddress:"mailto:carol@waxwing.test",roles:{owner:true,attendee:true},
//                       participationStatus:"accepted"},
//                  pa:{...,calendarAddress:"mailto:alice@waxwing.test",roles:{attendee:true,required:true},
//                       participationStatus:"needs-action",expectReply:true}}}
{"participants":{
  "pc":{"calendarAddress":"mailto:carol@waxwing.test","@type":"Participant","participationStatus":"accepted",
        "expectReply":false,"name":"Carol Chen","roles":{"owner":true,"attendee":true},"kind":"individual"},
  "pa":{"calendarAddress":"mailto:alice@waxwing.test","@type":"Participant",
        "roles":{"required":true,"attendee":true},"expectReply":true,"participationStatus":"needs-action"},
  "f29d7028-…":{"calendarAddress":"mailto:carol@waxwing.test","@type":"Participant","name":"Carol Chen"}}}
```

(Der dritte Eintrag wird vom Server als Organisator selbst ergänzt.)

`scheduleAgent` und `scheduleForceSend` werden akzeptiert und gespeichert. `method` ist **immutable**
(`{"type":"invalidProperties","description":"This property is immutable.","properties":["method"]}`).
Ein `scheduleStatus`-Feld wurde nie zurückgeliefert.

### 2.3 iMIP-Einladungen — **verschickt Stalwart NICHT**

Zwei Durchläufe, jeweils Teilnehmer `alice@waxwing.test`:

1. `CalendarEvent/set create` mit `participants` + `organizerCalendarAddress`.
2. Derselbe Aufruf zusätzlich mit `sendSchedulingMessages: true`, `scheduleAgent: "server"` und
   `scheduleForceSend: "request"` an beiden Teilnehmern.

Ergebnis nach jeweils 4–6 s Wartezeit:

- `Email/query {accountId:"b"}` als alice → **0 Mails** (Baseline war ebenfalls 0).
- `CalendarEvent/query {accountId:"b"}` als alice → `[]` (kein automatisch angelegter Termin).
- `CalendarEventNotification/get {accountId:"b"}` als alice → `{"state":"saa","list":[]}`
  (die Methode **existiert**, liefert aber nichts).
- Server-Log `/var/log/stalwart/stalwart.log.2026-08-21`: **kein einziger** `queue.*`-Eintrag zu den
  Terminen. Zum Vergleich lag zeitgleich ein fremder, erfolgreicher Mailversand im Log
  (`queue.authenticated-message-queued … from = "bob@waxwing.test"` → `delivery.completed`), die
  Zustellkette funktioniert also grundsätzlich.

**Fazit: Stalwart v0.16.14 speichert Teilnehmer, verschickt aber keine iTIP/iMIP-Nachricht** — weder
per Mail noch als interne Terminzustellung. Ob das eine Konfigurationssache ist, ließ sich nicht
klären (s. „Unsicherheiten").

### 2.4 RSVP — geht per JMAP, wenn man Zugriff hat

Ein Eingeladener mit `mayRSVP` auf dem freigegebenen Kalender kann per Patch zusagen:

```jsonc
// als ALICE: CalendarEvent/set {accountId:"d", update:{ e:{ "participants/pa/participationStatus":"accepted" }}}
{"updated":{"e":null}}
// carol liest zurück: participants.pa.participationStatus == "accepted"   ✔
```

Das ist aber nur der Weg über eine **Kalenderfreigabe**. Ohne iMIP und ohne freigegebenen Kalender
bekommt ein Eingeladener den Termin gar nicht erst zu sehen.

### 2.5 `CalendarEvent/parse` — funktioniert vollständig

`.ics` per `uploadUrl` hochgeladen, dann `CalendarEvent/parse {blobIds:[…]}`. Aus einer echten
VCALENDAR mit RRULE, zwei ATTENDEEs, VALARM, LOCATION und einem RECURRENCE-ID-Override kam zurück:

```jsonc
{"parsed":{"ebdo…":[{
  "@type":"Event","uid":"waxwing-probe-1@waxwing.test","title":"ICS Import Probe",
  "start":"2026-09-10T09:00:00","timeZone":"Europe/Berlin","duration":"PT1H",
  "description":"Serientermin mit Teilnehmern","method":"request",
  "recurrenceRule":{"frequency":"weekly","count":4},                    // <-- SINGULAR
  "recurrenceOverrides":{"2026-09-17T09:00:00":{"title":"ICS Import Probe (verschoben)",
                                                "start":"2026-09-17T11:00:00","duration":"PT1H"}},
  "locations":{"587e4ee5-…":{"name":"Verl","@type":"Location"}},
  "alerts":{"k1":{"@type":"Alert","action":"display",
                  "trigger":{"@type":"OffsetTrigger","offset":"-PT15M"}}},
  "organizerCalendarAddress":"mailto:carol@waxwing.test",
  "participants":{"db1a…":{"calendarAddress":"mailto:alice@waxwing.test","expectReply":true,
                           "participationStatus":"needs-action","roles":{"required":true},"name":"Alice Anderson"},
                  "599d…":{"calendarAddress":"mailto:bob@waxwing.test","participationStatus":"accepted",
                           "roles":{"optional":true},"name":"Bob Baker"}},
  "iCalendar":{"convertedProperties":{"duration":{"name":"dtend"}},"name":"vevent"}}]}}
```

Nicht abbildbare Original-Properties werden unter `iCalendar` mitgeführt — verlustfreier Round-Trip.

### 2.6 ICS-Export — über JMAP **nicht** möglich, über CalDAV schon

- `CalendarEvent/get` mit `properties: ["iCalendar" | "blobId" | "iCalendarBlobId" | "ical"]`
  → jeweils nur `{"id":"e"}`, die Property wird still verworfen.
- `CalendarEvent/export` → `{"type":"unknownMethod"}`.
- Es gibt **keinen** Blob und damit keine `downloadUrl` für einen Termin.
- Derselbe Server bietet den Export aber über **CalDAV** an:

```
GET /dav/cal/carol%40waxwing.test/default/gWT5LSE8ze   (HTTP 200)
BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20260903T140000
SUMMARY:Waxwing iMIP Test 2
DURATION:PT1H
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OWNER;RSVP=FALSE;PARTSTAT=ACCEPTED;CN="Carol Chen";JSID=pc:mailto:carol@waxwing.test
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;CN="Alice Anderson";JSID=pa:mailto:alice@waxwing.test
ORGANIZER;CN="Carol Chen":mailto:carol@waxwing.test
END:VEVENT
END:VCALENDAR
```

Ein reiner JMAP-Client muss ICS also selbst serialisieren.

### 2.7 Serientermine — Server kann, aber **`recurrenceRule` ist Singular**

```jsonc
// create mit recurrenceRules: [ … ]  (Plural, wie im JMAP-Calendars-Draft)
{"notCreated":{"ser":{"type":"invalidProperties","description":"Invalid property.",
                      "properties":["recurrenceRules"]}}}

// create mit recurrenceRule: { "@type":"RecurrenceRule","frequency":"weekly","count":4 }
//   + recurrenceOverrides: { "2026-09-14T09:00:00":{title:…, start:"2026-09-14T11:00:00"},
//                            "2026-09-21T09:00:00":{excluded:true} }
{"created":{"ser":{"id":"f"}}}
```

`expandRecurrences: true` in `CalendarEvent/query` expandiert korrekt inklusive Overrides:

```jsonc
// Instanzen des Serientermins f (4 Wiederholungen, eine verschoben, eine ausgeschlossen):
{"start":"2026-09-07T09:00:00","title":"Wochenmeeting",             "recurrenceId":"2026-09-07T09:00:00","id":"iaaaaaf","baseEventId":"f"}
{"start":"2026-09-14T11:00:00","title":"Wochenmeeting (verschoben)","recurrenceId":"2026-09-14T11:00:00","id":"eaaaaaf","baseEventId":"f"}
{"start":"2026-09-28T09:00:00","title":"Wochenmeeting",             "recurrenceId":"2026-09-28T09:00:00","id":"maaaaaf","baseEventId":"f"}
// der 21.09. fehlt korrekt (excluded)
```

Kleine Eigenheit: nach dem Anlegen enthält `recurrenceOverrides` beim Rücklesen nur noch den
`excluded`-Eintrag; der verschobene Termin ist als eigenständige Instanz materialisiert.

### 2.8 Client nutzt

- `Calendar`: gelesen werden nur `id`, `name`, `isDefault` — `/home/heiko/repositories/waxwing/apps/web/src/calendar/EventDialog.tsx:96-97,218-222`.
  `color`, `sortOrder`, `isSubscribed`, `timeZone`, `description`, `myRights` sind im Typ, aber ungenutzt.
  `isVisible`, `participantIdentities`, `defaultAlerts*`, `shareWith` fehlen im Typ ganz
  (`/home/heiko/repositories/waxwing/packages/jmap/src/types/calendar.ts:58-68`).
- **`Calendar/set` ist registriert (`/home/heiko/repositories/waxwing/packages/jmap/src/methods.ts:231`),
  wird aber nie aufgerufen** — kein Anlegen, Umbenennen, Einfärben, Ein-/Ausblenden von Kalendern.
- Teilnehmer werden **nur angezeigt**, nie geschrieben:
  `/home/heiko/repositories/waxwing/apps/web/src/calendar/EventFacts.tsx:38-42,61-66`;
  der Schreibpatch lässt `participants` bewusst weg —
  `/home/heiko/repositories/waxwing/apps/web/src/calendar/calendar-client.ts:181-203`.
  Keine RSVP-Buttons, Begründung im Code: `EventFacts.tsx:9-14`.
  `myRights.mayRSVP` ist typisiert (`types/calendar.ts:50`), aber ungenutzt.
  `scheduleStatus`/`scheduleAgent`/`replyTo`/`organizer`: kein Treffer im Repo.
- `CalendarEvent/parse`, ICS-Import, ICS-Export: **gar nicht vorhanden**.
- `expandRecurrences: true` wird benutzt und trägt die Wochenansicht —
  `/home/heiko/repositories/waxwing/apps/web/src/calendar/calendar-client.ts:388-392`.
  `recurrenceRules` (Plural!) und `recurrenceId` werden **nur gelesen** (`calendar-client.ts:226,231,157-159`);
  `recurrenceOverrides` ist typisiert, aber ungenutzt (`types/calendar.ts:154`), und Serien sind
  bewusst schreibgeschützt (`calendar-client.ts:174-178`).
  **Achtung:** der Client fragt `recurrenceRules` (Plural) an — Stalwart liefert `recurrenceRule`
  (Singular). Die Serien-Erkennung über `recurrenceRules` läuft damit gegen diesen Server ins Leere;
  dass Serien trotzdem erkannt werden, liegt an `recurrenceId` aus der expandierten Query.
- `alerts` sind typisiert, werden aber gar nicht erst angefragt (`calendar-client.ts:215-228`).
- `CalendarEventNotification`: **kein Treffer im Repo**.

### 2.9 Lücke

Der Kalender ist ein Anzeige-Kalender: man kann keinen Kalender anlegen oder verwalten, niemanden zu
einem Termin einladen, auf keine Einladung antworten, keine .ics importieren oder exportieren und
keine Serie bearbeiten — und weil Stalwart Einladungen ohnehin nicht per Mail verschickt, wäre
Terminplanung im Team derzeit auch serverseitig nur über eine Kalenderfreigabe möglich.
Dazu kommen zwei stille Feldnamen-Fehlpaarungen (`participants[].sendTo` statt `calendarAddress`,
`recurrenceRules` statt `recurrenceRule`), die ohne Fehlermeldung ins Leere laufen.

---

## 3. Kontakte

### 3.1 `ContactCard/parse` — Server kann, vollständig

`.vcf` (vCard 4.0) per `uploadUrl` hochgeladen, dann `ContactCard/parse {blobIds:[…]}`:

```jsonc
{"parsed":{"eary…":{
  "@type":"Card","version":"1.0","uid":"waxwing-vcard-probe-1",
  "name":{"full":"Dora Doe","components":[{"kind":"surname","value":"Doe"},
          {"kind":"given","value":"Dora"},{"kind":"title","value":"Dr."}]},
  "organizations":{"k1":{"name":"Beckhoff Automation GmbH & Co. KG","units":[{"name":"Produktmanagement"}]}},
  "titles":{"k1":{"name":"Produktmanagerin","kind":"title"}},
  "emails":{"k1":{"address":"dora@example.test","contexts":{"work":true},"pref":1}},
  "phones":{"k1":{"number":"+49 170 1234567","features":{"mobile":true}}},
  "addresses":{"k1":{"contexts":{"work":true},"components":[{"kind":"name","value":"Huelshorstweg 20"},
                     {"kind":"locality","value":"Verl"},{"kind":"postcode","value":"33415"},
                     {"kind":"country","value":"Germany"}]}},
  "anniversaries":{"k1":{"kind":"birth","date":{"@type":"PartialDate","year":1982,"month":3,"day":14}}},
  "keywords":{"Arbeit":true,"Test":true},
  "notes":{"k1":{"note":"Aus vCard importiert"}},
  "links":{"k1":{"uri":"https://example.test/dora"}},
  "vCard":{"properties":[["version",{},"unknown","4.0"]]}}}}
```

### 3.2 vCard-Export

Wie beim Kalender: über JMAP kein Export-Weg, über **CardDAV** (`/dav/card/…`) schon — der
`PROPFIND` auf `/dav/cal/carol@waxwing.test/` listet parallel `/dav/pal/carol@waxwing.test/`,
der DAV-Stack ist also aktiv.

### 3.3 Fotos — **`blobId` in `media` wird abgelehnt**

Das ist der handfesteste Client/Server-Konflikt im Kontaktbereich:

```jsonc
// ContactCard/set create {..., media:{k1:{"@type":"Media",kind:"photo",blobId:"ec12…",mediaType:"image/png"}}}
{"notCreated":{"cph":{"type":"invalidProperties",
                      "description":"blobIds in media is not supported.","properties":["media"]}}}

// dasselbe als update -> identischer Fehler

// mit uri (data:-URI) statt blobId:
{"created":{"cph2":{"id":"d"}}}
// Rücklesen:
{"media":{"k1":{"uri":"data:image/png;base64,iVBORw0KGgo=","kind":"photo",
                "mediaType":"image/png","@type":"Media"}}}
```

Stalwart v0.16.14 speichert Kontaktfotos also **ausschließlich inline als `data:`-URI**, nicht als Blob.

Der Blob-Weg selbst funktioniert unabhängig davon: `uploadUrl` liefert eine `blobId`,
`Blob/get {properties:["data:asBase64","size"]}` gibt die Bytes zurück, und `Blob/upload` (RFC 9404)
ist ebenfalls implementiert:

```jsonc
// Blob/upload {accountId:"d", create:{b1:{data:[{"data:asText":"Hallo Blob"}], type:"text/plain"}}}
{"created":{"b1":{"id":"edsi…","type":"text/plain","size":10}}}
```

### 3.4 `ContactCard/copy` — existiert, nur kontoübergreifend

```jsonc
// fromAccountId:"d", accountId:"d"  -> {"type":"invalidArguments","description":"From accountId is equal to fromAccountId"}
// fromAccountId:"b", accountId:"d"  -> {"type":"forbidden","description":"You do not have access to account b"}
```

Innerhalb eines Kontos ist Kopieren also nicht per `/copy` vorgesehen (dafür `ContactCard/set create`).
Ein erfolgreicher kontoübergreifender Kopiervorgang ließ sich nicht durchführen (s. „Unsicherheiten").

### 3.5 Kontaktgruppen — funktionieren, mit einem Fallstrick

```jsonc
// ContactCard/set create { c1:{…Karte…}, g1:{ kind:"group", name:{full:"Testgruppe"}, members:{"#c1":true} } }
{"created":{"g1":{"id":"c"},"c1":{"id":"b"}}}
// Rücklesen der Gruppe:
{"name":{"full":"Testgruppe"},"members":{"#c1":true},"kind":"group","id":"c","addressBookIds":{"b":true}}
```

**Die Creation-Reference `#c1` wird in `members` NICHT aufgelöst** — der Literalstring `#c1` bleibt
stehen statt der neuen id `b`. Wer eine Gruppe zusammen mit ihren Mitgliedern in einem Aufruf anlegt,
bekommt eine kaputte Gruppe; die Mitglieder müssen in einem zweiten `/set` nachgetragen werden.

`AddressBook/set create` mit `name`, `description`, `sortOrder`, `isSubscribed` funktioniert.

### 3.6 Client nutzt

- vCard-Import **und** -Export existieren, laufen aber **rein clientseitig** über `@waxwing/jscontact` —
  `/home/heiko/repositories/waxwing/apps/web/src/contacts/contact-io.ts:32,74-90,270-300`,
  UI `/home/heiko/repositories/waxwing/apps/web/src/contacts/ContactImportExportDialog.tsx:82,107-108,203,263`.
  `ContactCard/parse` wird **nicht** benutzt (weder Typ noch Methode).
- Fotos: der Client schreibt `media[key].blobId` —
  `/home/heiko/repositories/waxwing/apps/web/src/contacts/contact-card-mapping.ts:642,656-658`,
  Upload über `uploadUrl` in `/home/heiko/repositories/waxwing/apps/web/src/contacts/contact-photo-upload.ts:14-27`,
  Anzeige über Blob-Download in `/home/heiko/repositories/waxwing/apps/web/src/contacts/use-contact-photo.ts:26,41`.
  **Das kann gegen diesen Server nicht funktionieren** (§3.3). Abgedeckt ist der Pfad nur durch
  Unit-Tests mit Fakes (`ContactForm.test.tsx:346-365`, `types/contacts.test.ts:66,126,222`), nicht
  durch einen Integrationstest gegen einen echten Stalwart.
- `ContactCard/copy`: **nicht vorhanden** (`/home/heiko/repositories/waxwing/packages/jmap/src/methods.ts:277-288`).
- Kontaktgruppen (`kind:"group"`, `members`): **vollständig umgesetzt** —
  `/home/heiko/repositories/waxwing/apps/web/src/contacts/contact-group-mapping.ts:38-44,84-91,108`,
  UI `GroupForm.tsx`/`GroupRail.tsx`/`GroupView.tsx`,
  Expansion im Empfängerfeld `/home/heiko/repositories/waxwing/apps/web/src/contacts/expand-group.ts`.
- `AddressBook/set` schreibt nur `name` + `description`
  (`/home/heiko/repositories/waxwing/apps/web/src/sync/engine/contact-mutations.ts:31-39`);
  `sortOrder`, `isSubscribed`, `shareWith` bleiben ungenutzt. Der Anlege-Pfad hat zudem keinen UI-Aufrufer.

### 3.7 Lücke

Der spürbarste Punkt ist das Kontaktfoto: der Client lädt es als Blob hoch und schreibt eine `blobId`,
die Stalwart mit `invalidProperties` zurückweist — das Foto lässt sich schlicht nicht speichern.
Darüber hinaus fehlt serverseitiges vCard-Parsen (der Client parst selbst, was bei exotischen vCards
abweichen kann), es gibt kein Kopieren von Kontakten zwischen Adressbüchern, und Adressbücher lassen
sich weder sortieren noch freigeben.

---

## 4. Dateien (FileNode)

### 4.1 Upload / Download — Server kann beides

- **Upload klassisch:** `POST /jmap/upload/d/` mit `Content-Type` → `{"accountId":"d","blobId":"ectj…","type":"text/plain","size":58}` (HTTP 200).
- **`Blob/upload` (RFC 9404)** ist ebenfalls implementiert, siehe §3.3.
- Dann `FileNode/set create` mit `blobId`:

```jsonc
// create { dir:{name:"Freigabe-Test",parentId:null}, f1:{name:"notiz.txt",parentId:"#dir",blobId,type:"text/plain"} }
{"created":{"f1":{"id":"c"},"dir":{"id":"b"}}}     // Creation-Reference "#dir" WIRD hier korrekt aufgelöst
```

- **Download:** `GET /jmap/download/d/<blobId>/notiz.txt` → HTTP 200 mit dem Inhalt.
  Der Blob des FileNode hat eine **andere** id als der Upload-Blob (`ectj…` → `cctj…`).

### 4.2 Vollständige `FileNode`-Struktur (`FileNode/get` **ohne** `properties`)

```jsonc
{"id":"c","parentId":"b","nodeType":"file",
 "blobId":"cctj7bt0rzlyu9m1yetb3axbvycchykypbryddcbsj3wmhtmlqbdyaymai",
 "target":null,"size":58,"name":"notiz.txt","type":"text/plain",
 "created":"2026-08-21T15:51:52Z","modified":"2026-08-21T15:51:52Z",
 "accessed":"2026-08-21T15:51:52Z","changed":"2026-08-21T15:51:52Z",
 "executable":false,"isSubscribed":true,
 "myRights":{"mayRead":true,"mayAddChildren":true,"mayRename":true,
             "mayDelete":true,"mayModifyContent":true,"mayShare":true},
 "shareWith":{},"role":null}
```

Ein Ordner sieht identisch aus mit `nodeType:"directory"`, `blobId:null`, `size:null`, `executable:null`.
`target` deutet auf Symlink-Unterstützung hin (nicht geprüft).

### 4.3 Verschieben, Kopieren, Freigeben, öffentliche Links

- **Verschieben:** `FileNode/set update {c:{parentId:null}}` → `{"updated":{"c":null}}` ✔ funktioniert.
- **`FileNode/copy`:** existiert, aber nur kontoübergreifend —
  `fromAccountId == accountId` → `{"type":"invalidArguments","description":"From accountId is equal to fromAccountId"}`.
  Innerhalb eines Kontos kopiert man über `FileNode/set create` mit derselben `blobId`.
- **`shareWith`:** funktioniert (§1.1). **Die Freigabe eines Ordners vererbt den Lesezugriff auf den
  Inhalt** — alice konnte `notiz.txt` im freigegebenen Ordner per `downloadUrl` mit HTTP 200 laden,
  ohne dass die Datei selbst freigegeben war. Nach dem Verschieben derselben Datei aus dem Ordner
  heraus: HTTP 404. **Aber `myRights` bildet diese Vererbung nicht ab** — auf dem Kindknoten meldete
  Stalwart für alice `{"mayRead":false, …alles false}`, obwohl der Download funktionierte. Ein Client,
  der Aktionen an `myRights` festmacht, blendet hier fälschlich alles aus.
- **Öffentliche/anonyme Links: gibt es nicht.**
  - Anonymer Download → HTTP 401 `"You have to authenticate first."`
  - `shareWith` akzeptiert nur echte Principal-ids; Sonderwerte werden abgelehnt:
    `anyone` → `"Account id nyone is invalid."`, `*` → `"Invalid account id."`, ebenso
    `anonymous`, `authenticated`, `public`.
  - Die `filenode`-Capability meldet `webTrashUrl: null`, `webUrlTemplate: null`,
    `webWriteUrlTemplate: null` — es gibt in dieser Fixture also auch keinen Web-/WebDAV-Direktlink.

### 4.4 Client nutzt

- Upload: `uploadUrl` + `FileNode/set create` —
  `/home/heiko/repositories/waxwing/apps/web/src/files/files-client.ts:165-192`,
  `/home/heiko/repositories/waxwing/packages/jmap/src/client.ts:136-142`.
  `Blob/upload` ist **nicht registriert**, es wird immer der klassische Endpunkt genutzt.
- Download: `downloadUrl`-Template über `client.download` —
  `/home/heiko/repositories/waxwing/apps/web/src/files/files-client.ts:219-228`.
- `shareWith`: voll umgesetzt inkl. Rollenmodell, gated auf `myRights.mayShare` —
  `/home/heiko/repositories/waxwing/apps/web/src/files/sharing.ts:127-129`,
  `/home/heiko/repositories/waxwing/apps/web/src/files/FilesPage.tsx:451`.
- **Verschieben gibt es nicht:** `FileNode/set update` wird nur mit `name` (`files-client.ts:205-210`)
  oder `shareWith` (`:251-256`) aufgerufen; die Row-Actions sind exakt preview/share/rename/download/delete
  (`/home/heiko/repositories/waxwing/apps/web/src/files/FilesPage.tsx:440,453,468,482,493`).
- `FileNode/copy`: **nicht vorhanden**. Öffentliche Links: nicht vorhanden (gibt es serverseitig auch nicht).
- Typ kennt alle 17 Properties (`/home/heiko/repositories/waxwing/packages/jmap/src/types/filenode.ts:45-68`);
  ungenutzt bleiben `target`, `created`, `modified`, `accessed`, `changed`, `executable`, `isSubscribed`, `role`.

### 4.5 Lücke

Dateien sind der am besten abgedeckte Bereich; es fehlt im Wesentlichen das Verschieben per
Drag-and-Drop oder Menü (der Server kann es, `parentId` ist einfach änderbar) und die Anzeige von
Änderungsdatum/Größe-Metadaten, die längst mitgeliefert werden. Öffentliche Links fehlen beiden Seiten.

---

## 5. Clientseite — Zusammenfassung

| Fähigkeit | Server | Client |
|---|---|---|
| `Mailbox.shareWith` | ✔ | ✘ (nicht mal im Typ) |
| `Calendar.shareWith` | ✔ | ✘ (nicht mal im Typ) |
| `AddressBook.shareWith` | ✔ | nur lesend (Badge) |
| `FileNode.shareWith` | ✔ | ✔ voll |
| Fremdkonten (`isPersonal:false`) | ✔ | nur Mail |
| `ShareNotification/get\|changes\|query\|set` | ✔ alle vier | ✘ (Typen da, 0 Aufrufer) |
| `Principal/get`, `Principal/query` | ✔ | nur im Datei-Share-Picker |
| `Principal/getAvailability` | ✔ | ✘ |
| `Calendar/set` | ✔ (voller Property-Satz) | registriert, nie aufgerufen |
| `participants` / RSVP | ✔ (mit `calendarAddress`) | nur anzeigen |
| iMIP-Versand | ✘ | ✘ |
| `CalendarEvent/parse` | ✔ | ✘ |
| ICS-Export | nur CalDAV | ✘ |
| `recurrenceOverrides`, `expandRecurrences` | ✔ | nur `expandRecurrences` |
| `ContactCard/parse` | ✔ | ✘ (parst clientseitig) |
| Kontaktfoto als Blob | ✘ (nur `data:`-URI) | schreibt `blobId` → **bricht** |
| Kontaktgruppen | ✔ | ✔ |
| `ContactCard/copy` / `FileNode/copy` | nur kontoübergreifend | ✘ |
| FileNode verschieben | ✔ | ✘ |
| Öffentliche Links | ✘ | ✘ |

Der bestehende Integrationstest, der die Server-Eigenheiten festhält, liegt in
`/home/heiko/repositories/waxwing/packages/jmap/test/integration/sharing.integration.test.ts`.

---

## Unsicherheiten

1. **iMIP: nicht abschließend geklärt, ob es an der Fixture-Konfiguration liegt.** Belegt ist nur:
   mit `participants`, `organizerCalendarAddress`, `scheduleAgent:"server"`, `scheduleForceSend:"request"`
   und `sendSchedulingMessages:true` entstand kein Queue-Eintrag, keine Mail und kein Termin beim
   Eingeladenen. Die Fixture-Konfiguration (`e2e/stalwart/config/config.json`) enthält nur den
   RocksDB-Store und **keinerlei** Kalender-/Scheduling-Einstellungen; ob Stalwart iTIP per
   Konfigurationsschlüssel aktiviert werden muss, konnte ich nicht prüfen, weil die
   Verwaltungs-API unter `/api/settings/...` mit HTTP 404 antwortet und ich die Fixture nicht
   neu starten durfte.
2. **`ContactCard/copy` und `FileNode/copy` konnte ich nicht erfolgreich ausführen.** Beide verlangen
   `fromAccountId != accountId` *und* Zugriff auf das Quellkonto. Carol hatte auf kein zweites Konto
   Zugriff, und ein Test hätte bedeutet, in alice' oder bobs Konto zu schreiben, was mir untersagt war.
   Belegt ist nur, dass die Methoden existieren und diese beiden Vorbedingungen prüfen.
3. **Transitive Freigabe über Gruppen-Principals ungeprüft.** Eine Gruppe ließ sich per
   `x:Account/set {"@type":"Group"}` anlegen und als `shareWith`-Ziel setzen. Die Mitgliedschaft
   konnte ich nicht setzen: `x:Account/set update {members:[…]}` → `{"type":"invalidPatch","description":"Invalid property","properties":["members"]}`,
   und das Group-Objekt hat laut `x:Account/get` gar kein `members`-Feld — Mitgliedschaft wird
   vermutlich von der Benutzerseite gepflegt, was ein Ändern von alice bedeutet hätte. Ob eine
   Freigabe an eine Gruppe bei deren Mitgliedern tatsächlich ankommt, ist damit **offen**.
4. **`ContactCard`-Fotoverhalten in neueren Stalwart-Versionen ungeprüft.** Es läuft parallel ein
   Container `waxwing-stalwart-probe` mit v0.16.18 auf Port 18081; ob dort `blobIds in media`
   inzwischen unterstützt wird, habe ich nicht getestet (fremde Fixture, andere Agenten).
5. **`scheduleStatus`** wurde von keinem `CalendarEvent/get` je zurückgegeben — ob Stalwart die
   Property kennt und nur mangels Scheduling leer lässt, oder sie gar nicht implementiert, ist offen.
6. **CardDAV-vCard-Export** habe ich nur indirekt belegt (die `/dav/pal/…`-Collection taucht im
   CalDAV-`PROPFIND` auf); einen konkreten `.vcf`-GET habe ich nicht durchgeführt. Der
   analoge CalDAV-ICS-GET ist dagegen mit HTTP 200 und vollem Body belegt.
7. **`FileNode.target`** (Symlinks) und **`role`** wurden nicht getestet.
