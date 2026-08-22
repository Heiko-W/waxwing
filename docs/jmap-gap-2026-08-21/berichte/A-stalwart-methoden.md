# Stalwart v0.16.14-alpine — empirisch ermittelte JMAP-Methoden

Erhoben am 2026-08-21 gegen die laufende Fixture `http://localhost:18080`.
Auth: HTTP Basic `alice@waxwing.test` (accountId `b`), zusätzlich `bob@waxwing.test` (accountId `c`,
gleiches Passwort — empirisch verifiziert) für die Cross-Account-Tests.

## Methodische Vorbemerkung: der API-Endpunkt

**Der in der Aufgabenstellung genannte Pfad `/jmap/api` existiert nicht** — er liefert HTTP 404
(`{"type":"about:blank","status":404,"title":"Not Found"}`). Der korrekte Endpunkt ist der
`apiUrl` aus dem Session-Objekt: **`http://localhost:18080/jmap/`**. Alle Ergebnisse unten
wurden gegen diesen Pfad erhoben. Auch `/.well-known/jmap` ist nur ein 307-Redirect auf
`/jmap/session`.

Probe-Verfahren: POST mit `using` = alle 16 Capability-URNs aus dem Session-Objekt und genau
einem `methodCall`. Kontrollprobe `Bogus/nonexistent` → `{"type":"unknownMethod"}`, d.h. das
Negativ-Signal ist verlässlich.

---

## 1. Methodentabelle

**86 Methoden existieren.** Legende: JA = implementiert, NEIN = `unknownMethod`.

| Methode | existiert | Beleg (Fehlertyp bzw. Kurzantwort) |
|---|---|---|
| Core/echo | JA | echo-Rückgabe `{"accountId":"b"}` |
| Core/status | NEIN | unknownMethod |
| Blob/upload | JA | `{"accountId":"b"}` (leeres create) |
| Blob/get | JA | `{"list":[],"notFound":[]}` |
| Blob/lookup | JA | `matchedIds:{"Email":["iaaaaac"],"Thread":["c"]}` |
| Blob/set | NEIN | unknownMethod |
| Mailbox/get | JA | liefert 5 Mailboxen |
| Mailbox/changes | JA | `created:["a","c","d","e","b"]` |
| Mailbox/set | JA | `oldState/newState` |
| Mailbox/query | JA | `ids:["a".."e"]` |
| Mailbox/queryChanges | JA | `added:[{id,index}…]` |
| Thread/get | JA | `{"list":[],"notFound":[]}` |
| Thread/changes | JA | `hasMoreChanges:false` |
| Email/get | JA | `{"state":"saa","list":[]}` |
| Email/changes | JA | ok |
| Email/query | JA | `canCalculateChanges:true` |
| Email/queryChanges | JA | ok |
| Email/set | JA | ok |
| Email/copy | JA | invalidArguments „The \"accountId\" property is required.“ |
| Email/import | JA | ok |
| Email/parse | JA | ok |
| SearchSnippet/get | JA | `{"list":[],"notFound":null}` |
| Identity/get | JA | 1 Identity |
| Identity/changes | JA | `created:["b"]` |
| Identity/set | JA | ok |
| EmailSubmission/get | JA | ok |
| EmailSubmission/changes | JA | ok |
| EmailSubmission/set | JA | ok |
| EmailSubmission/query | JA | ok |
| EmailSubmission/queryChanges | JA | ok |
| VacationResponse/get | JA | Singleton-Objekt |
| VacationResponse/set | JA | ok |
| Quota/get | JA | 1 Quota-Objekt (`hardLimit:104857600`) |
| Quota/changes | JA | `cannotCalculateChanges` |
| Quota/query | JA | `ids:["a"],total:1` |
| Quota/queryChanges | JA | `cannotCalculateChanges` |
| SieveScript/get | JA | ok |
| SieveScript/set | JA | ok |
| SieveScript/query | JA | ok |
| SieveScript/validate | JA | `{"error":{"type":"blobNotFound"}}` |
| SieveScript/changes | NEIN | unknownMethod |
| SieveScript/queryChanges | NEIN | unknownMethod |
| AddressBook/get | JA | 1 Adressbuch |
| AddressBook/changes | JA | `created:["b"]` |
| AddressBook/set | JA | ok |
| AddressBook/query | JA | `ids:["b"]` |
| AddressBook/queryChanges | NEIN | unknownMethod |
| ContactCard/get | JA | ok |
| ContactCard/changes | JA | ok |
| ContactCard/set | JA | ok |
| ContactCard/query | JA | ok |
| ContactCard/queryChanges | JA | ok |
| ContactCard/copy | JA | invalidArguments (accountId) |
| ContactCard/parse | JA | ok |
| Contact/get | NEIN | unknownMethod (altes RFC-Draft-Datenmodell) |
| ContactGroup/get | NEIN | unknownMethod |
| Calendar/get | JA | 1 Kalender |
| Calendar/changes | JA | `created:["b"]` |
| Calendar/set | JA | ok |
| Calendar/query | JA | `ids:["b"]` |
| Calendar/queryChanges | NEIN | unknownMethod |
| CalendarEvent/get | JA | ok |
| CalendarEvent/changes | JA | ok |
| CalendarEvent/set | JA | ok |
| CalendarEvent/query | JA | ok |
| CalendarEvent/queryChanges | JA | ok |
| CalendarEvent/copy | JA | invalidArguments (accountId) |
| CalendarEvent/parse | JA | ok |
| CalendarEvent/participantReply | NEIN | unknownMethod |
| CalendarEvent/importICS | NEIN | unknownMethod |
| CalendarEventNotification/get | JA | `{"list":[],"notFound":[]}` |
| CalendarEventNotification/changes | JA | ok |
| CalendarEventNotification/set | JA | ok |
| CalendarEventNotification/query | JA | ok |
| CalendarEventNotification/queryChanges | JA | ok |
| CalendarPreference/get | NEIN | unknownMethod |
| CalendarShareNotification/get | NEIN | unknownMethod |
| ParticipantIdentity/get | JA | 1 Identity (`mailto:alice@waxwing.test`) |
| ParticipantIdentity/changes | JA | `cannotCalculateChanges` |
| ParticipantIdentity/set | JA | ok |
| Principal/get | JA | 3 Principals (b, c, d) |
| Principal/changes | JA | `cannotCalculateChanges` |
| Principal/query | JA | `ids:["b","c","d"]` |
| Principal/queryChanges | JA | `cannotCalculateChanges` |
| Principal/getAvailability | JA | invalidArguments „Missing principal id“ |
| **Principal/set** | **SONDERFALL** | HTTP **400** `urn:ietf:params:jmap:error:notRequest` — siehe §3 |
| ShareNotification/get | JA | liefert echte Einträge |
| ShareNotification/changes | JA | ok |
| ShareNotification/set | JA | ok |
| ShareNotification/query | JA | ok |
| ShareNotification/queryChanges | JA | ok |
| PushSubscription/get | JA | `{"list":[],"notFound":[]}` |
| PushSubscription/set | JA | ok |
| PushSubscription/changes | NEIN | unknownMethod |
| FileNode/get | JA | ok |
| FileNode/changes | JA | ok |
| FileNode/set | JA | ok |
| FileNode/query | JA | ok |
| FileNode/queryChanges | JA | ok |
| FileNode/copy | JA | invalidArguments (accountId) |
| FileNode/parse | NEIN | unknownMethod |
| Email/importICS, Email/query/changes, Note/get | NEIN | unknownMethod (Negativkontrollen) |

