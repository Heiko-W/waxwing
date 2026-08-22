# Waxwing — Bestandsaufnahme der tatsächlich angebotenen JMAP-Funktionalität

**Stand:** `main` @ `18d2115` (Merge PR #32, `fix/ui-walkthrough-2026-08`), sauberer Arbeitsbaum.
**Methode:** Statische Analyse. Aufrufstellen wurden über `Methods.<name>` **und** über rohe
Methodennamen-Strings (`'Typ/verb'`) gesucht; Testdateien (`*.test.*`, `test-support`,
`test-fakes`, `test-utils`) und `packages/*/dist` sind ausgeschlossen. Der Dev-Demo-Bereich
`apps/web/src/demo/` zählt **nicht** als Benutzerfunktion — er wird nur unter
`import.meta.env.DEV && VITE_WAXWING_DEMO === '1'` gerendert und in jedem Produktionsbundle
per Dead-Code-Elimination entfernt (`apps/web/src/main.tsx:39-58`).

**Registry-Umfang:** `packages/jmap/src/methods.ts` definiert **53** Methoden (nicht 52).
Davon werden **43** irgendwo im Produktionscode aufgerufen, **10** nirgends (§7).

---

## 0. Architektur in einem Absatz — wer ruft überhaupt JMAP auf?

Es gibt **zwei getrennte Zugriffswege**, und dieser Unterschied erklärt fast jede Lücke:

1. **Der Sync-Port** (`apps/web/src/sync/engine/port.ts`) — laut Kopfkommentar „the ONE module
   that speaks the `@waxwing/jmap` RequestBuilder DSL" (`port.ts:1-8`). Er deckt
   **ausschließlich Mail und Kontakte** ab: Mailbox/Thread/Email/EmailSubmission/SearchSnippet/
   Identity (`port.ts:98-322`) und AddressBook/ContactCard (`port.ts:324-458`). Nur diese Daten
   liegen in der IndexedDB-Replik (`apps/web/src/sync/db.ts:637-652`), nur sie sind offlinefähig,
   deltasynchronisiert und über die Outbox optimistisch schreibbar.
2. **Direkte Feature-Clients**, die den Sync-Motor umgehen: Kalender
   (`calendar/calendar-client.ts`), Dateien (`files/files-client.ts`), Sieve
   (`settings/sieve/sieve-client.ts`), Abwesenheit (`settings/vacation-client.ts`),
   Identitäten-Schreiben (`settings/identity-client.ts`), Quota (`quota/quota-client.ts`),
   Push (`notify/push-subscribe.ts`), geplante Sendungen (`outbox/scheduled-client.ts`),
   MDN (`mail/mdn-client.ts`), EML-Import (`mail/eml-import.ts`), `Email/parse`
   (`mail/use-parsed-message.ts`).
   **Alles davon ist online-only**: kein Offline-Cache, keine Delta-Synchronisation,
   kein optimistisches Schreiben, keine Outbox, kein Push-Trigger.

Der Kopfkommentar von `port.ts` ist damit **irreführend**: Der Port ist nicht die
Mail-Oberfläche, sondern nur ihr synchronisierter Teil. `Email/import`, `Email/parse`,
`EmailSubmission/query|get` und die MDN-Submission laufen an ihm vorbei.

**Push (`StateChange`) treibt nur fünf Typen an:**
`WATCHED_TYPES = ['Mailbox', 'Thread', 'Email', 'AddressBook', 'ContactCard']`
(`apps/web/src/sync/engine/engine.ts:100`). Kalender, Dateien, Submissions, Sieve, Quota und
Identitäten werden **nie** durch Push aktualisiert.

**Blobs: keinerlei RFC-9404-Nutzung.** Weder `Blob/upload`, `Blob/get` noch `Blob/lookup`
existieren im Registry. Sämtlicher Byte-Transfer läuft über die RFC-8620-§6-Endpunkte in
`packages/jmap/src/blob.ts` (`uploadBlob:93`, `downloadBlob:122`), angesprochen über
`client.upload`/`client.download`. Aufrufstellen:
`files/files-client.ts:166` + `:221`, `files/FilesPage.tsx:235` + `:315`,
`mail/eml-import.ts:70`, `settings/sieve/sieve-client.ts:91` + `:107`, `mail/use-blob.ts:37`,
`compose/use-attachment-upload.ts:40` (`makeBlobUploader`), `contacts/contact-photo-upload.ts`
(nur dokumentiert — siehe §3).
Die Ablehnung von `Blob/get` ist bewusst und begründet: `mail/use-message-source.ts:18`
(„base64-in-JSON bounded by `maxSizeRequest`"). Die Capability
`urn:ietf:params:jmap:blob` steht in `capabilities.ts:17` und im Prefix-Mapping (`:50`), kann
aber **nie** in ein `using` geraten, weil keine `Blob/*`-Methode existiert; sie wird nur im
Server-Panel als vorhanden/abwesend angezeigt (`settings/capabilities-model.ts:64`).

**Capability-Gating ist uneinheitlich.** Die Einstellungs-Abschnitte sind sauber gated
(`settings/SettingsPage.tsx:211/218/228`), die Hauptnavigation ist es **nicht**:
`app/shell/PrimaryNav.tsx:30-34` zeigt Mail, Kontakte, Kalender, Dateien, Einstellungen
bedingungslos. Die passenden Prüffunktionen existieren und haben **null Aufrufer**:
`serverSupportsCalendars` (`calendar/calendar-client.ts:524`), `serverSupportsFiles`
(`files/files-client.ts:261`). Auf einem Server ohne `filenode`/`calendars` sieht der Benutzer
also den Menüpunkt und landet auf einer Fehlerseite.
Zusätzlich fehlen `calendars` und `fileNode` in der Anzeigeliste des Server-Panels
(`settings/capabilities-model.ts:59-70`) — sie erscheinen dort unter „URNs this server
advertises that Waxwing does not know about" (`capabilities-model.ts:54`), was falsch ist.

**JMAP-über-WebSocket (RFC 8887) ist implementiert, aber im Browser abgeschaltet:**
`packages/jmap/src/push/websocket.ts` existiert vollständig, die Browser-Allowlist ist
`BROWSER_PUSH_TRANSPORTS = ['sse', 'polling']` (`sync/engine/engine.ts:121`, Begründung
`:105-111`: ein Browser kann den Upgrade nicht authentifizieren).

---

## 1. Mail

### Aufgerufene Methoden (Datei:Zeile)

| Methode | Aufrufstelle |
|---|---|
| `Mailbox/get` | `sync/engine/port.ts:151` |
| `Mailbox/changes` | `sync/engine/port.ts:98` |
| `Mailbox/set` | `sync/engine/port.ts:280` (einzige Stelle) |
| `Thread/get` | `sync/engine/port.ts:165` |
| `Thread/changes` | `sync/engine/port.ts:117` |
| `Email/get` | `sync/engine/port.ts:172` (Envelopes), `:188` (Bodies), `outbox/scheduled-client.ts:56` |
| `Email/changes` | `sync/engine/port.ts:134` |
| `Email/query` | `sync/engine/port.ts:206` |
| `Email/queryChanges` | `sync/engine/port.ts:228` |
| `Email/set` | `sync/engine/port.ts:268`, `:296` (im Send-Batch), `mail/mdn-client.ts:61`, `:91` |
| `Email/parse` | `mail/use-parsed-message.ts:53` |
| `Email/import` | `mail/eml-import.ts:83` |
| `SearchSnippet/get` | `sync/engine/port.ts:261` |
| `EmailSubmission/set` | `sync/engine/port.ts:303`, `mail/mdn-client.ts:74`, `outbox/scheduled-client.ts:87` |
| `EmailSubmission/query` | `outbox/scheduled-client.ts:41` |
| `EmailSubmission/get` | `outbox/scheduled-client.ts:49` |
| `Identity/get` | `sync/engine/port.ts:158`, `settings/identity-client.ts:89` |

### Kann

- **Ordner:** anlegen, umbenennen, verschieben (reparent, auch per Drag&Drop), löschen —
  `mail/use-folder-actions.ts:42-50` → Outbox-Intents → `Mailbox/set`
  (`sync/engine/outbox.ts:1788-1801`). UI: `mail/FolderTree.tsx:203-317`, Rechte-gated über
  `myRights` (`mail/FolderTreeView.tsx:348/355/365/420`). Update/Delete mit `ifInState`
  (`outbox.ts:167-179`). „Papierkorb/Junk leeren" und „Älter als … löschen"
  (`FolderTree.tsx:319-346`) — **nicht** outbox-gestützt (`FolderTree.tsx:145-165`).
- **Liste:** Fenster über `Email/query` + `Email/get` + `Thread/get`
  (`sync/engine/backfill.ts:96-118`), Infinite Scroll je 50 (`mail/use-message-list.ts:47`),
  Sortierung nach Datum/Absender/Betreff/Größe + „Ungelesene zuerst"
  (`use-message-list.ts:50-63`, UI `MessageList.tsx:986-1026`), serverseitiges
  `collapseThreads` als Umschalter „Konversationen/Flach" (`use-message-list.ts:75`).
- **Lesen:** sanitisiertes HTML im Sandbox-iframe (`mail/MailBodyFrame.tsx`), Plaintext mit
  Zitat-Faltung (`MessageView.tsx:493`), Remote-Content-Sperre mit Absender-Allowlist,
  Link-Warnung, Konversationsansicht (`Conversation.tsx:32-38`), Auth-Results (SPF/DKIM/DMARC),
  Quelltext ansehen + als `.eml` speichern (`use-message-source.ts`), Drucken, Vollbild,
  Lesebestätigung senden (`mail/mdn-client.ts`), List-Unsubscribe inkl. RFC-8058-One-Click.
- **Anhänge:** Download einzeln + „Alle als ZIP" (`AttachmentList.tsx:142/315`), Inline-Vorschau
  nach Policy, TNEF/`winmail.dat`-Entpacken (`:301-308`), Inline-Bilder über `cid:`→`blob:`
  (`useInlineImages.ts`), verschachtelte `message/rfc822` über **`Email/parse`**
  (`AttachmentList.tsx:282-296`).
- **Verfassen/Senden:** Entwurfs-Autosave (create-neu + destroy-alt in einem `Email/set`,
  `use-draft-sync.ts:99-131`), atomares Senden (`Email/set` + `EmailSubmission/set` mit
  `#creationId`-Rückverweis und `onSuccessUpdateEmail` Drafts→Sent, `port.ts:290-322`),
  Undo-Send über `notBefore`-Karenz (0/5/15/30 s, `compose-prefs.ts:24`), **serverseitig
  geplantes Senden** (SMTP FUTURERELEASE / `HOLDUNTIL`, `compose/scheduled-send.ts:24`) inkl.
  Liste + Abbrechen unter Einstellungen → „Geplant" (`outbox/scheduled-client.ts:39-90`,
  gemountet `settings/SettingsPage.tsx:372`), Rich-Text (Squire), Vorlagen, Signaturen je
  Identität, Anhänge per Upload-Endpunkt, Empfängervorschläge aus Kontakten + Verlauf,
  `mailto:`-Handling.
- **Flags:** `$seen`, `$flagged` und **beliebige eigene Keywords als „Labels"**
  (`labels/LabelMenu.tsx:131-134`, Registry in `labels/use-labels.ts:104-138`).
  `$snoozed` per Snooze-Presets (`MessageView.tsx:616-620`).
  `$answered`/`$forwarded`/`$draft`/`$mdnsent` werden automatisch gesetzt.
- **Verschieben/Löschen:** Einzel- und Massenaktionen (Lesen/Ungelesen, Archiv, Papierkorb,
  endgültig löschen mit Bestätigung, Flag, Junk, In Ordner verschieben, Label entfernen —
  `MessageList.tsx:1250-1377`), Drag&Drop, Wischgesten, Undo-Toast für Verschiebungen
  (`use-triage.ts:108-121`).
- **Suche:** `from`, `to`, `cc`, `subject`, `body`, `has:attachment`, `is:read/unread`,
  `is:flagged`, `in:<folder>`, `before`, `after`, Freitext `text`
  (`mail/search/search-query.ts:17-28`, `:147-182`); `SearchSnippet/get` für den sichtbaren
  Ausschnitt (`search/use-snippets.ts:44-57`).
- **Import:** `.eml` in einen Ordner, erreichbar über das Ordner-Kontextmenü („Importieren",
  gated auf `mayAddItems`, `FolderTreeView.tsx:387-393`), Ziel = der Ordner des Menüs
  (`FolderTree.tsx:352-354`). Upload → `client.upload(type: 'message/rfc822')` → `Email/import`
  (`eml-import.ts:70-98`). 50 MB Deckel, `$seen` bewusst nicht gesetzt.
- **Offline:** Mail ist der einzige Bereich mit voller Replik + Outbox — Lesen, Flaggen,
  Verschieben, Löschen, Entwürfe und Senden funktionieren offline und werden nachgespielt.

### Kann nicht

- **Ordner abonnieren/abbestellen.** `isSubscribed` existiert nur als DB-Spalte
  (`sync/db.ts:120`) und als optimistischer lokaler Default (`outbox.ts:1418`, `:1464`); keine
  UI, kein `Mailbox/set`-Update sendet es je.
- **`role` und `sortOrder` setzen.** Der `createMailbox`-Intent typisiert ein optionales `role`
  (`outbox.ts:101-109`) und würde es weiterreichen (`outbox.ts:1790`) — der einzige Dispatcher
  übergibt nur `{name, parentId}` (`use-folder-actions.ts:42-47`). `sortOrder` ist optimistisch
  auf `0` verdrahtet (`outbox.ts:1412`) und wird nie gesendet.
- **`Mailbox/query` / `Mailbox/queryChanges`** werden nirgends benutzt — Mailboxen werden
  immer ganz geholt (`Mailbox/get {ids:null}`) und per `Mailbox/changes` fortgeschrieben.
  Bei sehr großen Ordnerbäumen gibt es keine serverseitige Filterung/Paginierung.
- **Composer:** kein Reply-To-Feld (nur über die Identität geerbt,
  `use-draft-sync.ts:216-218`), keine Lesebestätigung **anfordern**, kein Senden aus einem
  delegierten Konto (bewusst, ADR-020), keine Priorität/Wichtigkeit, keine eigenen Header,
  kein PGP/S/MIME-Signieren oder -Verschlüsseln, kein manueller „Jetzt speichern"-Knopf.
- **PGP/S/MIME:** nur Erkennung und Erklärung der MIME-Struktur
  (`mail/encrypted-message.ts`) — **keine** Signaturprüfung, **keine** Entschlüsselung
  (bewusst offen, `docs/implementation-plan.md:2589-2600`).
- **Snooze:** kein manuelles Aufwecken, keine „Zurückgestellt"-Ansicht; die Weckzeit ist eine
  **lokale** Pref (`mail/snooze.ts:19`) und das Aufwecken läuft nur, solange die App offen ist
  (`use-snooze.ts:87-99`). Auf einem zweiten Gerät wacht die Nachricht nie auf.
- **Label-Umbenennen** ändert nur einen lokalen Anzeigenamen — das Wire-Keyword ist unveränderlich
  (`use-labels.ts:71`).
- **Gespeicherte Suchen** sind rein lokal (`localPrefs['search.saved']`, max. 20,
  `search/saved-searches.ts:9-16`) — nicht serverseitig, nicht geräteübergreifend.
- **Suchfelder ohne UI:** `bcc`, `header`, `minSize`/`maxSize`,
  `allInThreadHaveKeyword`/`someInThreadHaveKeyword`/`noneInThreadHaveKeyword`, beliebige
  `hasKeyword` außer seen/flagged, sowie OR/NOT (der Parser verknüpft nur mit AND,
  `search-query.ts:138`).
- **Kein Unified Inbox** über mehrere Konten (FR-MBX-05 offen,
  `docs/implementation-plan.md:2565-2568`).
- **Kein Export** eines Ordners/Postfachs; Import nur einzeldateiweise, ohne mbox/ZIP.
- **Kein Undo** für endgültiges Löschen, für Keyword-Änderungen oder für Ordneroperationen.
- **Dateien als Anhangquelle** (die einzige Files-Anforderung der Spezifikation,
  `docs/functional-specification.md:628`) ist **nicht** gebaut: der Composer kennt nur lokale
  `File`-Objekte, kein `FileNode` (Grep über `apps/web/src/compose`).

---

## 2. Kalender

### Aufgerufene Methoden

| Methode | Aufrufstelle |
|---|---|
| `Calendar/get` | `calendar/calendar-client.ts:371` |
| `CalendarEvent/query` | `calendar/calendar-client.ts:388` (mit `expandRecurrences:true`), `:400` |
| `CalendarEvent/get` | `calendar/calendar-client.ts:393`, `:401`, `:456` |
| `CalendarEvent/set` | `calendar/calendar-client.ts:433` (create), `:441` (update), `:457` (destroy), `:475` (restore) |

### Kann

- `/calendar` bzw. `/calendar/:isoDate` öffnen (`app/route/route.ts:103-108`).
- Zwischen **Monat / Woche / Agenda** umschalten (`CalendarPage.tsx:70-73`), monats- bzw.
  wochenweise blättern, „Heute", Tag auswählen, „+N weitere"-Tagesliste öffnen.
- Einen **einzelnen, nicht wiederkehrenden** Termin anlegen und bearbeiten. Felder im Dialog:
  Titel (`EventDialog.tsx:149`), Start (`:161`), Ganztägig (`:173`), **Dauer in Minuten**
  (`:187`), Kalender-Auswahl (`:209`), Notizen (`:226`).
- Löschen mit Undo-Toast (`CalendarPage.tsx:279-312`; Snapshot + destroy in einer Anfrage
  `calendar-client.ts:446-467`, Wiederherstellung `:469-478`).
- Serientermine **lesen** — die Expansion macht der Server (`expandRecurrences`), die lokale
  Zeitrechnung inkl. DST-Korrektur macht `calendar/jscalendar-time.ts:80-126`.
- Ort und Teilnehmer **anzeigen** (`EventFacts.tsx:26-42`).
- Abweichende Zeitzone eines Termins **anzeigen**, nur in der Agenda
  (`jscalendar-time.ts:146-153`, `CalendarPage.tsx:787-789`).

### Kann nicht

- **Kalender verwalten.** `Calendar/set` und `Calendar/changes` werden **nirgends** aufgerufen.
  Es gibt keine Kalenderliste als UI-Element — `Calendar/get` füllt nur das Auswahlfeld im
  Termindialog (`CalendarPage.tsx:197` → `EventDialog.tsx:209-224`). Kein Anlegen, Umbenennen,
  Umfärben, Löschen, Abonnieren, Freigeben.
- **Kalender ein-/ausblenden** — nicht einmal clientseitig. `eventsInRange` akzeptiert
  `calendarIds` (`calendar-client.ts:125`, `inCalendars` `:378-384`), die einzige Aufrufstelle
  übergibt nichts (`CalendarPage.tsx:196`). Alle Kalender sind immer sichtbar und optisch nicht
  unterscheidbar — `Calendar.color` wird nicht gelesen.
- **Serien bearbeiten.** `isEditable` verweigert jeden Termin mit `recurrenceId` oder nicht
  leerem `recurrenceRules` (`calendar-client.ts:156-160`, `refuseEdit` `:174-178`); die UI zeigt
  stattdessen einen Nur-Lese-Dialog (`CalendarPage.tsx:548-564`). `recurrenceOverrides` wird nie
  geschrieben oder gelesen. Es gibt keinen „dieser Termin / dieser und folgende / alle"-Dialog.
  **Wiederholungsregeln können auch nicht neu angelegt werden.** Bewusste Auslassung, siehe
  `docs/implementation-plan.md:2571-2575`.
- **Endzeitpunkt** wählen: es gibt nur „Dauer in Minuten"; ganztägige Termine sind immer genau
  ein Tag (`EventDialog.tsx:125`, `calendar-client.ts:189` → `'P1D'`). Mehrtägige
  Ganztagstermine kann man nicht anlegen.
- **Teilnehmer/Einladungen.** Keine Attendee-Bearbeitung, kein `participationStatus`, kein
  Zusagen/Absagen, kein iTIP/iMIP, keine `CalendarEventNotification`, keine
  `ParticipantIdentity`. Auch in Mail gibt es keine `.ics`/`text/calendar`-Erkennung.
  Begründung im Code: `EventFacts.tsx:9-14`.
- **Erinnerungen.** `alerts` wird nicht einmal abgefragt — siehe die Property-Liste
  `EVENT_PROPERTIES` (`calendar-client.ts:215-228`).
- **Zeitzone wählen.** Beim Speichern hart auf die Browserzone verdrahtet
  (`EventDialog.tsx:141`); `Calendar.timeZone` wird ignoriert.
- **Weitere JSCalendar-Felder:** `locations` (nur lesen), `freeBusyStatus`, `privacy`, `status`,
  `categories`/`keywords`, `virtualLocations`, Farbe, `uid` — nichts davon ist editierbar. Der
  Patch schreibt genau `@type, calendarIds, title, description, start, duration,
  showWithoutTime, timeZone` (`calendar-client.ts:181-203`).
- **ICS-Import/-Export:** existiert nicht (repoweite Suche nach `.ics`, `BEGIN:VCALENDAR`,
  `VEVENT` findet nur Kommentare).
- **Frei/Gebucht, Verfügbarkeit, Principals:** nichts. `Principal/getAvailability` ist nicht
  einmal typisiert.
- **Offline/Sync:** `CalendarEvent/changes` wird nie aufgerufen; `grep -ri calendar
  apps/web/src/sync/` liefert **nichts**. Jeder Monatswechsel und jeder erfolgreiche Schreibvorgang
  löst ein vollständiges Neuladen aus (`CalendarPage.tsx:187-206`, `:238`). Offline ist die
  gesamte Schreiboberfläche deaktiviert (`CalendarPage.tsx:262-274`).
- **Die Ansicht ist nicht Teil der URL** (`const [view, setView] = useState('month')`,
  `CalendarPage.tsx:115`) — sie fällt bei jedem Neuladen auf „Monat" zurück.
- Eine **Tagesansicht** gibt es nicht; `WeekView.tsx:2` behauptet „week and day views", bekommt
  aber immer 7 Tage (`CalendarPage.tsx:327`, `:525-532`).

> Anmerkung: `docs/functional-specification.md:454-465` ist an dieser Stelle **veraltet** — dort
> steht noch „Monatsraster und Agenda, read-only". Wochenansicht und Einzeltermin-Schreiben sind
> seither in M5.11/M5.13 dazugekommen (`docs/implementation-plan.md:2377-2378`).

---

## 3. Kontakte

### Aufgerufene Methoden

| Methode | Aufrufstelle |
|---|---|
| `AddressBook/get` | `sync/engine/port.ts:328` |
| `AddressBook/changes` | `sync/engine/port.ts:335` |
| `AddressBook/set` | `sync/engine/port.ts:352` — **nur mit `create`** (`outbox.ts:1811-1814`) |
| `ContactCard/get` | `sync/engine/port.ts:364` |
| `ContactCard/changes` | `sync/engine/port.ts:380` |
| `ContactCard/query` | `sync/engine/port.ts:397` |
| `ContactCard/queryChanges` | `sync/engine/port.ts:418` |
| `ContactCard/set` | `sync/engine/port.ts:450` |

### Kann

- **Karten:** anlegen, bearbeiten, löschen — `contacts/use-contact-actions.ts:45/50/54` →
  Outbox → `ContactCard/set`. Optimistisch, `ifInState`-geschützt, mit
  CreationId→ServerId→`uid`-Abgleich (`ContactsScreen.tsx:110-211`). Rechte-gated über
  `myRights.mayWrite`.
- **Editierbare JSCard-Felder** (`ContactForm.tsx`): Namensbestandteile
  Titel/Vorname/2. Vorname/Nachname/Namenszusatz (`:257-300`), E-Mails mit Typ (`:320-355`),
  Telefone mit Typ (`:356-384`), Adressen (Straße, PLZ, Ort, Region, Land + Typ) (`:385-417`),
  Organisation + Position (`:418-441`), Geburtstag (`:442-456`), Notizen (`:457-496`).
- **Nichts geht beim Speichern verloren:** der Patch nennt nur `CONTROLLED_PROPS`
  (`contact-card-mapping.ts:254-286`), unbekannte Top-Level-Properties reiten durch
  (`:236-252`), nicht dargestellte Namensbestandteile werden wieder angehängt (`:337-339`).
- **Gruppen** sind echte JSCard-Karten mit `kind: 'group'` und `members` nach `uid`
  (`contact-group-mapping.ts:38-46`, `:96-110`): anlegen (`GroupRail.tsx:31-41`), umbenennen +
  Mitglieder hinzufügen/entfernen (`GroupForm`), löschen mit Bestätigung
  (`ContactsScreen.tsx:381-385`). Der Patch enthält nur `name`/`members`
  (`contact-group-mapping.ts:113-134`).
- **Import/Export in beiden Richtungen, vCard 4.0 und JSContact-JSON**
  (`contact-io.ts:32`): Import über die Werkzeugleiste (`ContactsScreen.tsx:329-331`), mit
  Dubletten-Erkennung (bevorzugte E-Mail, dann `uid`), Zielbuch-Auswahl und Deckel
  `MAX_IMPORT_CARDS = 1000`. Export für die offene Karte, die gewählte Gruppe oder das
  sichtbare Buch (`ContactsScreen.tsx:152-170`).
- **Suche:** lokal sofort über die Replik (`contact-fields.ts:118-134`) plus serverseitig
  `ContactCard/query` mit `inAddressBook` und `text` (`use-contact-search.ts:41-48`).
- **Foto anzeigen** über den authentifizierten Download-Endpunkt mit Write-Through-Cache
  (`use-contact-photo.ts`); vorhandenes Foto **entfernen** geht (`ContactForm.tsx:797-800`).
- **Offline:** vollständig repliziert (`sync/db.ts:729-730`), deltasynchronisiert
  (`sync/engine/delta.ts:444-546`) und über die Outbox offline schreibbar.
- Mail-Integration: „Absender zu Kontakten hinzufügen", Hover-Karte, Composer-Autovervollständigung.

### Kann nicht

- **Adressbücher verwalten.** `AddressBook/set` wird ausschließlich mit `create` aufgerufen
  (`outbox.ts:1811-1814`). Es gibt **keine** Intents `renameAddressBook`/`deleteAddressBook` —
  der Kommentar sagt es ausdrücklich: „AddressBook update/delete are deliberately NOT part of
  this stage (5a)" (`outbox.ts:139-142`). Die `update`/`destroy`-Zweige in
  `port.setAddressBooks` (`port.ts:350-360`, Signatur `types.ts:206-212`) sind tote Pfade.
- **Adressbuch anlegen ist gebaut, aber unerreichbar.** `enqueueCreateAddressBook`
  (`sync/engine/contact-mutations.ts:31`) ist implementiert, getestet und re-exportiert
  (`sync/engine/index.ts:28`) — **kein einziger UI-Aufrufer**.
  `contacts/AddressBookList.tsx` ist eine reine Liste; ihr eigener Kopfkommentar sagt
  „create/edit land in a later stage" (`:7`).
- **Adressbuch freigeben:** `shareWith` wird nur gelesen, um ein „Geteilt"-Abzeichen zu
  zeichnen (`AddressBookList.tsx:72-75`). Kein Schreibpfad.
- **Kontaktfoto hochladen ist in der ausgelieferten App tot.** Die gesamte Maschinerie
  existiert (`contact-photo-upload.ts`: `scalePhoto`, `PhotoUploader`), aber
  `ContactsScreen.tsx:419-435` übergibt `uploadPhoto` **nicht**, und
  `ContactForm.tsx:812` schaltet das Dateifeld ohne Uploader dauerhaft ab
  (`disabled={uploader === undefined || busy}`). Einzige `uploadPhoto=`-Aufrufer:
  `ContactForm.test.tsx:352` und `:374`. **Der „Foto wählen"-Knopf ist im Produktivbetrieb
  permanent deaktiviert.**
- **URLs/Links** werden geholt und bewahrt, aber weder angezeigt noch bearbeitet
  (`ContactDetail.tsx:183-246`). **IM/`onlineServices`** ist auf keiner Ebene modelliert
  (fehlt in `packages/jscontact/src/types.ts:222-245` und in `CONTACT_CARD_PROPERTIES`,
  `sync/engine/types.ts:255-278`) — überlebt nur als opakes `vCardProps`.
- Weitere nicht abgefragte JSContact-Felder: `preferences`, `cryptoKeys`, `directories`,
  `localizations`, `speakToAs`, `calendars`, `schedulingAddresses`, `personalInfo`, `relatedTo`.
- **Gruppen in Empfänger auflösen** ist gebaut, aber ungenutzt: `expandGroup`/
  `expandGroupMembers` (`contacts/expand-group.ts`, exportiert `contacts/index.ts:19`) hat
  keinen Konsumenten; `compose/contact-suggestion-source.ts:85` überspringt Gruppenkarten
  ausdrücklich. **Man kann keine Kontaktgruppe als Empfänger verwenden.**
- **Gruppenauswahl ist lokaler State, keine Route** (`GroupRail.tsx:1-7`) — geht beim Neuladen
  verloren, kein Deep-Link.
- **Kein CSV-Import** (FR-CON-06-Rest, `docs/implementation-plan.md:2569`), **keine
  automatisch gesammelten Adressen** (FR-CON-07).
- **Foto-Export:** Karten mit reinem `blobId`-Foto verlieren es beim Export
  (`contact-io.ts:21-24`).

---

## 4. Dateien

### Aufgerufene Methoden

| Methode | Aufrufstelle |
|---|---|
| `FileNode/query` | `files/files-client.ts:114` |
| `FileNode/get` | `files/files-client.ts:148` (Back-Reference auf die Query) |
| `FileNode/set` | `files/files-client.ts:171` (Upload-create), `:197` (Ordner-create), `:207` (rename), `:214` (destroy), `:253` (`shareWith`) |
| `Principal/query` | `files/files-client.ts:237` |
| `Principal/get` | `files/files-client.ts:243` |

### Kann

- Ordner durchblättern mit Brotkrumen (`FilesPage.tsx:270-283`, `:512-521`).
- Ordner anlegen (`FilesPage.tsx:286-355` → `files-client.ts:193-200`).
- **Eine** Datei hochladen (verstecktes `<input type=file>`, `FilesPage.tsx:296-316`) —
  zweistufig: Bytes an den Upload-Endpunkt, dann `FileNode/set create` mit der zurückgegebenen
  `blobId` (`files-client.ts:165-182`).
- Herunterladen (`FilesPage.tsx:236-249` → `client.download`).
- Umbenennen, gated auf `myRights.mayRename` (`FilesPage.tsx:463-479`).
- Löschen, gated auf `myRights.mayDelete` (`FilesPage.tsx:492-503`).
- **Freigeben (RFC 9670)** — das einzige Sharing-UI der ganzen Anwendung
  (`files/ShareDialog.tsx`): bestehende Freigaben sehen (`sharing.ts:86-93`), Rolle ändern,
  entziehen (`ShareDialog.tsx:172-181`), neu vergeben über eine Personensuche
  (`Principal/query` + `Principal/get`, entprellt 250 ms). Drei Rollen über sechs
  `FileNodeRights`-Flags (`sharing.ts:36-64`): `viewer` = `mayRead`; `editor` = + `mayAddChildren`,
  `mayRename`, `mayDelete`, `mayModifyContent`; `manager` = + `mayShare`.
- Inline-Vorschau (Bilder im `<img>`, Rest im `sandbox=""`-iframe, `FilesPage.tsx:558-575`).
- Namensprüfung vorab gegen die Server-Capability (`FilesPage.tsx:222-229`).

### Kann nicht

- **Verschieben/Umhängen existiert nicht.** Das `FilesClient`-Interface
  (`files-client.ts:52-71`) kennt `list`, `upload`, `createFolder`, `rename`, `destroy`,
  `download`, `searchPrincipals`, `setShareWith` — **keine** Move-Methode. `rename` sendet
  ausschließlich `update: {[id]: {name}}` (`:207`); `parentId` wird nur beim `create`
  geschrieben (`:178`, `:197`). Kein Drag&Drop, kein Ausschneiden/Einfügen, kein „Verschieben
  nach…". Der Kopfkommentar sagt es: „Not a two-pane manager with drag-and-drop — that is the
  part that needs a second milestone" (`files-client.ts:5-7`).
- **Kein Offline, kein Delta.** `FileNode/changes` wird **nie** aufgerufen; es gibt keine
  FileNode-Tabelle in `sync/db.ts`. Nach jedem Schreibvorgang wird die Ebene neu geholt
  (`FilesPage.tsx:158-173`, `:199-221`). Offline sind alle Werkzeugknöpfe deaktiviert.
- **Löschen ohne Rückfrage** (`FilesPage.tsx:492-503`) — anders als bei Kontakten und Gruppen.
- **Keine Capability-Prüfung.** `serverSupportsFiles` (`files-client.ts:261`) hat null Aufrufer;
  der Menüpunkt erscheint auf jedem Server, und ohne `filenode` landet man auf
  `files.loadFailed` mit Wiederholen-Knopf (`FilesPage.tsx:404-417`).
- **Wurzelliste kann unvollständig sein.** Stalwart 0.16 lehnt `filter:{parentId:null}` ab und
  weist damit die *gesamte* Anfrage mit HTTP 400 ab; die Lösung ist, an der Wurzel **gar keinen
  Filter** zu senden und clientseitig auf die Ebene zu filtern (`files-client.ts:116-140`,
  `:154-156`). Das `limit: 500` gilt dann für den ganzen Baum — bei größeren Konten fehlen
  Einträge. Vollständig dokumentiert im Code.
- **Keine Mehrfachauswahl**, kein Mehrfach-Upload, kein Ordner-Upload, keine Suche, keine
  Sortierumschaltung (fest: Ordner zuerst, dann Name, `files-client.ts:143-146`).
- **Keine beliebigen Rechtekombinationen:** eine von außen gesetzte Freigabe, die zu keiner
  Rolle passt, wird als `custom` angezeigt, ist **nicht** änderbar, nur entziehbar
  (`ShareDialog.tsx:145-149`).
- **Keine Anbindung an Mail** — weder „Anhang in Dateien speichern" noch „Datei aus Dateien
  anhängen". Letzteres ist die einzige Files-Anforderung, die die Spezifikation überhaupt
  kennt (`docs/functional-specification.md:628`, „V2+").
- Die Spezifikation kennt **keine** FR-FILE-Anforderung; der Bereich ist nachträglich in
  M5.7/M5.17/M5.18 entstanden und in der Coverage-Matrix nicht abgebildet.

---

## 5. Einstellungen

`settings/SettingsPage.tsx:258-433` definiert 5 Gruppen mit 14 Abschnitten. Nicht unterstützte
Abschnitte werden **gar nicht** gerendert (`:211-232`, `:435-437`).

### Aufgerufene Methoden

| Methode | Aufrufstelle |
|---|---|
| `Identity/get` | `settings/identity-client.ts:89` |
| `Identity/set` | `settings/identity-client.ts:97` |
| `VacationResponse/get` | `settings/vacation-client.ts:55` |
| `VacationResponse/set` | `settings/vacation-client.ts:68` |
| `SieveScript/get` | `settings/sieve/sieve-client.ts:99` |
| `SieveScript/set` | `settings/sieve/sieve-client.ts:161` (save/activate), `:184`+`:195` (deactivate), `:199` (destroy) |
| `SieveScript/validate` | `settings/sieve/sieve-client.ts:176` — **von keiner UI erreicht** |
| `Quota/get` | `quota/quota-client.ts:25` |
| `PushSubscription/get` | `notify/push-subscribe.ts:120` |
| `PushSubscription/set` | `notify/push-subscribe.ts:222`, `:235`, `:297`, `:327` |
| `EmailSubmission/query|get|set` | `outbox/scheduled-client.ts:41/49/87` (Abschnitt „Geplant") |

### Kann

- **Identitäten:** volles CRUD (`identity-client.ts:101-130`), Felder `email` (nur beim
  Anlegen), `name`, `replyTo`, `bcc`, `htmlSignature` (Rich-Text), `textSignature` inkl.
  „aus HTML ableiten" (`IdentityForm.tsx:110-205`). `mayDelete` wird respektiert
  (`IdentitiesSection.tsx:310-318`), `ifInState` bei jedem Schreiben, Stalwarts
  `invalidProperties[email]` wird als eigene Meldung übersetzt (`:109-116`). Diff-only-Patch
  (`identity-model.ts:99-109`).
- **Abwesenheit:** `isEnabled`, `fromDate`/`toDate` als lokale Wanduhrzeit mit Zonen-Hinweis,
  `subject`, `htmlBody` (`VacationSection.tsx:250-312`), Vorschau im Sandbox-Frame, berechneter
  Status aus/aktiv/geplant/abgelaufen (`vacation-model.ts:99-106`). `textBody` ist **kein
  eigenes Feld**, sondern wird beim Speichern aus dem HTML abgeleitet (`vacation-model.ts:77-89`).
- **Sieve-Filter:** visueller Regelbauer — Regeln anlegen, ändern, löschen, einzeln aktivieren
  (`FiltersSection.tsx:172-250`); Vokabular (`rule-model.ts:20-54`): Bedingungen
  from/to/cc/subject/body × contains/is/startsWith/endsWith/matches, Größe über/unter,
  hasAttachment; Aktionen fileInto, addFlag (`\Flagged`/`\Seen`), redirect, discard, plus
  all/any und `stop`. Fremde Skripte werden **byteweise und positionsgetreu** bewahrt
  (`script-io.ts:340-361`, ADR-023) und nur nur-lesend gezeigt. Jedes Speichern setzt
  `onSuccessActivateScript` (`sieve-client.ts:149-160`). Doppeltes Gate: Server-Capability
  **und** Hoster-Schalter `config.features.sieveEditor` (`FiltersSection.tsx:364-371`).
- **Quota:** nur lesend, `octets` und Stückzahlen (`quota-model.ts:74-81`), an drei Stellen
  sichtbar — Seitenleiste (`app/shell/MailScreen.tsx:408`), Einstellungen→Server
  (`ServerSection.tsx:113`), Toast-Warnung (`AppShell.tsx:63`). Warnschwelle
  `max(warnLimit, 90 %)` (`quota-model.ts:41-47`).
- **Push:** echtes Web Push mit VAPID (RFC 9749) —
  `PushManager.subscribe({userVisibleOnly, applicationServerKey})` und `PushSubscription/set`
  mit `types: [EmailDelivery]`, damit der **Server** filtert (`push-subscribe.ts:98-256`).
  Schlüsselrotation, 7-Tage-Erneuerung, RFC-8620-§7.2.2-Verifikationscode
  (`:289-307`, Worker-Seite `sw/sw.ts:217-241`). Der Service Worker hält **kein Token, keine
  Dexie, keinen JMAP-Aufruf** (`sw/sw.ts:20-29`).
  Live-Kanal zusätzlich über **SSE** (`packages/jmap/src/push/sse.ts`, über `fetch` statt
  `EventSource`, weil Stalwart einen `Authorization`-Header verlangt) mit Polling als Rückfall.
  Benutzersteuerung (`NotificationsSection.tsx`): Hauptschalter mit gestengebundener
  Berechtigungsabfrage, **Ordnerauswahl** (Standard: Posteingang), **Ruhezeiten** von/bis,
  **Vorschau** (Absender+Betreff vs. generisch), **Ton**.
- **Konto/Sitzung:** OAuth 2.0 Auth-Code + PKCE (`auth/oauth.ts`) und Basic als Rückfall;
  stille Erneuerung; Abmelden bzw. „Abmelden und Daten löschen" (`auth/wipe.ts`).
  Bis zu 5 Konten in der Registry (`auth/account-registry.ts:37`), Umschalten über das
  Kontomenü im Kopf (`app/shell/AccountMenu.tsx:45-84`).
- **Erscheinungsbild/Sprache:** Theme auto/hell/dunkel (`localStorage waxwing.theme`),
  Akzentpalette (`waxwing.accent`, ausblendbar per `branding.accentLocked`), Dichte
  (Replik-`localPrefs`), Lesebereich-Modus (`waxwing.readingPane`), Sprache en/de
  (`SettingsPage.tsx:266-279`, i18next-Detector). Zusätzlich Wischgesten, Leseverhalten,
  Verfassen-Voreinstellungen, Vorlagen, Speicher/Offline-Panel mit
  `navigator.storage.persist()` und erzwungener Bereinigung (`StorageSection.tsx:37-47`,
  `:151-169`).

### Kann nicht

- **Sieve-Regeln umsortieren.** Neue Regeln werden angehängt (`FiltersSection.tsx:173-175`);
  es gibt kein Drag, kein Hoch/Runter (Grep nach `reorder|moveUp|moveDown|onDragStart` in
  `settings/` ist leer). Reihenfolge ändern = löschen und neu anlegen. Bei Sieve **ist die
  Reihenfolge Semantik** — das ist die schwerwiegendste Lücke dieses Bereichs.
- **`SieveScript/validate` wird von keiner UI erreicht.** Die Methode ist implementiert
  (`sieve-client.ts:173-180`), aber `save()` ruft sie nicht auf (`:145-171`), und
  `FiltersSection.tsx` ruft ausschließlich `client.load` und `client.save`. Ungültiges Sieve
  fällt erst durch die `/set`-Ablehnung auf. **`docs/functional-specification.md:477-480`
  behauptet das Gegenteil** („`SieveScript/validate` is bound and used before a save").
- **Filterung abschalten oder Skript löschen geht nicht.** `deactivate()`
  (`sieve-client.ts:182-188`) und `destroy()` (`:190-209`) sind implementiert und getestet,
  haben aber **keinen UI-Aufrufer**. Ebenso `read()` als öffentliche API.
- **Kein Roh-Sieve-Editor** (bewusst, ADR-023 — `FiltersSection.tsx:276-281`), keine
  Syntaxhervorhebung, **kein `.siv`-Import/-Export**. `script-io.ts` ist trotz des Namens
  kein Datei-I/O, sondern der Parser/Serializer der verwalteten Region.
- **Kein Kontoverwaltungsabschnitt in den Einstellungen** — Hinzufügen/Wechseln/Entfernen liegt
  im Kopfmenü. **Kein Passwort/App-Passwort/2FA** (bewusst Sache der Stalwart-Konsole,
  `IdentitiesSection.tsx:6-8`).
- **Kein Abschnitt für Ordner-, Kalender- oder Adressbuchverwaltung**, keine Delegation, keine
  Freigabeübersicht, keine Signatur je Ordner, keine anpassbaren Tastenkürzel (nur Hilfe-Overlay),
  kein Mail-Export.
- **Benachrichtigungen** lassen sich nur nach Ordner filtern — keine Regeln wie „nur markierte"
  oder „nur VIP". Bei geschlossener App gibt es **keine Inhaltsvorschau** (bewusst, D6a:
  ein JMAP-Push-Payload ist ein nackter `StateChange`; die Vorschau-Einstellung greift nur bei
  offener App). Offener Punkt B28, `docs/implementation-plan.md`.
- **Identitäten, Abwesenheit und Sieve sind online-only** — offline gesperrt; nur die
  Filter-Anzeige bleibt lesbar.
- Veraltete Kommentare, die einen falschen Eindruck erwecken: `notify/capability.ts:1-11`
  behauptet, die Client-Hälfte des Web Push sei nicht implementiert (ist sie, seit M4.0);
  `pwa/pwa-options.ts:8-12` trägt dieselbe veraltete Behauptung über den `push`-Listener.

---

## 6. Übergreifend

### Sharing / Delegation

- **Das einzige Freigabe-UI der Anwendung ist `files/ShareDialog.tsx`.** `Principal/query` und
  `Principal/get` werden an genau **einer** Stelle aufgerufen: der Personensuche für Dateien
  (`files/files-client.ts:237`, `:243`). Der Filter ist bewusst `text` statt des vom RFC 9670
  §2.3 vorgesehenen `name` — Stalwart antwortet auf `name` mit einer leeren Liste und HTTP 200
  (`docs/implementation-plan.md:2389-2393`).
- **Es gibt kein Freigabe-UI für Postfächer, Kalender oder Adressbücher.** Kontakte zeigen nur
  ein „Geteilt"-Abzeichen (`contacts/AddressBookList.tsx:72-75`), Kalender und Mail haben null
  `shareWith`-Referenzen.
- **Delegation wird konsumiert, nie vergeben:** Die App rendert, was der Server an Konten
  herausgibt (`app/session/accounts.ts:18-20`, ein Sync-Motor je Konto über
  `sync/engine/fleet.ts`), mit gruppierter Seitenleiste (`mail/AccountTrees.tsx`) und
  rechtebewussten Aktionen. **Kein UI, um jemandem Zugriff zu gewähren.**
- **`ShareNotification/get` und `ShareNotification/set` werden nirgends aufgerufen** — siehe §7.
  Es gibt also keine Benachrichtigung darüber, dass jemand etwas mit einem geteilt hat.

### Benachrichtigungen

Zwei getrennte Mechanismen: (a) Live-Kanal SSE→Polling bei offener App, der die Sync-Engine
antreibt (`sync/engine/engine.ts:121`); (b) Web Push mit VAPID für die geschlossene App
(`notify/push-subscribe.ts`), inhaltslos (nur „neue Nachricht"), gefiltert serverseitig auf
`EmailDelivery`. Der Service Worker klassifiziert drei Frame-Typen
(`notify/push-frame.ts:39-40`), zeigt nur bei `delivery` ein Banner und macht bei reinem
`stateChange` **nichts**.

### Offline / Sync

- Replik `waxwing-replica` (Dexie v6, `sync/db.ts:637-732`), kontoskopierte Compound-Keys.
- **Zwischengespeichert:** Mail (Envelopes, Bodies, Anhangs-Blobs, Thread-/Query-Fenster),
  Kontakte, Adressbücher, Identitäten, Entwürfe, lokale Prefs, Adressstatistik.
- **Nicht zwischengespeichert:** Kalender, Dateien, Quota, Sieve, Abwesenheit, Submissions.
- **Outbox** (durabel, optimistisch, mit Rollback/Konflikt/Undo) kennt genau 14 Intents
  (`sync/engine/outbox.ts:92-155`): `setKeywords`, `move`, `destroyEmails`, `createMailbox`,
  `renameMailbox`, `moveMailbox`, `deleteMailbox`, `saveDraft`, `discardDraft`, `sendEmail`,
  `createContactCard`, `updateContactCard`, `deleteContactCard`, `createAddressBook`.
  `ifInState`-geschützt: `Mailbox | ContactCard | AddressBook` (`:164`).
  **Alles andere ist online-only.**
- Weitere Maschinerie: Backfill, Backoff, Konflikterkennung, LRU-Eviction, Leader-Election über
  Tabs, Wartungslauf, ein Motor je Konto.

### PWA

- Handgeschriebenes `apps/web/public/manifest.json` (bewusst nicht generiert,
  `pwa/pwa-options.ts:46-58`), `display: standalone`, relative `id`/`scope`/`start_url` für
  Mount-Präfixe, 4 Icons inkl. maskable.
- Installationsaufforderung nur als Menüeintrag, nie als Banner
  (`app/shell/AccountMenu.tsx:66-75`), mit iOS-Zweig.
- Service Worker per Workbox `injectManifest` (`sw/sw.ts`): Precache = `index.html` + gehashte
  Assets; `config.json`/`theme.css`/`manifest.json` NetworkFirst (3 s), `branding/**`
  StaleWhileRevalidate, damit ein Hoster ohne Rebuild umbranden kann (`sw.ts:94-121`).
  NavigationRoute liefert die Shell für Deep-Links offline.
- Update-Aufforderung mit `registerType: 'prompt'`, ohne `skipWaiting` beim Install; ein Toast
  fragt, leert offene Entwürfe und sendet dann `SKIP_WAITING` (`pwa/use-update-prompt.ts`).
- **`mailto:`-Handler: ja** (`protocol_handlers` im Manifest, `compose/mailto.ts`,
  `app/shell/use-mailto-handler.ts`).
- **`share_target`: nein. `file_handlers`: nein. `shortcuts`: nein.**

### Mehrkonten

Zwei unabhängige Achsen: (1) mehrere JMAP-Konten **innerhalb einer Sitzung** (delegiert/geteilt)
— ja, ein Sync-Motor je Konto, `?account=`-qualifizierte Routen (`app/route/route.ts`);
(2) mehrere angemeldete Zugangsdaten — bis zu 5 gespeichert, aber **immer nur eine live**;
Umschalten meldet ab und neu an (`AccountMenu.tsx:50-57`). **Kein Unified Inbox.**

---

## 7. Tote Typisierung (typisiert, nie aufgerufen)

### A) Methoden im Registry ohne jede Aufrufstelle im Produktionscode

| Methode | Registry-Zeile | Befund |
|---|---|---|
| `Core/echo` | `methods.ts:144` | `Methods.coreEcho` hat **null** Referenzen. Die Funktionalität existiert separat als `client.echo()` (`packages/jmap/src/client.ts:127-131`, roher String) — **auch die hat null Aufrufer** außerhalb von Tests. |
| `Mailbox/query` | `methods.ts:150` | Nie aufgerufen. Mailboxen werden immer ganz geholt. |
| `Mailbox/queryChanges` | `methods.ts:151` | Nie aufgerufen. |
| `Calendar/set` | `methods.ts:231` | Nie aufgerufen — **kein UI zum Anlegen/Umbenennen/Löschen eines Kalenders existiert.** |
| `Calendar/changes` | `methods.ts:228` | Nie aufgerufen. |
| `CalendarEvent/changes` | `methods.ts:235` | Nie aufgerufen — Kalender hat keine Delta-Sync. |
| `FileNode/changes` | `methods.ts:250` | Nie aufgerufen — Dateien haben keine Delta-Sync. |
| `ShareNotification/get` | `methods.ts:262` | **Null Referenzen** im gesamten Repo außerhalb von `packages/jmap` (Typ, Methode, Capability-Mapping). Kein Test, kein UI. |
| `ShareNotification/set` | `methods.ts:265` | Ebenso. |
| `SieveScript/query` | `methods.ts:212` | Einzige Referenz überhaupt: `packages/jmap/src/sieve.test.ts:43` (Namensprüfung). Die Skriptliste kommt aus `SieveScript/get {ids:null}` (`sieve-client.ts:99`). |

**10 von 53 Methoden sind tot.** Für `ShareNotification/*` gilt die Vermutung des Auftrags
uneingeschränkt: es gibt sie nur im Typsystem.

### B) Request-Typen ohne Registry-Eintrag (Methoden, die nicht einmal definiert sind)

Definiert in `packages/jmap/src/types/*`, aber in keiner `defineMethod`-Zeile:
`CalendarEventQueryChangesRequest`, `FileNodeQueryChangesRequest`, `IdentityChangesRequest`,
`PrincipalChangesRequest`, `PrincipalSetRequest`, `QuotaChangesRequest`,
`ShareNotificationChangesRequest`, `ShareNotificationQueryRequest`
(`ShareNotification*` in `types/principal.ts:123-130`).

### C) Implementierter Code ohne Aufrufer (keine JMAP-Methode, aber dieselbe Klasse Defekt)

| Symbol | Datei:Zeile | Folge |
|---|---|---|
| `serverSupportsCalendars` | `calendar/calendar-client.ts:524` | Kalender-Menüpunkt ist nicht gated |
| `serverSupportsFiles` | `files/files-client.ts:261` | Dateien-Menüpunkt ist nicht gated |
| `enqueueCreateAddressBook` | `sync/engine/contact-mutations.ts:31` | Adressbuch anlegen ist unerreichbar |
| `expandGroup` / `expandGroupMembers` | `contacts/expand-group.ts` | Kontaktgruppe als Empfänger unmöglich |
| `uploadPhoto`-Prop | nie gesetzt in `contacts/ContactsScreen.tsx:419-435` | Kontaktfoto-Upload dauerhaft deaktiviert (`ContactForm.tsx:812`) |
| `sieveClient.validate` / `.deactivate` / `.destroy` / `.read` | `settings/sieve/sieve-client.ts:173/182/190/73` | keine Vorab-Validierung, Filter nicht abschaltbar, Skript nicht löschbar |
| `port.setAddressBooks({update|destroy})` | `sync/engine/port.ts:350-360` | tote Zweige — nur `create` wird je gefüttert |
| `createMailbox.props.role` | `sync/engine/outbox.ts:101-109`, `:1790` | kein Aufrufer übergibt je ein `role` |
| WebSocket-Push-Transport | `packages/jmap/src/push/websocket.ts` | im Browser bewusst ausgeschlossen (`sync/engine/engine.ts:121`) |

---

## 8. Unsicherheiten

1. **Rein statisch.** Ich habe die laufende Stalwart-Fixture nicht angefasst und keinen Browser
   gestartet. „Erreichbar" heißt hier: es existiert ein UI-Element mit einem Handler, der zum
   Aufruf führt. Ob ein Knopf auf einem realen Server auch funktioniert, ist damit nicht belegt —
   `docs/ui-walkthrough-2026-08-21.md` zeigt, dass genau diese Lücke real ist (der Dateien-Bereich
   war vollständig unbenutzbar, obwohl alle Aufrufwege existierten).
2. **Frisch behobene Befunde nicht nachgeprüft.** `docs/ui-walkthrough-2026-08-21.md` meldet
   58 Befunde, davon 54 behoben, 4 zurückgewiesen — der Merge dazu ist genau der HEAD-Commit.
   Ob alle Korrekturen halten, habe ich nicht verifiziert; die Wurzelursache von M1 (Dateien)
   habe ich stichprobenartig als behoben bestätigt (`files-client.ts:116-140`).
3. **Die Spezifikationsdokumente sind teilweise veraltet.** `functional-specification.md:454-465`
   beschreibt den Kalender als nur-lesend ohne Wochenansicht; der Plan
   (`implementation-plan.md:2377`) sagt etwas anderes und der Code ebenfalls. Ebenso behauptet
   `functional-specification.md:477-480` eine Validierung vor dem Sieve-Speichern, die es nicht
   gibt. Wo Doku und Code auseinandergehen, habe ich den Code gewertet.
4. **Reine Namens-Greps können Aufrufe über dynamisch gebaute Strings übersehen.** Ich habe
   sowohl `Methods.*` als auch rohe `'Typ/verb'`-Strings gesucht; ein per Template
   zusammengesetzter Methodenname (`` `${type}/get` ``) wäre mir entgangen. Stichproben haben
   kein solches Muster gezeigt, ausschließen kann ich es nicht.
5. **e2e-Abdeckung als Indiz, nicht als Beweis.** Es gibt Specs für Kalender, Kontakte, Lesen,
   Schreiben, Einstellungen, geteilte Konten, Push, Offline, PWA — aber **keine** für Dateien,
   für Sieve-Regeln und für den EML-Import (`e2e/tests/`). Das heißt nicht, dass diese
   Funktionen fehlen; es heißt, dass sie nicht end-to-end gegen einen echten Server abgesichert
   sind.
6. **Ordner-Aufräumaktionen** („Papierkorb leeren", „Älter als … löschen") laufen nicht über die
   Outbox (`mail/FolderTree.tsx:145-179`). Ob ein serverseitiger Fehlschlag mitten in einer
   gestückelten Ausführung für den Benutzer sichtbar wird, konnte ich nicht abschließend klären.
7. **Der `role`-Pfad in `Mailbox/set`** ist im Produktionscode nachweislich nie befüllt; ob
   irgendein e2e-Test ihn ansteuert, habe ich nicht geprüft.
