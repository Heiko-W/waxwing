# Was Stalwart per JMAP anbietet und Waxwing noch nicht nutzt

**Erhebung vom 21.08.2026.** Befundliste zum späteren Abarbeiten, im Stil der
UI-Begehung vom selben Tag (`docs/ui-walkthrough-2026-08-21.md`).

Beschränkt auf das, was eine reine Browser-App ohne Server-Anteil leisten kann —
Produktprinzip 1 der Spezifikation ("Zero backend"). Alles, was einen Dienst neben
dem Mailserver bräuchte, steht nicht drin.

---

## Wie gemessen wurde

Nicht gegen Dokumentation, sondern gegen **laufende Server**. Jede Methode wurde echt
aufgerufen; `unknownMethod` trennt "gibt es nicht" von "gibt es", jeder positive Befund
ist mit Aufruf und Antwort belegt.

| | |
|---|---|
| **Fixture** | Stalwart **v0.16.14-alpine** auf `:18080` — was Entwicklung und CI heute testen |
| **Probe** | Stalwart **v0.16.18-alpine** auf `:18081`, für diese Erhebung gestartet |
| **Produktiv** | `mail.hcw-orange.media` läuft **v0.16.17** (per SSH abgefragt) |

Der Unterschied ist nicht akademisch: die Fixture ist **älter als der Produktivserver**,
und in v0.16.16–18 hat Stalwart genau an den hier untersuchten Flächen etwas geändert
(siehe I-1).

Sechs Prüfungen liefen parallel, jede auf einem eigenen Konto. Die vollständigen
Rohberichte samt Beispielaufrufen liegen in [`berichte/`](berichte/). Sie sind
Arbeitsmaterial und nicht redigiert; wo diese Liste und ein Rohbericht sich
widersprechen, gilt diese Liste — die strittigen Punkte wurden nachgeprüft.

**Grenzen der Aussage.** Was nicht abschließend geklärt werden konnte, steht als solches
in den Berichten (Abschnitte "Unsicherheiten") und in I-4. Die Aufwandsschätzungen
(S/M/L) sind grobe Einordnungen aus der Codelage, keine geplanten Größen.

## Zahlen

| | |
|---|---|
| JMAP-Methoden, die Stalwart anbietet | **86** |
| davon in `packages/jmap` typisiert | **53** |
| davon im Produktivcode wirklich aufgerufen | **43** |
| Capabilities in der Session | 17 (v0.16.18), 16 (v0.16.14) |
| davon von Waxwing genutzt | 11 |

Die 43 zu 86 sind aber **kein** Maß für die Lücke: Waxwing deckt die
Alltagsfunktionen breit ab, und ein Teil der ungenutzten Methoden ist bewusst
draußen. Die Befunde unten sind nach Nutzen sortiert, nicht nach Methodenzahl.

## Umfang

**67 Befunde** in neun Gruppen. Davon sind sechs ausdrücklich als *kein Handlungsbedarf*
markiert (geprüft und verworfen: P-2, P-3, M-12, M-14, D-6, X-7) und fünf sind Fallen
— Dinge, die heute folgenlos sind, aber beim Bau des jeweiligen Features zuschlagen
(K-7, S-7, A-6, M-13, D-7).

| Gruppe | | Befunde |
|---|---|---|
| **B** | Defekte — heute kaputt, keine Lücke | 7 |
| **P** | Push & Benachrichtigungen | 3 |
| **S** | Freigabe & Delegation | 7 |
| **K** | Kalender | 10 |
| **A** | Kontakte | 6 |
| **M** | Mail | 14 |
| **D** | Dateien | 7 |
| **X** | Stalwart-Selbstbedienung (proprietär) | 8 |
| **I** | Infrastruktur & Hygiene | 5 |

## Aufbau der Befunde

Jeder Befund nennt, was der **Server** kann (belegt), was **Waxwing** heute tut, und
was das für den **Benutzer** bedeutet. Kennzeichnung: **[Roadmap]** heißt, die Spezifikation sieht das bereits für V2/V2+ vor —
der Befund sagt dann nur, dass der Server es schon kann. **[Neu]** heißt, es steht
nirgends in der Planung.

---

## B — Defekte

Keine Lücken, sondern Dinge, die heute nicht funktionieren. Gefunden nebenbei; sie
gehören trotzdem hierher, weil sie sonst untergehen.

### B-1 — Kontaktfotos lassen sich nicht setzen (zwei unabhängige Ursachen)

Die schwerste Einzelsache dieser Erhebung. Der Fehler ist **doppelt**, beide Hälften
wurden getrennt gefunden und einzeln nachgeprüft:

**Erstens ist der Pfad nicht angeschlossen.** `ContactForm` nimmt eine optionale Prop
`uploadPhoto` (`ContactForm.tsx:71`), und **keine** der beiden Render-Stellen in
`ContactsScreen.tsx:420` und `:428` übergibt sie. Ohne Uploader setzt `PhotoField` das
`<input type="file">` auf `disabled` (`ContactForm.tsx:816`) — die Beschriftung „Foto
wählen" bleibt aber sichtbar. Der Benutzer sieht also eine Schaltfläche, die nichts tut.

**Zweitens würde es auch angeschlossen nicht funktionieren.** Der Upload-Pfad legt einen
Blob an und schreibt `media[].blobId` (`contact-photo-upload.ts`, `ContactForm.tsx:787`).
Stalwart lehnt genau das ab — selbst nachgemessen:

```
ContactCard/set → notCreated: { "type": "invalidProperties",
  "description": "blobIds in media is not supported.", "properties": ["media"] }
```