---

## 2. In Waxwing ungenutzte, aber existierende Methoden

Grundlage der Nutzungsaussage: Analyse der `Methods.*`-Registry in
`/home/heiko/repositories/waxwing/packages/jmap/src/methods.ts` plus roher Method-Strings,
ohne `node_modules`, `dist-release`, `*.test.ts`, `test-support.ts`, `e2e/`.

Gar nicht im Repo vorhanden: `Blob/upload`, `Blob/get`, `Blob/lookup`, `Email/copy`,
`ContactCard/parse`, `ContactCard/copy`, `CalendarEvent/parse`, `CalendarEvent/copy`,
`FileNode/copy`, `Principal/getAvailability`, `CalendarEventNotification/*`,
`ParticipantIdentity/*`, `Quota/query`.

Nur als Typ/Registry-Eintrag ohne Produktivaufrufer: `ShareNotification/get|set` (Registry,
`methods.ts:262-267`), `ShareNotification/query|queryChanges|changes` (nur Typen,
`packages/jmap/src/types/principal.ts:125-130`), `Quota/changes`, `Core/echo` (nur Tests),
sowie `FileNode/changes`, `Calendar/changes`, `CalendarEvent/changes`.

### 2.1 Blob/upload — serverseitiges Zusammensetzen und Schneiden von Blobs

Das ist der zentrale Unterschied zum HTTP-Upload-Endpunkt: `Blob/upload` kann mehrere
Datenquellen (Inline-Text, Inline-Base64, **Referenzen auf bestehende Blobs mit
offset/length**) zu einem neuen Blob **konkatenieren**, und das innerhalb einer normalen
JMAP-Batch-Request.

Aufruf:
```json
["Blob/upload", {"accountId":"b","create":{
  "join": {"data":[{"blobId":"edfbjxh9…canbqornibq"},
                   {"blobId":"ebneb3gj…eanbqornibq"},
                   {"data:asText":" +TEXT"}],
           "type":"text/plain"}}}, "c0"]
```
Antwort:
```json
["Blob/upload",{"accountId":"b","created":{"join":{
  "id":"ebdkteettmmvz7p3lxdcysvenibmglii30wnum1y3jwqwfdfh2khsanbqornibq",
  "type":"text/plain","size":19}}},"c0"]
```
`Blob/get` auf das Ergebnis liefert wörtlich `"data:asText":"TEIL-A TEIL-B +TEXT"`.

Teilbereich schneiden (`offset`/`length` auf einer Blob-Referenz):
```json
["Blob/upload",{"accountId":"b","create":{"slice":{
  "data":[{"blobId":"edfbjxh9…","offset":5,"length":2}],"type":"text/plain"}}},"c0"]
```
→ neuer Blob der Größe 2, Inhalt `"A "`.

Fehlerfall unbekannte Quelle:
```json
["Blob/upload",{"accountId":"b","notCreated":{"bad":{
  "type":"invalidProperties","description":"Invalid blobId gibtsnicht."}}},"c0"]
```

**Funktional baubar:** MIME-Nachrichten serverseitig aus Bausteinen zusammensetzen (Header +
zitierter Originaltext + Anhänge, ohne Anhänge je durch den Browser zu schleusen), z.B. beim
Weiterleiten mit Anhang oder beim Bearbeiten eines Entwurfs — der Anhang-Blob des Originals
wird einfach referenziert statt neu hochgeladen.

### 2.2 Blob/get — Inhalt, Digest und Teilbereiche ohne Download-Endpunkt

```json
["Blob/get",{"accountId":"b","ids":["eaoj2dvn…"],
 "properties":["data:asText","size","digest:sha-256","data:asBase64"]},"c0"]
```
Antwort:
```json
["Blob/get",{"accountId":"b","list":[{
  "data:asText":"Hallo Waxwing\n","size":14,
  "digest:sha-256":"qJuMYo9g8odQzFhgoMfu6+jbXvuFuxXcFY+ZjdEvO7I=",
  "data:asBase64":"SGFsbG8gV2F4d2luZwo=",
  "id":"eaoj2dvn…"}],"notFound":[]},"c0"]
```
Mit `"offset":6,"length":7` liefert dieselbe Anfrage `"data:asText":"Waxwing"`.
Unterstützte Digests laut Session: `sha`, `sha-256`, `sha-512`.

**Funktional baubar:** Integritätsprüfung von Anhängen (Digest-Vergleich ohne Volldownload),
Range-Vorschau großer Dateien, und Anhang-Inhalte in derselben Batch-Request holen wie die
Mail-Metadaten — spart einen separaten authentifizierten HTTP-Roundtrip pro Anhang.

### 2.3 Blob/lookup — Rückwärtssuche Blob → Objekt

Funktioniert, aber nur mit der **persistierten** Blob-Id eines gespeicherten Objekts, nicht mit
der Id eines frisch hochgeladenen Blobs. Nach `Email/import` (Ergebnis-`blobId`
`cckckjnb913li3c7cyepobo0lojqyhfw10wfjif399vvokzszh0dgaiaai`, Email-Id `iaaaaac`, Thread `c`):

```json
["Blob/lookup",{"accountId":"b","typeNames":["Email","Thread","SieveScript"],
  "ids":["cckckjnb913li3c7cyepobo0lojqyhfw10wfjif399vvokzszh0dgaiaai"]},"l"]
```
```json
["Blob/lookup",{"accountId":"b","list":[{
  "id":"cckckjnb913li3c7cyepobo0lojqyhfw10wfjif399vvokzszh0dgaiaai",
  "matchedIds":{"Email":["iaaaaac"],"Thread":["c"]}}],"notFound":[]},"l"]
```

Dieselbe Nachricht über die **Upload-Blob-Id** (`eckckjnb913li3c7cyepobo0lojqyhfw10wfjif399vvokzszh0dgaogrcrnibq`)
gefragt liefert dagegen `"matchedIds":{}` — der hochgeladene Rohblob gilt als eigenständig und
unreferenziert, obwohl er inhaltlich identisch ist.

Nebenbefund zur Blob-Id-Systematik: das erste Zeichen kodiert die Blob-Klasse. `e…` =
temporärer Upload-Blob, `c…` = persistierter Objekt-Blob, längere Varianten (`ef…`, `cg…`) =
MIME-Teil-Blobs innerhalb einer Nachricht. Die Session begrenzt `supportedTypeNames` auf
`["Email","Thread","SieveScript"]` — Kalender-, Kontakt- und Dateiobjekte sind **nicht**
auflösbar.

**Funktional baubar:** „Zu welcher Mail gehört dieser Anhang?“ — von einem Download-Link oder
einer Blob-Id zurück auf Email und Thread navigieren, oder vor dem Aufräumen prüfen, ob ein
Blob noch referenziert wird.

### 2.4 Email/parse — MIME → JMAP-Email-Objekt ohne Import

```json
["Email/parse",{"accountId":"b","blobIds":["eb3ctpc2…"],
 "properties":["messageId","subject","from","to","sentAt","bodyStructure","preview",
               "attachments","hasAttachment","size","headers"],
 "bodyProperties":["partId","blobId","type","name","size","disposition"]},"c0"]
```
Antwort (gekürzt, aber wörtlich):
```json
["Email/parse",{"accountId":"b","parsed":{"eb3ctpc2…":{
 "messageId":["parse-test-1@waxwing.test"],"subject":"Parse-Test",
 "from":[{"name":"Bob Baker","email":"bob@waxwing.test"}],
 "to":[{"name":"Alice","email":"alice@waxwing.test"}],
 "sentAt":"2026-08-18T10:00:00+02:00",
 "bodyStructure":{"partId":null,"blobId":null,"type":"multipart/mixed","subParts":[
   {"partId":"1","blobId":"ef3ctpc2…u0ainq","type":"text/plain","size":27,"disposition":null},
   {"partId":"2","blobId":"ef3ctpc2…vdamdq","type":"text/csv","name":"daten.csv","size":7,
    "disposition":"attachment"}]},
 "preview":"Hallo Alice, hier der Body.",
 "attachments":[{"partId":"2","blobId":"ef3ctpc2…vdamdq","type":"text/csv",
                 "name":"daten.csv","size":7,"disposition":"attachment"}],
 "hasAttachment":true,"size":436,
 "headers":[{"name":"From","value":" Bob Baker <bob@waxwing.test>"}, …]}}},"c0"]
```
Unbekannte Blob-Id → `{"accountId":"b","notFound":["nichtda"]}` (kein Fehlerobjekt).