Derselbe Aufruf mit `media[].uri` als `data:`-URI wird angenommen, gespeichert und
unverändert zurückgeliefert. Der Fix ist also nicht nur „die Prop durchreichen",
sondern zusätzlich das Format wechseln — mit der Folge, dass das Foto in der Karte
liegt statt im Blob-Speicher, also sparsam skaliert werden muss (`PHOTO_MAX_EDGE`
ist schon auf 512 px).

**Warum kein Test das gefangen hat:** `ContactForm.test.tsx:352` und `:374` rendern die
Komponente direkt und übergeben `uploadPhoto` selbst. Getestet ist die Komponente, nicht
ihre Verdrahtung — und der Fake-Uploader kann das Wire-Format des echten Servers nicht
prüfen. Beide Hälften des Fehlers liegen exakt in der Lücke zwischen Unit-Test und
fehlendem E2E-Test.

**Aufwand:** S für die Verdrahtung, M mit Formatwechsel und E2E-Absicherung.

### B-2 — Die Suche „alle Ordner" durchsucht auch Papierkorb und Spam

Bei Bereich `all` setzt der Client `filterScope = undefined` (`use-search.ts:60`), und
`search-query.ts:131` hängt die Ordnerbedingung nur an, wenn ein Ordner gesetzt ist.
Die Anfrage geht also ohne jede Ordnereinschränkung raus.

Stalwart kann `inMailboxOtherThan` (belegt in [C](berichte/C-mail-argumente.md)) — genau
der Operator, mit dem man Papierkorb und Spam ausnimmt. Wer nach einem alten Angebot
sucht, bekommt die gelöschte Fassung gleichberechtigt zwischen den gültigen.

**Aufwand:** S.

### B-3 — `SieveScript/validate` hat keinen Aufrufer, die Spezifikation behauptet das Gegenteil

FR-SIEVE-01 sagt: *„`SieveScript/validate` is bound and used before a save."* Gebunden ja
(`sieve-client.ts:176`), benutzt nein — die Methode `validate` des Clients hat **null**
Aufrufer. Dasselbe gilt für `deactivate` und `destroy`: Filter lassen sich weder
abschalten noch löschen, obwohl beides fertig implementiert ist.

Ein Regelwerk, das der Server ablehnt, fällt damit erst beim Speichern auf — oder gar
nicht.

**Aufwand:** S je Funktion.

### B-4 — Sieve-Regeln lassen sich nicht umsortieren

Bei Sieve **ist** die Reihenfolge die Semantik: Eine Regel mit `stop` beendet die
Verarbeitung, und was danach steht, greift nie. Der Regelbauer bietet keine
Umsortierung an. Wer die Reihenfolge korrigieren will, muss Regeln löschen und neu
anlegen.

**Aufwand:** M.

### B-5 — Adressbuch anlegen: Code vollständig, kein Aufrufer

`AddressBook/set` ist implementiert und typisiert, aber nur der `create`-Zweig, und den
ruft kein UI auf. Umbenennen, Löschen und Freigeben fehlen ganz. Wer ein zweites
Adressbuch will, kommt im Webmail nicht dorthin.

**Aufwand:** M.

### B-6 — Dateiliste der Wurzel bricht bei über 500 Knoten ab

`maxObjectsInGet` ist 500. Die Wurzelabfrage holt ungeblättert; wer mehr Knoten hat,
sieht den Rest nicht — ohne Hinweis, dass etwas fehlt.

**Aufwand:** M.

### B-7 — Dateien werden ohne Rückfrage gelöscht

Einziger Löschpfad der App ohne Bestätigung, und ohne Papierkorb dahinter.

**Aufwand:** S.

---

## P — Push & Benachrichtigungen

### P-1 — Push mit Absender und Betreff ist möglich; ADR-017 ist überholt **[Neu]**

Der wichtigste Fund der Erhebung.

Stalwart bietet seit **v0.16.16** `urn:ietf:params:jmap:emailpush`
(`draft-ietf-jmap-emailpush-03`) an. Der Push trägt damit die Nachrichtendaten selbst.
End-to-end nachgewiesen, Payload wörtlich am Endpunkt abgefangen:

```json
{"@type":"EmailPush","accountId":"b","emails":[{"from":[{"name":"Bob Beispiel",
"email":"bob@waxwing.test"}],"subject":"Rechnung 2026-08 faellig",
"preview":"Hallo Alice, anbei die Rechnung fuer August. …",
"receivedAt":"2026-08-21T16:16:25Z"}],"state":"sae"}
```

Mit echtem P-256-Schlüsselpaar kam derselbe Inhalt als `aes128gcm` und ließ sich nach
RFC 8188/8291 sauber entschlüsseln.