Anmerkung: Waxwing nutzt `Email/parse` bereits produktiv
(`apps/web/src/mail/use-parsed-message.ts:53`) — hier steht es nur als Referenzantwort.

### 2.5 ContactCard/parse — vCard → JSContact

Eingabe: vCard 4.0 als Blob (`text/vcard`).
```json
["ContactCard/parse",{"accountId":"b","blobIds":["eclpshhl…"]},"c0"]
```
Antwort:
```json
["ContactCard/parse",{"accountId":"b","parsed":{"eclpshhl…":{
 "name":{"full":"Carla Test","components":[{"kind":"surname","value":"Test"},
                                           {"kind":"given","value":"Carla"}]},
 "phones":{"k1":{"number":"+49123456"}},
 "version":"1.0","@type":"Card","uid":"vc-1",
 "organizations":{"k1":{"name":"Waxwing GmbH"}},
 "emails":{"k1":{"address":"carla@waxwing.test"}},
 "vCard":{"properties":[["version",{},"unknown","4.0"]]}}}},"c0"]
```
Der Server macht die vollständige vCard→JSContact-Konversion; nicht abbildbare Properties
landen im Passthrough-Feld `vCard.properties`.

**Funktional baubar:** Import von `.vcf`-Dateien per Drag&Drop mit **Vorschau vor dem
Speichern** — der Client muss keinen eigenen vCard-Parser mitbringen. Analog: Kontakt-Anhänge
aus E-Mails direkt als strukturierte Karte anzeigen und mit einem Klick übernehmen.

### 2.6 CalendarEvent/parse — iCalendar → JSCalendar

```json
["CalendarEvent/parse",{"accountId":"b","blobIds":["eci1rf1x…"]},"c0"]
```
Antwort (beachte: der Wert pro Blob ist ein **Array**, weil eine VCALENDAR mehrere VEVENTs
enthalten kann):
```json
["CalendarEvent/parse",{"accountId":"b","parsed":{"eci1rf1x…":[{
 "organizerCalendarAddress":"mailto:alice@waxwing.test",
 "start":"2026-09-01T09:00:00","uid":"ev-1@waxwing.test","description":"Test",
 "iCalendar":{"convertedProperties":{"duration":{"name":"dtend"}},"name":"vevent"},
 "updated":"2026-08-18T08:00:00Z",
 "participants":{"599d34e8-…":{"calendarAddress":"mailto:bob@waxwing.test","@type":"Participant"},
                 "db1a00f9-…":{"calendarAddress":"mailto:alice@waxwing.test","@type":"Participant"}},
 "duration":"PT1H","title":"Probe-Termin","@type":"Event",
 "locations":{"587e4ee5-…":{"name":"Verl","@type":"Location"}},
 "timeZone":"Etc/UTC"}]}},"c0"]
```
Der Server rechnet `DTEND` in `duration` um und protokolliert das in
`iCalendar.convertedProperties`.

**Funktional baubar:** iMIP-Einladungen (`text/calendar`-Anhang) direkt in der Mailansicht als
Termin-Karte rendern — Titel, Zeitraum, Ort, Teilnehmer — inklusive „Zum Kalender hinzufügen“,
ohne iCal-Parser im Client. Ebenso `.ics`-Import mit Vorschau.

### 2.7 Email/copy — Mail in einen anderen Account kopieren

Voraussetzung ist echter Cross-Account-Zugriff: `fromAccountId` ≠ `accountId`, sonst
`invalidArguments "From accountId is equal to fromAccountId"`; ohne Freigabe
`forbidden "You do not have access to account c"`.

Getestet mit einer von Alice an Bob freigegebenen Mailbox
(`Mailbox/set … shareWith:{"c":{mayReadItems:true, …}}`); Bobs Session enthielt danach
tatsächlich beide Accounts `["c","b"]`. Aufruf **als Bob**:
```json
["Email/copy",{"fromAccountId":"b","accountId":"c",
  "create":{"cp":{"id":"eaaaaab","mailboxIds":{"a":true},
                  "keywords":{"$seen":true,"kopiert":true},
                  "receivedAt":"2026-08-20T12:00:00Z"}},
  "onSuccessDestroyOriginal":false},"cp"]
```
Antwort:
```json
["Email/copy",{"fromAccountId":"b","accountId":"c","oldState":"sfy","newState":"sga",
 "created":{"cp":{"id":"beaaaaaj","threadId":"j",
                  "blobId":"cdml3sqceglprkje3fgkxq9uej7htc9ew7nm2cbdfuql3zr3d9x7yaqabe",
                  "size":160}}},"cp"]
```
Die Kopie ist im Zielaccount vollständig lesbar, Keywords und `receivedAt` wurden übernommen,
`threadId` und `blobId` sind neu vergeben.

**Funktional baubar:** „In freigegebenes Postfach verschieben/kopieren“ (z.B. persönliche Mail
→ Team-Postfach) als atomare Serveroperation statt Download-und-Reupload.

### 2.8 ContactCard/copy, CalendarEvent/copy, FileNode/copy — abweichende Aufrufkonvention

Diese drei existieren und funktionieren, verlangen aber eine **andere Argumentform als
`Email/copy` und als RFC 8621**: Der **Key der `create`-Map ist die Quell-Objekt-Id**, und ein
`id`-Property im Objekt ist verboten (`"The id property is immutable."`). Wer wie im RFC einen
freien creationId-Key benutzt, bekommt `notFound "Item <creationId> not found in account b."` —
der Server sucht wörtlich nach dem creationId als Objekt-Id. Empirisch abgesichert durch drei
Varianten (freier Key → notFound; Key = Quell-Id **mit** `id` → immutable; Key = Quell-Id
**ohne** `id` → Erfolg).

ContactCard/copy (als Bob, Adressbuch von Alice freigegeben):
```json
["ContactCard/copy",{"fromAccountId":"b","accountId":"c",
  "create":{"d":{"addressBookIds":{"b":true}}}},"c"]
```
```json
["ContactCard/copy",{"fromAccountId":"b","accountId":"c","oldState":"smm",
 "newState":"sqiaq","created":{"d":{"id":"b"}}},"c"]
```
Kopie gelesen:
```json
["ContactCard/get",{"accountId":"c","state":"sqiaq","list":[{
 "emails":{"e1":{"address":"final@waxwing.test"}},"name":{"full":"ZZ Final"},
 "@type":"Card","version":"1.0","id":"b","addressBookIds":{"b":true}}],"notFound":[]},"g"]
```

CalendarEvent/copy:
```json
["CalendarEvent/copy",{"fromAccountId":"b","accountId":"c",
  "create":{"d":{"calendarIds":{"b":true}}}},"c"]
```
```json
["CalendarEvent/copy",{"fromAccountId":"b","accountId":"c","oldState":"sgy",
 "newState":"sqqaq","created":{"d":{"id":"b"}}},"c"]
```
Kopie: `{"title":"ZZ-Final-Termin","start":"2026-09-11T09:00:00","duration":"PT1H","calendarIds":{"b":true},"id":"b"}`.

FileNode/copy (erlaubt gleichzeitiges Umbenennen und Umhängen):
```json
["FileNode/copy",{"fromAccountId":"b","accountId":"c",
  "create":{"e":{"name":"zz3-kopie.txt","parentId":null}}},"c"]
```
```json
["FileNode/copy",{"fromAccountId":"b","accountId":"c","oldState":"saa",
 "newState":"sq2aq","created":{"e":{"id":"b"}}},"c"]
```
Kopie: `{"name":"zz3-kopie.txt","type":"text/plain","size":25,"blobId":"cccn2jmrtbcui1zwpt3a3sfeovkvukjmywfjgv09okt2kkwsnsgwiaqmae","parentId":null,"id":"b"}`.

**Funktional baubar:** „Kontakt / Termin / Datei in einen freigegebenen Account übernehmen“ als
Ein-Klick-Aktion. Bei FileNode zusätzlich Server-seitiges Duplizieren großer Dateien ohne
erneuten Upload — der Blob wird geteilt, nur der Knoten ist neu.

### 2.9 Principal/getAvailability — Free/Busy-Abfrage

Verlangt `id` (Principal) sowie `utcStart`/`utcEnd`. Ohne `id`:
`invalidArguments "Missing principal id"`.
```json
["Principal/getAvailability",{"accountId":"b","id":"b",
  "utcStart":"2026-09-01T00:00:00Z","utcEnd":"2026-09-05T00:00:00Z"},"c0"]
```
Bei leerem Kalender: `{"list":[]}`. Nach Anlegen eines Termins (10:00–12:00 Europe/Berlin,
`freeBusyStatus:"busy"`):
```json
["Principal/getAvailability",{"list":[{
 "utcStart":"2026-09-02T08:00:00Z","utcEnd":"2026-09-02T10:00:00Z",
 "busyStatus":"confirmed","event":null}]},"c0"]
```
Die Zeiten werden korrekt nach UTC normalisiert. `showDetails`/`eventProperties` sind stark
eingeschränkt: `eventProperties:["title","start","duration"]` wird abgelehnt mit
`invalidArguments "Only 'id' and 'baseEventId' properties are supported in results"` —
deshalb bleibt `event` hier `null`.

**Funktional baubar:** Terminplaner-Raster („wann sind alle frei?“) beim Einladen von
Teilnehmern, ohne deren Kalenderinhalte lesen zu dürfen. Ergänzend liefert
`Principal/query {"filter":{"email":"bob@waxwing.test"}}` → `ids:["c"]` die Principal-Id zur
Mailadresse; `filter:{"type":"individual"}` listet alle drei Principals. **Achtung:**
`filter:{"name":"bob"}` lieferte leer — die Namenssuche greift auf diesen Datenbestand nicht
wie erwartet.

### 2.10 ShareNotification/* — funktioniert und wird tatsächlich befüllt