**Warum das zählt:** ADR-017 hat den inhaltslosen Banner („Neue Nachricht") gewählt und
die Variante mit Absender und Betreff als **L** verworfen — mit der Begründung, ein
`StateChange` trage keine Inhalte, also müsste der Service Worker die Nachricht selbst
nachladen: *„eine authentifizierte JMAP-Anfrage aus einem DOM-freien Worker, die das
Zugriffstoken, den AES-GCM-`SecretStore` und den OAuth-Refresh-Pfad mitzieht"*. Diese
Begründung trifft nicht mehr zu. Der Server liefert die Daten mit; der Worker braucht
**keine** Anmeldedaten und **keine** eigene Entschlüsselung (die macht der Browser).

**Was dabei zu beachten ist** — beides gemessen, beides nicht offensichtlich:

1. `EmailPush` **ersetzt** den `StateChange`, es kommt nie beides. Wer heute den
   `StateChange` zum Anstoßen der Synchronisierung nutzt, muss das umbauen.
2. Der `filter` unterdrückt nicht passende Nachrichten **vollständig** — dann kommt gar
   kein Push, auch kein `StateChange`. Der Ordnerfilter der Benachrichtigungen könnte
   also vom Client auf den Server wandern, was Akkulaufzeit spart, aber die
   Synchronisierung darf nicht daran hängen.
3. Budget 4096 Byte pro Push; `properties` sparsam wählen.
4. **Setzt v0.16.16 voraus.** Produktiv (v0.16.17) erfüllt; die Fixture (v0.16.14) nicht
   — siehe I-1.

**Aufwand:** M. Der Handshake und der Service Worker existieren bereits; es kommt die
Fallunterscheidung nach `@type` und die `emailPush`-Konfiguration dazu.

### P-2 — Kein `PushSubscription/changes`

Existiert serverseitig nicht (`unknownMethod`). **Kein Befund**, nur zur Vollständigkeit
festgehalten.

### P-3 — WebSocket (RFC 8887) wird nicht genutzt **[Neu]**

Stalwart bietet `urn:ietf:params:jmap:websocket` mit `supportsPush: true` an; ein echter
Handshake samt `WebSocketPushEnable` und eintreffenden `StateChange`-Nachrichten wurde
verifiziert. Waxwing nutzt stattdessen SSE (bewusst, ADR-005).

**Bewertung: kein Handlungsbedarf.** SSE erfüllt denselben Zweck, und ADR-005 hat die
Wahl begründet. Aufgenommen, damit die Frage nicht ein zweites Mal untersucht wird.

---

## S — Freigabe & Delegation

Serverseitig ist das die größte ungenutzte Fläche. Gemessen: `shareWith` funktioniert
auf **Mailbox, Calendar, AddressBook und FileNode**; das fremde Konto erscheint sofort in
der Session des Empfängers mit `isPersonal: false` und verschwindet beim Entzug wieder.
Jeder Typ hat einen eigenen, streng validierten Rechtesatz.

Waxwing kann davon: **Dateien freigeben.** Sonst nichts.

### S-1 — Eingehende Freigaben bleiben unsichtbar **[Neu]**

`ShareNotification/get|set|changes|query` liefert echte Benachrichtigungen mit
`changedBy`, `oldRights`, `newRights`. In Waxwing ist `ShareNotification/*` typisiert und
hat **null Aufrufstellen** außerhalb von `packages/jmap`.

Wer jemandem etwas freigibt, muss ihm also danebenher Bescheid sagen — im Client erfährt
es niemand.

**Aufwand:** M.

### S-2 — Kalender und Adressbuch lassen sich nicht freigeben **[Neu]**

`shareWith` fehlt in beiden Typen komplett. Für ein gemeinsam genutztes Postfach eines
Vereins oder einer kleinen Firma — ausdrücklich eine Zielgruppe der Spezifikation — ist
der geteilte Kalender die naheliegendste Erwartung überhaupt.

**Aufwand:** M je Typ, das Freigabe-UI der Dateien ist als Vorlage vorhanden.

### S-3 — Mailordner lassen sich nicht freigeben **[Neu]**

Dasselbe für `Mailbox`. Die Spezifikation nennt „shared mailboxes" ausdrücklich als
Bedarf der Zielgruppe *Small business / association*.

**Aufwand:** M.

### S-4 — Freigegebene Kalender, Kontakte und Dateien sind nicht zu öffnen **[Neu]**

Delegation wird nur im **Mail**-Bereich konsumiert (ein Sync-Motor je Konto,
`?account=`-Routen). Kalender, Kontakte und Dateien sind hart auf das eigene Konto
verdrahtet. Ein freigegebener Kalender erscheint zwar in der Session, ist im Client aber
nicht erreichbar.

Das ist die Kehrseite von S-2: Selbst wenn Waxwing das Freigeben könnte, ließe sich das
Ergebnis nicht ansehen.

**Aufwand:** M — die Kontoführung existiert bereits, sie muss auf die drei anderen
Bereiche ausgedehnt werden.

### S-5 — Kein Personenverzeichnis **[Neu]**

`Principal/get` liefert **ohne jede Freigabe** das komplette Verzeichnis der
Organisation. Waxwing nutzt das nur im Freigabe-Dialog der Dateien. Als Adressquelle
beim Verfassen — Kollegen finden, ohne die Adresse zu kennen — wird es nicht benutzt.

**Aufwand:** M.

### S-6 — Keine Frei/Belegt-Auskunft **[Roadmap V2]**

`Principal/getAvailability` (Capability `principals:availability`,
`maxAvailabilityDuration: P52W1D`) liefert echte Frei/Belegt-Zeiten kontoübergreifend —
verifiziert. Ohne das ist Terminplanung mit mehreren Personen Raten.

Die Roadmap führt „availability" bereits unter V2; hiermit ist belegt, dass der Server
es kann.

**Aufwand:** M, sinnvoll erst zusammen mit K-3 (Einladungen).

### S-7 — `Principal/set` darf nie in einen Sammelaufruf **[Neu, Falle]**

Kein `unknownMethod`, sondern HTTP 400 `notRequest` — und dabei fällt die **gesamte**
Anfrage aus, alle anderen Aufrufe im selben Batch inklusive. Waxwing ruft die Methode
heute nicht auf; festgehalten, damit das so bleibt.

**Aufwand:** keiner, nur wissen.

---

## K — Kalender

Der Kalender hat nach der Runde vom 21.08. Einzeltermine anlegen, ändern und löschen.
Alles Weitere fehlt.

### K-1 — Kalender lassen sich nicht anlegen, umbenennen, färben oder ausblenden **[Neu]**

`Calendar/set` ist typisiert und hat **null Aufrufer**; `Calendar/changes` ebenso. Der
Server nimmt `name`, `color`, `sortOrder`, `isVisible`, `isSubscribed`, `timeZone`,
`defaultAlertsWithTime`/`WithoutTime` und `shareWith` an, und die Session meldet
`mayCreateCalendar: true`.

Ein zweiter Kalender („Privat" neben „Arbeit") ist im Webmail nicht anlegbar, und ein
vorhandener nicht einmal ausblendbar.

**Aufwand:** M. Von allen Kalenderlücken das beste Verhältnis von Nutzen zu Aufwand.

### K-2 — Serientermine lassen sich nicht anlegen oder bearbeiten **[Roadmap]**

Bewusst so (`calendar-client.ts:150–160`: Serien bleiben schreibgeschützt, bis es einen
Bereichs-Editor gibt — „diesen Termin / alle künftigen / alle"). Die Begründung ist
gut, und der Schutz greift nachweislich über `recurrenceId`.

Aber siehe **K-6**: Das Wire-Format dafür ist ein anderes als gedacht.

**Aufwand:** L.

### K-3 — Keine Teilnehmer, keine Einladungen, kein RSVP **[Roadmap V2]**

Größte funktionale Lücke des Kalenders. `maxParticipantsPerEvent: 20` steht in der
Session.

**Wichtige Einschränkung, gemessen:** Stalwart **v0.16.14 verschickt keine
iMIP-Einladung** — kein Warteschlangeneintrag, keine Mail, nichts beim Eingeladenen,
auch nicht mit `sendSchedulingMessages: true`. Genau das steht in den Anmerkungen zu
**v0.16.18** als behoben: *„`CalendarEvent/set` does not assign `organizerCalendarAddress`
nor send scheduling messages when an event is created with participants."*

Wer dieses Feature baut, braucht also zwingend v0.16.18 und muss die Fixture vorher
anheben (I-1) — sonst testet man gegen einen Server, der nachweislich nicht einlädt.

**Aufwand:** L.

### K-4 — Kein ICS-Import und -Export **[Neu]**

Stalwart bietet `CalendarEvent/parse` an (Capability `calendars:parse`) — eine
`.ics`-Datei wird serverseitig zu JSCalendar geparst. Ungenutzt.

Eine Einladung aus einer fremden Mail lässt sich damit nicht in den Kalender übernehmen,
und ein Termin nicht weitergeben. Der Kontaktbereich hat sein Gegenstück (vCard-Import)
bereits, der Kalender nicht.

**Aufwand:** M.

### K-5 — Erinnerungen werden nicht einmal abgefragt **[Neu]**

`alerts` steht in keiner Property-Liste des Clients. Ein Termin mit einer im Handy oder
in Thunderbird gesetzten Erinnerung zeigt sie in Waxwing nicht an — und beim Speichern
einer Änderung überlebt sie nur, weil `draftToEvent()` bewusst ein Patch ist.

Anzeigen wäre S. Serverseitige Erinnerungen (Stalwart verschickt Alarm-Mails) sind davon
unberührt.

**Aufwand:** S für Anzeige, M für Bearbeitung.

### K-6 — Stalwart folgt `jscalendarbis`, Waxwing folgt RFC 8984 **[Neu, wichtig]**

Der Code notiert in `calendar-client.ts:63` eine ungeklärte Beobachtung: der gespeicherte
Serien-Master antworte *„WITHOUT `recurrenceRules` even when asked for it"* — „beide
werden geprüft, nur eines funktioniert". Die Ursache ist jetzt geklärt, nachgemessen:

| | |
|---|---|
| RFC 8984 §4.3.3 | `recurrenceRules: RecurrenceRule[]` (Plural, Array) |
| `draft-ietf-calext-jscalendarbis` | `recurrenceRule: RecurrenceRule` (Singular, Einzelobjekt) |
| **Stalwart** | **Singular** — beim Lesen *und* beim Schreiben |
| **Waxwing** (`types/calendar.ts:154`) | Plural |

Anlegen mit `recurrenceRules` scheitert mit `invalidProperties`; mit `recurrenceRule`
gelingt es, und das Lesen liefert ebenfalls Singular zurück.

Das ist kein Server-Fehler, sondern ein **Spezifikationsstand**: `jscalendarbis` soll
RFC 8984 ablösen. Heute schadet es nichts (Waxwing schreibt keine Serien und erkennt sie
über `recurrenceId`), aber K-2 läuft ohne diese Korrektur direkt in eine Wand.

**Zu prüfen:** ob weitere JSCalendar-Eigenschaften betroffen sind. Der Abgleich der
Typen gegen `jscalendarbis` ist noch nicht gemacht.

**Aufwand:** S für `recurrenceRule`, M für den vollständigen Abgleich.

### K-7 — `participants[].sendTo` ist im Typ falsch **[Neu, Falle]**

`types/calendar.ts:95` deklariert `sendTo`; Stalwart erwartet `calendarAddress` und
verwirft `sendTo` **ohne Fehlermeldung**. Heute folgenlos, weil nichts Teilnehmer
schreibt — aber eine stille Falle für K-3. Vermutlich dieselbe Ursache wie K-6.

**Aufwand:** S.

### K-8 — Kalender wird nicht offline gespiegelt **[Neu]**

`CalendarEvent/changes` ist typisiert und hat null Aufrufer; es gibt keine Replik. Mail
und Kontakte funktionieren offline, der Kalender nicht — ausgerechnet der Bereich, den
man im Zug oder im Aufzug ansieht.

**Aufwand:** L.

### K-9 — `CalendarEventNotification/*` bleibt unklar

Die Methoden existieren, lieferten aber in **jedem** Auslöser-Szenario eine leere Liste.
Ob Stalwart sie nur registriert hat oder ob der richtige Auslöser nicht gefunden wurde,
ist **ungeklärt** — ehrlich so vermerkt. Vor einem Feature darauf müsste das geklärt
werden.

### K-10 — `ParticipantIdentity/*` ungenutzt **[Neu]**

Regelt, unter welcher Adresse man in Kalendern auftritt — das Gegenstück zu `Identity`
im Mailbereich. Relevant erst mit K-3.

**Aufwand:** S, gebündelt mit K-3.

---

## A — Kontakte

Der Kontaktbereich ist gut abgedeckt: rund zehn JSCard-Feldgruppen ohne Datenverlust,
echte Gruppenkarten, vCard-4.0- und JSContact-Import/-Export, Suche lokal und
serverseitig, offline über die Outbox. Es bleibt:

### A-1 — Kontaktfotos: siehe **B-1**

Der schwerste Befund der Erhebung steht in Gruppe B, weil er ein Defekt ist und keine
Lücke.

### A-2 — `ContactCard/parse` ungenutzt **[Neu]**

Stalwart parst eine hochgeladene vCard serverseitig zu vollständigem JSContact.
Waxwing parst selbst (`packages/jscontact`). Das ist nicht falsch — der eigene Parser
funktioniert und arbeitet offline —, aber der Server könnte als Rückfall für Formate
dienen, an denen der eigene Parser scheitert.

**Bewertung: niedrige Priorität.** Aufgenommen der Vollständigkeit halber.

### A-3 — Kontakte lassen sich nicht zwischen Adressbüchern kopieren **[Neu]**

`ContactCard/copy` existiert. Ohne mehrere Adressbücher (B-5) ohnehin gegenstandslos.

**Achtung, gemessene Abweichung:** Bei `ContactCard/copy`, `CalendarEvent/copy` und
`FileNode/copy` muss der **Schlüssel der `create`-Map die Id des Quellobjekts sein** —
eine freie Creation-Id liefert `notFound`. `Email/copy` verhält sich dagegen
RFC-konform. Diese Inkonsistenz steckt im selben Server.

**Aufwand:** S, nach B-5.

### A-4 — Kontaktgruppe als Empfänger nicht auflösbar **[Neu]**

Gruppenkarten lassen sich anlegen und pflegen, aber eine Gruppe im Empfängerfeld wird
nicht zu ihren Mitgliedern aufgelöst. Die Funktion `expandGroup` existiert und hat
keinen Konsumenten. Damit ist der Hauptnutzen einer Verteilerliste nicht da.

**Aufwand:** S — die Auflösung existiert bereits.

### A-5 — URLs und Instant-Messaging nicht bearbeitbar **[Neu]**

Werden gelesen und beim Speichern bewahrt, aber im Formular gibt es kein Feld dafür.

**Aufwand:** S.

### A-6 — Server-Eigenart: Creation-Referenzen in `members` **[Neu, Falle]**

Eine Gruppe mit `members: {"#c1": true}` im selben `/set` wie ihre Mitglieder anzulegen
funktioniert **nicht** — Stalwart löst die Referenz nicht auf und legt eine kaputte
Gruppe an. Zwei Aufrufe nacheinander sind nötig.

**Aufwand:** keiner, nur wissen.

---

## M — Mail

Der am besten abgedeckte Bereich: Ordner-CRUD, Threads, Anhänge, Verfassen mit Undo,
serverseitig geplantes Senden, beliebige Keywords, Massenaktionen, Suche mit zwölf
Filterfeldern samt Snippets, `.eml`-Import, alles offline über die Outbox.

### M-1 — Suchbereich „alle Ordner": siehe **B-2**

### M-2 — Keine Suche nach Nachrichtengröße **[Neu]**

`minSize`/`maxSize` funktionieren serverseitig. Die App zeigt einen Quota-Balken, bietet
aber keinen Weg, die großen Nachrichten zu finden, wenn er voll ist. Genau dann sucht
man sie.

**Aufwand:** S.

### M-3 — Keine Suchoperatoren `OR` und `NOT`, kein `bcc:` **[Neu]**

Serverseitig alles vorhanden (`operator: "OR"`/`"NOT"`, `bcc`-Filter). Die Suchgrammatik
des Clients kennt nur UND-Verknüpfung.

**Aufwand:** M.

### M-4 — Kein „nur ungelesene Konversationen" **[Neu]**

`noneInThreadHaveKeyword` funktioniert serverseitig. Für einen vollen Posteingang eine
der wirksamsten Filterungen überhaupt.

**Aufwand:** S.

### M-5 — Ordner-Sortierung und -Abonnement bleiben lokal **[Neu]**

`sortOrder` und `isSubscribed` werden nie gesendet. Wer die Ordner am Rechner sortiert,
findet am Telefon die alte Reihenfolge vor. Der Server würde beides speichern.

**Aufwand:** S.

### M-6 — Selbst angelegte Ordner bekommen nie eine `role` **[Neu]**

Stalwart akzeptiert `archive`, `important`, `snoozed`, `scheduled`, `memos` — auch
nachträglich. Ohne `role` erkennt kein anderer Client (Telefon, Thunderbird) den Ordner
als Archiv.

**Aufwand:** S.

### M-7 — Keine Zustellbestätigung anforderbar **[Neu]**

DSN wird akzeptiert (`ret`, `notify`, `orcpt` in `rcptTo[].parameters`), die Session
meldet die Erweiterung. Der Client setzt sie nie.

**Aufwand:** M.

### M-8 — Sieve nutzt fünf von rund fünfzig Erweiterungen **[Neu]**

Stalwart meldet ~50 Sieve-Erweiterungen. Der Regelbauer nutzt fünf. Nicht genutzt und
unmittelbar nützlich: `envelope` (echter Umschlagabsender statt `From:`-Kopfzeile),
`spamtest` (Spam-Bewertung als Bedingung), `date` (zeitabhängige Regeln), `duplicate`
(Doppelte unterdrücken), `reject` (mit Begründung abweisen).

Nebenbei: „hat Anhang" ist derzeit ein `Content-Type`-contains-Behelf.

**Aufwand:** S je Erweiterung.

### M-9 — `$junk`/`$notjunk` werden nie gesetzt **[Neu]**

Spam wird nur durch Ordnerwechsel signalisiert. **Ungeklärt geblieben**, ob Stalwart aus
diesen Keywords lernt — vor einer Umsetzung zu prüfen. Verwandt: X-6.

### M-10 — Sortierung nach `sentAt` und `to` fehlt **[Neu]**

Beide stehen in `emailQuerySortOptions`. Im Ordner „Gesendet" ist die Sortierung nach
Empfänger die naheliegende.

**Aufwand:** S.

### M-11 — Kein Reply-To, keine Priorität, keine eigenen Kopfzeilen **[Neu]**

Der Composer bietet nichts davon; `EmailSubmission` kann `MT-PRIORITY` und `REQUIRETLS`.

**Aufwand:** S bis M.

### M-12 — RFC 9404 (`Blob/*`) wird gar nicht genutzt **[Neu]**

Aller Byte-Transfer läuft über die älteren RFC-8620-§6-Endpunkte; `Blob/get` wird in
`use-message-source.ts:18` ausdrücklich verworfen, und die `blob`-Capability kann nie in
ein `using` geraten.

`Blob/upload` kann serverseitig **zusammensetzen und schneiden** (ein `data`-Array aus
Text, Base64 und Blob-Referenzen mit `offset`/`length`) — verifiziert.

**Aber, gemessen:** Es greift `maxSizeRequest` (10 MB) inklusive Base64-Aufschlag, nicht
das in der Session genannte `maxSizeBlobSet` von 7,5 MB. 8 MB scheitern über
`Blob/upload` und gehen über `uploadUrl` durch. **Oberhalb von ~7 MB ist der
HTTP-Endpunkt zwingend** — der heutige Weg ist für Anhänge also der richtige.

**Bewertung: kein Handlungsbedarf**, festgehalten als geprüft und verworfen.

### M-13 — `Email/copy` mit `onSuccessDestroyOriginal` ist unbrauchbar **[Neu, Falle]**

Das Original bleibt nachweislich stehen. Waxwing nutzt `Email/copy` nicht; falls
kontoübergreifendes Verschieben je gebaut wird, ist das die Falle.

### M-14 — Falsche Angabe in der Session: `maxDelayedSend` **[Neu]**

Die Session meldet 2 592 000 s (30 Tage); der MTA riegelt bei 604 800 s (7 Tage) ab.
`scheduled-send.ts:36` klemmt bereits konservativ auf genau diesen Wert — **korrekt
gelöst**, hier nur als bestätigte Server-Ungenauigkeit vermerkt.

---

## D — Dateien

Nach der Runde vom 21.08. der am besten abgedeckte neue Bereich: Blättern, Ordner
anlegen, hoch- und herunterladen, umbenennen, löschen, Vorschau, und als einziges
Freigabe-UI der App eine RFC-9670-Freigabe mit drei Rollen.

### D-1 — Verschieben fehlt vollständig **[Neu]**

Der Server ändert `parentId` ohne Weiteres. Im Client gibt es keinen Weg, eine Datei in
einen anderen Ordner zu bringen — man kann Ordner anlegen, aber nichts hineinräumen.
Das entwertet die Ordner.

**Aufwand:** M (Zielauswahl; Ziehen und Ablegen ist laut ADR-012 ohnehin nur für den
Schreibtisch gedacht).

### D-2 — Keine Mehrfachauswahl, kein Sammel-Upload **[Neu]**

Nur eine Datei je Vorgang.

**Aufwand:** M.

### D-3 — Keine Suche **[Neu]**

`FileNode/query` unterstützt Filter; die Session meldet
`fileNodeQuerySortOptions: ["name","size","nodeType"]`.

**Aufwand:** S bis M.

### D-4 — Kein Offline **[Neu]**

`FileNode/changes` ist typisiert und hat null Aufrufer; es gibt keine Replik.

**Aufwand:** L.

### D-5 — Dateien nicht als Anhangquelle **[Roadmap V2+]**

Steht bereits in der Roadmap. Serverseitig ist nichts im Weg.

**Aufwand:** M.

### D-6 — Keine öffentlichen Links

Beidseitig nicht vorhanden: anonymer Download antwortet mit 401, und `shareWith` nimmt
keine Sonderwerte für „jeder". **Kein Befund** — der Server kann es nicht, also kann der
Client es nicht. Festgehalten, damit die Frage nicht erneut untersucht wird.

### D-7 — Server-Eigenart: `myRights` am Kindknoten **[Neu, Falle]**

Bei einer Ordnerfreigabe erbt der Download-Zugriff korrekt, aber `myRights` am
Kindknoten meldet trotzdem überall `false`. Wer die Rechte-Anzeige darauf stützt, zeigt
Falsches an.

---

## X — Stalwart-Selbstbedienung (proprietär)

`urn:stalwart:jmap` steht **auch im Benutzerkonto**, nicht nur beim Verwalter. Die
vollständige Typliste steht im Quellcode (`crates/jmap-proto/src/request/method.rs:358`,
117 Typen, jeweils `get`/`set`/`query`); alle 117 wurden als normaler Benutzer
abgetastet. **Genau sechs sind erreichbar** — der Rest antwortet `forbidden`.

**Einordnung vorweg:** Produktprinzip 6 lautet *„Standards over cleverness … keine
proprietären Server-Erweiterungen erforderlich; Stalwart-Besonderheiten sind
progressive Verbesserungen."* Alles hier Genannte gehört also hinter eine
Capability-Prüfung und muss bei anderen Servern unsichtbar bleiben. Die Kapitelüberschrift
der Spezifikation — „Self-service Server Features (via JMAP)" — passt trotzdem genau.

### X-1 — App-Passwörter verwalten **[Neu]**

`x:AppPassword/{get,set,query}`. Anlegen mit einmalig sichtbarem Geheimnis (`app_…`),
Ablaufdatum, IP-Freigabeliste und einschränkbaren Rechten
(`Inherit`/`Disable`/`Replace`). Als JMAP-Basic-Auth real funktionierend verifiziert.

Heute muss ein Benutzer dafür in Stalwarts eigene Verwaltungsoberfläche — genau die
Art Bruch, die die Spezifikation vermeiden will („vacation responder und sieve rules ohne
SSH").

**Bestes Verhältnis von Nutzen zu Aufwand in dieser Gruppe. Aufwand:** M.

### X-2 — Passwort ändern **[Neu]**

`x:AccountPassword/{get,set}`, `currentSecret` ist Pflicht. Echt durchgeführt und wieder
zurückgedreht.

**Aufwand:** S. Zusammen mit X-1 zu einem Abschnitt „Konto & Sicherheit".

### X-3 — 2FA/TOTP einrichten **[Neu, mit Warnung]**

`x:AccountPassword/set` mit `otpAuth`; der Client erzeugt Geheimnis und
`otpauth://`-URI. Abschalten verlangt Passwort und gültigen Code. Beides echt getestet.

**Warnung, gemessen:** Eingeschaltete 2FA **schaltet HTTP-Basic ab** (402 „MFA
required") — `mfa_token` wird nur beim OAuth-Login gefüllt, IMAP/POP3/Basic setzen hart
`None`. Wer 2FA anbietet, **muss** X-1 mitliefern, sonst sperrt sich der Benutzer aus
seinen anderen Mail-Programmen aus.

**Aufwand:** M, aber erst nach geklärter Anmelde-Geschichte. Nicht als erstes bauen.

### X-4 — Konto-Einstellungen: Sprache, Zeitzone, Verschlüsselung im Ruhezustand **[Neu]**

`x:AccountSettings/{get,set}`. Besonders die Zeitzone ist interessant, weil der Kalender
sie ohnehin braucht.

**Aufwand:** S.

### X-5 — Eigenen PGP-/S-MIME-Schlüssel hinterlegen **[Neu]**

`x:PublicKey/{get,set,query}`. Verschlüsselung im Ruhezustand wurde end-to-end belegt:
die zugestellte Nachricht war `multipart/encrypted` und ließ sich per `gpg` entschlüsseln.

Achtung: Das ist Verschlüsselung **im Ruhezustand auf dem Server**, nicht Ende-zu-Ende.
Waxwing kann verschlüsselte Nachrichten nicht lesen — wer das einschaltet, sperrt sich
aus seinem Webmail aus. Deshalb zunächst **nur als Anzeige**, nicht als Schalter.

**Aufwand:** S als Anzeige.

### X-6 — Eigene Spam-Trainingsproben einsehen und löschen **[Neu]**

`x:SpamTrainingSample/{get,query,set}` — kein `create`. Verwandt mit M-9.

**Aufwand:** S, geringer Nutzen.

### X-7 — Enterprise-gesperrt

`x:MaskedEmail` (Wegwerf-Adressen) und `x:ArchivedItem`: Rechte vorhanden, Funktion in
der offenen Fassung gesperrt. **Kein Befund**, festgehalten.

### X-8 — Falsche Angabe in der eigenen Doku **[Neu]**

`urn:stalwart:jmap` steht **nicht** in den obersten `capabilities`, nur in den
`accountCapabilities`. Die Aussage in `docs/implementation-plan.md:2598` ist im ersten
Halbsatz irreführend.

**Aufwand:** S, Textkorrektur.

---

## I — Infrastruktur & Hygiene

### I-1 — Die Testfixture ist älter als der Produktivserver **[Neu, blockiert mehrere Befunde]**

| | |
|---|---|
| Fixture (`docker-compose.yml:50`) | **v0.16.14-alpine** |
| Produktiv `mail.hcw-orange.media` | **v0.16.17** |
| Aktuell verfügbar | **v0.16.18** (17.08.2026) |

Das ist nicht bloß Pflegerückstand. Zwischen v0.16.14 und v0.16.18 hat Stalwart genau an
den hier geprüften Flächen etwas geändert:

- **v0.16.16** ergänzt `urn:ietf:params:jmap:emailpush` — **P-1 ist gegen die Fixture
  nicht testbar.**
- **v0.16.17** behebt: `FUTURERELEASE HOLDUNTIL` nahm Unix-Zeitstempel statt RFC-3339
  (der Client sendet RFC 3339, `scheduled-send.ts:100` notiert die 0.16.17-Untergrenze
  bereits ausdrücklich) — **zeitversetztes Senden ist gegen die Fixture nicht testbar**;
  außerdem: Konten mit `impersonate`-Recht bekamen ihre ACL-Freigaben nie eingesammelt,
  Freigaben tauchten also in keiner JMAP-Session auf.
- **v0.16.18** behebt: `CalendarEvent/set` vergibt keine `organizerCalendarAddress` und
  **verschickt keine Einladungen** — **K-3 ist gegen die Fixture nicht testbar** (und
  genau das wurde in dieser Erhebung als Fehlschlag gemessen); ferner
  `FileNode/changes`, das für einen Account ohne Änderungshistorie den eigenen
  `/get`-Zustand mit `cannotCalculateChanges` ablehnt — relevant für D-4 und K-8.

Zwei Dinge folgen daraus. Erstens: Mehrere Befunde dieser Liste lassen sich erst nach
einer Anhebung überhaupt bearbeiten. Zweitens, unangenehmer: **Waxwing wird heute gegen
einen Server getestet, der sich an mehreren Stellen nachweislich anders verhält als
der, auf dem er läuft.**

Es gibt bereits ein `main`-Profil, das `stalwartlabs/stalwart:latest` fährt — laut
Kommentar für einen geplanten Kompatibilitätslauf. Ob der eingerichtet ist, wurde hier
nicht geprüft.

**Empfehlung: Fixture auf v0.16.18 anheben, bevor P-1 oder K-3 angefasst werden.**
**Aufwand:** S für die Anhebung, plus ein Durchlauf der E2E-Suite.

### I-2 — Zehn typisierte Methoden ohne jeden Aufrufer **[Neu]**

`Core/echo`, `Mailbox/query`, `Mailbox/queryChanges`, `Calendar/set`, `Calendar/changes`,
`CalendarEvent/changes`, `FileNode/changes`, `ShareNotification/get`,
`ShareNotification/set`, `SieveScript/query`.

Sie sind nicht schädlich — aber jede erweckt beim Lesen den Eindruck, die Funktion
dahinter existiere. Sechs davon sind die Bausteine für K-1, K-8, D-4 und S-1; wer sie
dort einsetzt, räumt zugleich diesen Punkt ab.

### I-3 — Weitere Ungereimtheiten aus der Bestandsaufnahme

Der Bericht [B](berichte/B-waxwing-fläche.md) §7C nennt acht Request-Typen ohne
Registry-Eintrag und neun implementierte, aber unerreichbare Codepfade (darunter
B-1, B-3 und B-5 dieser Liste). **Nicht einzeln nachgeprüft** — vor dem Abarbeiten
zu verifizieren.

### I-4 — Die Spezifikation ist an mehreren Stellen überholt **[Neu]**

- FR-CAL-01 beschreibt den Kalender als „read-only"; seit dem 21.08. lassen sich
  Einzeltermine anlegen, ändern und löschen.
- FR-SIEVE-01 behauptet, `SieveScript/validate` werde vor jedem Speichern benutzt — es
  hat keinen Aufrufer (B-3).
- Die Roadmap führt „scheduled send (client-side)" unter V1.x; tatsächlich ist es
  serverseitig über FUTURERELEASE umgesetzt.

**Aufwand:** S, Textpflege.

### I-5 — Was ungeklärt blieb

Der Vollständigkeit halber, damit niemand es für geprüft hält:

- **K-9:** `CalendarEventNotification/*` lieferte in jedem Szenario leere Listen —
  Ursache offen.
- **M-9:** ob Stalwart aus `$junk`/`$notjunk` lernt.
- **K-3:** ob die fehlende iMIP-Einladung in v0.16.14 nur Konfigurationssache war; die
  Einstellungs-Endpunkte antworteten mit 404 und die Fixture durfte nicht neu starten.
  Die Anmerkungen zu v0.16.18 sprechen allerdings klar für einen Server-Fehler.
- Ob Freigaben an Gruppen-Principals bei deren Mitgliedern ankommen.
- `*/copy` über Kontogrenzen — hätte Schreibzugriff auf fremde Testkonten gebraucht.

Ein Nebenbefund aus der Erhebung selbst: Bei einem `ParticipantIdentity/set`-Versuch
wurde die Standard-Identität eines Testkontos zerstört und ließ sich wegen
schreibgeschütztem `isDefault` nur mit abweichender Id wiederherstellen. Das betraf nur
die ephemere Fixture.

---

## Vorschlag zur Reihenfolge

Keine Festlegung, sondern eine Leseempfehlung. Sortiert nach Nutzen je Aufwand.

**Zuerst — echte Defekte, klein:**
B-1 (Kontaktfoto), B-2 (Suche durchsucht Papierkorb), B-3 (Sieve-Validierung), B-7
(Löschen ohne Rückfrage).

**Dann — Voraussetzung für alles Weitere:**
I-1 (Fixture auf v0.16.18). Ohne diesen Schritt sind P-1 und K-3 nicht testbar.

**Dann — größter spürbarer Gewinn:**
P-1 (Push mit Absender und Betreff), K-1 (Kalender verwalten), D-1 (Dateien
verschieben), X-1 + X-2 (App-Passwörter und Passwortwechsel).

**Dann — das Freigabe-Paket**, das nur als Ganzes Sinn ergibt:
S-1, S-2, S-4 — freigeben, benachrichtigt werden, öffnen können.

**Später — die großen Brocken:**
K-3 (Einladungen und RSVP, setzt v0.16.18 und K-6/K-7 voraus), K-2 (Serien-Editor),
K-8/D-4 (Offline für Kalender und Dateien).

**Sinnvollerweise gebündelt:**
K-6 und K-7 gehören zusammen (`jscalendarbis`), X-1 bis X-4 sind ein Abschnitt „Konto &
Sicherheit", M-2/M-3/M-4/M-10 sind eine Runde Suchverbesserung.

---

## Nicht aufgenommen

Ausdrücklich geprüft und **kein** Handlungsbedarf, damit es nicht erneut untersucht wird:
P-3 (WebSocket — SSE erfüllt denselben Zweck, ADR-005), M-12 (RFC 9404 — der heutige
Weg ist für Anhänge der richtige), D-6 (öffentliche Links — der Server kann es nicht),
X-7 (Enterprise-gesperrt), M-14 (`maxDelayedSend` — bereits korrekt behandelt), sowie
`header`-Filter, `Mailbox/query`, `Quota/query`/`changes` und die exotischen
`headers:*`-Formen.