Die einzige der „Notification“-Familien, die im Test echte Daten lieferte. Nach
`Calendar/set` bzw. `AddressBook/set` mit `shareWith` bekam der Empfänger:
```json
["ShareNotification/get",{"accountId":"c","state":"sqdkihx0ew3gmcba","list":[{
 "id":"jazrxjf1b7qa","name":"",
 "changedBy":{"principalId":"b","name":"Alice Anderson (Waxwing e2e)",
              "email":"alice@waxwing.test"},
 "created":"2026-08-21T15:52:27Z","objectAccountId":"b","objectId":"c",
 "objectType":"Calendar",
 "oldRights":{"mayReadFreeBusy":false,"mayReadItems":false,"mayWriteAll":false,
              "mayWriteOwn":false,"mayUpdatePrivate":false,"mayRSVP":false,
              "mayShare":false,"mayDelete":false},
 "newRights":{"mayReadFreeBusy":true,"mayReadItems":true,"mayWriteAll":true,
              "mayWriteOwn":true,"mayUpdatePrivate":true,"mayRSVP":true,
              "mayShare":false,"mayDelete":false}}, …]},"g"]
```
Es entstehen Einträge für `Mailbox`, `Calendar`, `AddressBook` und `FileNode`, jeweils mit
altem und neuem Rechte-Set. `ShareNotification/set` dient nur dem Wegräumen (destroy).

**Funktional baubar:** Ein Posteingang für Freigaben — „Alice hat dir ihren Kalender
freigegeben“ als abweisbare In-App-Benachrichtigung, inklusive Anzeige, welche Rechte sich
konkret geändert haben. Waxwing hat dafür bereits Typen und Registry-Einträge, aber keinen
einzigen Aufrufer.

### 2.11 ParticipantIdentity/* — Kalender-Absenderidentitäten

`ParticipantIdentity/get` liefert die Kalender-Adressen, unter denen der Account Einladungen
verschickt/beantwortet:
```json
["ParticipantIdentity/get",{"accountId":"b","list":[{
 "id":"a","name":"Alice Anderson (Waxwing e2e)",
 "calendarAddress":"mailto:alice@waxwing.test","isDefault":true}],"notFound":[]},"c0"]
```
`ParticipantIdentity/set` kann `update` und `destroy` (beides verifiziert), aber `create` nur
mit einer Adresse, die dem Account zugeordnet und noch frei ist:
- fremde Adresse → `invalidProperties "Calendar address not configured for this account."`
- bereits belegte Adresse → `invalidProperties "Calendar address already in use."`
- `isDefault` ist **read-only**: sowohl in `create` als auch in `update` →
  `invalidProperties "Field could not be set." properties:["isDefault"]`

`ParticipantIdentity/changes` antwortet immer `cannotCalculateChanges`.

**Funktional baubar:** Auswahl „Als wen antworte ich auf diese Einladung?“ bei mehreren
Kalenderadressen (Alias, Funktionspostfach) — analog zu `Identity` bei E-Mail.

### 2.12 CalendarEventNotification/* — vorhanden, im Test aber nie befüllt

Alle fünf Verben antworten regulär, die Collection blieb jedoch in **jedem** Szenario leer:
```json
["CalendarEventNotification/get",{"accountId":"b","state":"saa","list":[],"notFound":[]},"g"]
```
Auch nachdem Bob als fremder Principal einen Termin in Alices freigegebenem Kalender geändert
hatte (`CalendarEvent/set` update `title` → `updated:{"e":null}`, also erfolgreich), blieb
Alices Liste nach 1,5 s leer, und `state` änderte sich nicht von `"saa"`.

**Funktional baubar (falls befüllt):** „Bob hat euren gemeinsamen Termin verschoben“-Feed.
Ich kann aber nicht belegen, dass der Server diese Objekte überhaupt jemals erzeugt — siehe
§5 Unsicherheiten.

### 2.13 Quota/query, Quota/changes, Quota/queryChanges

`Quota/query` funktioniert (`{"queryState":"n","canCalculateChanges":false,"position":0,
"ids":["a"],"total":1}`), `Quota/changes` und `Quota/queryChanges` antworten dagegen konstant
`cannotCalculateChanges` — für inkrementelle Quota-Synchronisation also unbrauchbar,
Polling per `Quota/get` bleibt der einzige Weg. Das `Quota`-Objekt selbst nennt die
abgedeckten Typen: `["Email","SieveScript","FileNode","CalendarEvent","ContactCard"]`.

---

## 3. Sonderfall Principal/set — vergiftet die gesamte Request

`Principal/set` ist **nicht** `unknownMethod`, verhält sich aber schlimmer: Der Server bricht
die **komplette** Request mit HTTP 400 ab.
```json
{"type":"urn:ietf:params:jmap:error:notRequest","status":400,
 "detail":"{\"using\":[…],\"methodCalls\":[[\"Principal/set\",{\"accountId\":\"b\"},\"c0\"]]}"}
```
Das passiert unabhängig von den Argumenten (getestet: nur `accountId`, leer, `create`,
`update`, `destroy`, alles `null`). Offenbar kennt der Request-Parser den Methodennamen, hat
aber keinen Argument-Parser dafür und bricht schon beim Parsen ab.

Praktisch relevant ist der Kontrast im Batch:
- `[Core/echo, Bogus/nope, Mailbox/get]` → HTTP 200, nur der mittlere Call ergibt
  `["error",{"type":"unknownMethod"},…]`, die anderen beiden liefern normal.
- `[Core/echo, Principal/set, Mailbox/get]` → HTTP **400**, **keine** einzige
  methodResponse — auch die validen Calls fallen aus.

Für einen Client heißt das: `Principal/set` darf niemals in eine Batch-Request geraten.

---

## 4. WebSocket und Upload-Endpunkt

### 4.1 WebSocket (RFC 8887) — funktioniert vollständig

Node 24s globales `WebSocket` ist hier **nicht** benutzbar, weil es keine eigenen Header
erlaubt; die Verbindung scheitert mit Close-Code 1006. Mit einem rohen HTTP-Upgrade
(`node:http` + eigenes Frame-Encoding) funktioniert alles:

- **Ohne Auth:** HTTP 401, Header
  `www-authenticate: Bearer realm="Stalwart Server", resource_metadata="/.well-known/oauth-protected-resource", Basic realm="Stalwart Server"`.
- **Mit `Authorization: Basic …` und `Sec-WebSocket-Protocol: jmap`:** Upgrade erfolgreich,
  Antwortheader `sec-websocket-protocol: jmap`. Basic-Auth im Handshake genügt, ein
  Bearer-Token ist nicht nötig.

Request/Response über die Socket-Verbindung:
```
>> {"@type":"Request","using":[…16 URNs…],"methodCalls":[["Core/echo",{"ws":"hallo"},"w1"]],"id":"r1"}
<< {"@type":"Response","methodResponses":[["Core/echo",{"ws":"hallo"},"w1"]],"sessionState":"7ab9497","requestId":"r1"}
```
Das `id`-Feld der Request kommt als `requestId` in der Response zurück.

Push-Registrierung — `supportsPush: true` hält, was es verspricht:
```
>> {"@type":"WebSocketPushEnable","dataTypes":["Email","Mailbox","CalendarEvent"]}
>> {"@type":"Request",…,"methodCalls":[["Mailbox/set",{"accountId":"b","create":{"m":{"name":"ZZ-WS-Probe"}}},"w2"]],"id":"r2"}
<< {"@type":"Response","methodResponses":[["Mailbox/set",{…,"created":{"m":{"id":"j"}}},"w2"]],"sessionState":"7ab9497","requestId":"r2"}
<< {"@type":"StateChange","changed":{"b":{"Mailbox":"sfq"}}}
>> {"@type":"Request",…,"methodCalls":[["Mailbox/set",{"accountId":"b","destroy":["j"]},"w3"]],"id":"r3"}
<< {"@type":"Response",…,"destroyed":["j"]…}
<< {"@type":"StateChange","changed":{"b":{"Mailbox":"sfu"}}}
```
`WebSocketPushEnable` wird also wirksam, die `StateChange`-Pushes kommen unaufgefordert und
ungültige Nachrichten werden sauber quittiert:
```
>> {"@type":"Quatsch"}
<< {"@type":"RequestError","type":"urn:ietf:params:jmap:error:notRequest","status":400,
    "detail":"Invalid WebSocket JMAP request Invalid WebSocket JMAP request at line 1 column 19"}
```
Bemerkenswert: **Requests über den WebSocket funktionieren ohne erneute Authentifizierung
pro Nachricht** — die Auth des Handshakes gilt für die Verbindung.

Ergänzend getestet: der klassische **EventSource**-Endpunkt
(`/jmap/eventsource/?types=*&closeafter=no&ping=1`) liefert `200 text/event-stream` und pusht
dieselben Ereignisse:
```
event: state
data: {"@type":"StateChange","changed":{"b":{"Mailbox":"sgm"}}}
```
Er sendet allerdings **keinen initialen Zustandsschnappschuss** — mit `closeafter=state` kam
in 3 s gar nichts; Daten fließen erst bei einer echten Änderung.

### 4.2 uploadUrl vs. Blob/upload — zwei verschiedene Dinge

Beide erzeugen Blobs im selben Blob-Store (der `blobId` aus dem einen ist im anderen
verwendbar), unterscheiden sich aber grundlegend:

| | `POST /jmap/upload/{accountId}/` | `Blob/upload` |
|---|---|---|
| Transport | roher HTTP-Body, ein Blob pro Request | JMAP-Methode, mehrere Blobs pro Call |
| Zusammensetzen | nein | ja: `data`-Array aus Text/Base64/Blob-Referenzen |
| Teilbereiche | nein | ja: `offset`/`length` auf Blob-Referenzen |
| Batchbar mit anderen Calls | nein | ja |
| Größenlimit | `maxSizeUpload` = 50 000 000 | effektiv `maxSizeRequest` = 10 000 000 |

Antwort des Upload-Endpunkts:
```json
{"accountId":"b","blobId":"edpmdh0wvrrixgft7b29mw97gyhfufp1wdhk0ychy7mq9mvsygrucamqqornibq",
 "type":"text/plain","size":20}
```

Das Größenlimit ist empirisch scharf: 8 MB Nutzdaten per `Blob/upload` (Base64 ≈ 10,7 MB
Request) →
```json
{"type":"urn:ietf:params:jmap:error:limit","status":400,
 "detail":"The request is larger than the server is willing to process.","limit":"maxSizeRequest"}
```
Dieselben 8 MB über `uploadUrl` → HTTP 200, `"size":8000000`. 7 MB per `Blob/upload`
funktionieren dagegen (`"size":7000000`). Der in der Session genannte Wert
`maxSizeBlobSet: 7499488` ist also nicht das bindende Limit — es greift vorher
`maxSizeRequest` inklusive Base64-Overhead von 4/3.

**Konsequenz:** Für Anhänge > ~7 MB ist der HTTP-Upload-Endpunkt zwingend; `Blob/upload`
lohnt sich für kleine Blobs und vor allem fürs serverseitige Zusammensetzen.

---

## 5. Unsicherheiten — was ich NICHT klären konnte

1. **CalendarEventNotification wird nie befüllt.** Die fünf Methoden existieren und antworten
   korrekt, aber ich habe in keinem Szenario einen Eintrag erzeugen können — auch nicht, als
   Bob als fremder Principal einen Termin in Alices freigegebenem Kalender per
   `CalendarEvent/set` umbenannte (das Update war nachweislich erfolgreich). Ob der Auslöser
   ein anderer ist (iMIP-Einladung von extern, RSVP-Antwort, Alarm) oder ob die Collection in
   v0.16.14 schlicht ein Stub ist, kann ich **nicht** entscheiden. Ich habe keinen
   SMTP-Zustellweg getestet.

2. **`Principal/set`: Ursache unbelegt.** Dass die ganze Request mit `notRequest` stirbt, ist
   reproduzierbar gemessen. Meine Erklärung („Name bekannt, Argument-Parser fehlt“) ist eine
   Hypothese aus dem Fehlerbild, kein Beleg — ich habe den Stalwart-Quelltext nicht gelesen.

3. *(geklärt, siehe §2.3 — `Blob/lookup` liefert Treffer für persistierte Blob-Ids; nur
   frisch hochgeladene Blobs bleiben ohne `matchedIds`.)*

4. **`onSuccessDestroyOriginal` bei `Email/copy` ist defekt — Ursache unklar.** Mit
   `onSuccessDestroyOriginal:true` erzeugt der Server zwar korrekt die Kopie und hängt eine
   implizite `Email/set`-Response an, diese scheitert aber:
   `["Email/set",{"accountId":"b",…,"notDestroyed":{"cp2":{"type":"notFound"}}},"cp2"]` —
   der Schlüssel `cp2` ist die creationId, nicht die Quell-Mail-Id. Das Original blieb
   nachweislich erhalten. Das Muster passt zum Id-Verwechslungsbild aus §2.8, aber ob es
   dieselbe Ursache ist oder ein Rechteproblem (Bob hatte `mayRemoveItems:true`), habe ich
   nicht isoliert.

5. **`Principal/query` mit `filter:{"name":"bob"}` liefert leer**, obwohl der Principal `c` den
   Namen `bob@waxwing.test` trägt und der `email`-Filter ihn findet. Ob `name` eine
   Präfix-/Exakt-Semantik hat oder der Index fehlt, konnte ich nicht klären.

6. **Parallelbetrieb der Fixture.** Während meiner Messungen arbeiteten andere Agenten auf
   demselben Server (sichtbar an Freigaben von Principal `d` / Carol Chen und an wechselnden
   `state`-Werten zwischen zwei identischen Aufrufen). Zustandsabhängige Werte in diesem
   Bericht (State-Strings, Objekt-Ids, Listenlängen) sind daher Momentaufnahmen. Die
   Ja/Nein-Aussagen zur Existenz sind davon nicht betroffen.

7. **Nicht getestet:** OAuth/Bearer-Auth am WebSocket (nur Basic verifiziert),
   `PushSubscription/set` mit echtem VAPID-Endpunkt (`urn:ietf:params:jmap:webpush-vapid` ist
   angekündigt, ein echter Push-Zustellweg wurde nicht aufgebaut), sowie sämtliche
   Sieve-Skript-Semantik jenseits der Existenzprüfung.

### Von mir verursachte Zustandsänderung an der Fixture (nicht rückgängig zu machen)

Beim Test von `ParticipantIdentity/set` habe ich die Default-Identität von Alice zerstört und
neu angelegt. Da `isDefault` **read-only** ist, konnte ich den Ursprungszustand nicht
wiederherstellen:

- vorher: `{"id":"a","name":"Alice Anderson (Waxwing e2e)","calendarAddress":"mailto:alice@waxwing.test","isDefault":true}`
- jetzt:  `{"id":"b","name":"Alice Anderson (Waxwing e2e)","calendarAddress":"mailto:alice@waxwing.test","isDefault":false}`

Name und Kalenderadresse stimmen wieder, aber **Id und `isDefault` weichen ab**. Wer sich auf
`isDefault:true` oder auf die Id `a` verlässt, muss die Fixture neu aufsetzen.

Ebenfalls verblieben: die `ShareNotification`-Einträge in Bobs Account, die durch meine
Freigabetests entstanden sind (`Mailbox:b`, `Calendar:b`, `AddressBook:b`, `FileNode:b`). Ich
habe sie **bewusst nicht** gelöscht, weil ich meine Einträge nicht sicher von denen anderer
parallel laufender Agenten unterscheiden konnte.

Alle übrigen Testobjekte wurden verifiziert entfernt: Alices Mailboxen sind wieder die
5 Standardordner, Kalender/Adressbuch je nur der Default (beide wieder `isDefault:true`),
`FileNode/get`, `ContactCard/get`, `CalendarEvent/get` und `Email/query` liefern leer; in Bobs
Account findet `Email/query` mit `filter:{"subject":"Copy-Probe"}` bzw. `"ZZ"` nichts mehr.
