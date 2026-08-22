# C — Mail: Argumente, Properties, Sortier-/Filteroptionen

**Server:** Stalwart `v0.16.18-alpine`? Nein — die Fixture auf `:18080` ist **`stalwartlabs/stalwart:v0.16.14-alpine`**
(`docker ps`: `waxwing-stalwart-dev  …  127.0.0.1:18080->8080/tcp`). Daneben läuft auf `:18081`
`waxwing-stalwart-probe  v0.16.18-alpine` — an einer Stelle (HOLDUNTIL) wurde dort gegengeprüft, sonst
alles auf `:18080`.

**Konto:** `bob@waxwing.test`, accountId `c`. Endpunkt: `POST http://localhost:18080/jmap/` (nicht `/jmap/api`;
`/.well-known/jmap` antwortet `307 → /jmap/session`, und `apiUrl` der Session ist `http://localhost:18080/jmap/`).

**Testdaten:** 8 selbst angelegte Mails (`Email/set create`) in Bobs Inbox, davon ein echter Thread
(`In-Reply-To`/`References`) und eine Mail mit `X-Waxwing-Test`- und `List-ID`-Header. Alle Probe-Artefakte
(Sieve-Skripte, Probe-Mailboxen) wurden wieder zerstört; die Mails und ~15 EmailSubmissions bleiben liegen.

Hilfsskripte: `/tmp/jmapgap/j.py`, `probe_sort.py`, `probe_filter.py`, `probe_hdr.py`, `probe_thread.py`,
`probe_kw.py`, `probe_get.py`, `probe_sub2.py`, `probe_sub3.py`, `probe_mbx.py`, `probe_mbx2.py`,
`probe_rest.py`, `probe_sieve2.py`, `probe_final.py`.

---

## 1. `Email/query` — `sort`

### Server kann

`emailQuerySortOptions` der Session: `receivedAt, size, from, to, subject, sentAt, hasKeyword,
allInThreadHaveKeyword, someInThreadHaveKeyword`. Empirisch (`probe_sort.py`) **alle akzeptiert**, plus zwei
nicht angekündigte:

| `sort.property` | Ergebnis |
|---|---|
| `receivedAt`, `sentAt`, `size`, `from`, `to`, `subject` | OK, Reihenfolge nachweislich korrekt (z. B. `subject` asc → `Bewerbung…`, `Newsletter…`, `Projekt Zebra…`) |
| `hasKeyword` + `keyword` | OK |
| `allInThreadHaveKeyword` / `someInThreadHaveKeyword` + `keyword` | OK |
| `noneInThreadHaveKeyword` + `keyword` | **OK, obwohl nicht in `emailQuerySortOptions`** |
| `cc` | akzeptiert, aber nicht verifizierbar (nur eine Mail mit `cc`) — s. Unsicherheiten |
| `id` | `{"type":"unsupportedSort","description":"property"}` |
| `threadId` | `{"type":"unsupportedSort","description":"threadId"}` |

`collation` wird entgegengenommen, aber offenbar ignoriert — auch `"i;bogus-nonexistent"` liefert keinen
Fehler und dieselbe Reihenfolge.

`collapseThreads` funktioniert **wirklich**: bei 8 Mails, davon 2 im selben Thread,
`collapseThreads:true → total 7`, `false → total 8` (`probe_thread.py`). Ebenso `position` (auch negativ),
`anchor`/`anchorOffset`, `limit`, `calculateTotal`, `canCalculateChanges:true`, `Email/queryChanges`.

### Client nutzt

- Sortier-Komparatoren nur an 5 Stellen; das UI-Menü bietet genau 4:
  `apps/web/src/mail/use-message-list.ts:51-54` → `receivedAt` desc, `from` asc, `subject` asc, `size` desc.
- „Ungelesene zuerst" stellt `{property:'hasKeyword', keyword:'$seen', isAscending:true}` voran:
  `apps/web/src/mail/use-message-list.ts:61`.
- UI-Auswahl: `apps/web/src/mail/MessageList.tsx:996-999` (Datum/Absender/Betreff/Größe),
  Threading-Select `:1009-1018`, Checkbox `:1020-1026`.
- Suche und Label-Ansicht sortieren fest nach `receivedAt` desc und deaktivieren das Menü:
  `apps/web/src/mail/search/use-search.ts:40`, `apps/web/src/mail/labels/use-label-view.ts:28`,
  `apps/web/src/mail/MessageList.tsx:938-959`.
- `collapseThreads` wird genutzt: `use-message-list.ts:75`, Default `true` in
  `apps/web/src/sync/engine/backfill.ts:70`, `false` bei Suche/Labels.
- `emailQuerySortOptions` wird **nur angezeigt**, nicht ausgewertet:
  `apps/web/src/settings/capabilities-model.ts:121`.

### Lücke

- **`sentAt` fehlt:** „Datum" heißt im UI immer *Empfangszeit*; wer nach Sendezeit sortieren will (bei
  verzögert zugestellten oder importierten Mails der spürbarere Wert), kann es nicht.
- **`allInThreadHaveKeyword` / `someInThreadHaveKeyword` / `noneInThreadHaveKeyword` als Sortierung** fehlen:
  in einer thread-gruppierten Liste ließe sich „Konversationen mit Ungelesenem zuerst" damit serverseitig
  lösen — heute geht nur „Mails mit `$seen` zuerst", was bei aufgeklappten Threads etwas anderes bedeutet.
- `to` fehlt (im Postausgang/Gesendet-Ordner der natürliche Schlüssel).
- `cc`, `id`, `threadId`: irrelevant.

---

## 2. `Email/query` — `filter`

### Server kann (`probe_filter.py`, alle mit `calculateTotal:true` gegengeprüft)

| Bedingung | Ergebnis |
|---|---|
| `inMailbox` | OK (total 5) |
| `inMailboxOtherThan` | **OK** (Array; total 0, weil alles in einem Ordner lag) |
| `before` / `after` (receivedAt) | OK |
| **`sentBefore` / `sentAfter`** | **OK — nicht in RFC 8621, Stalwart-Erweiterung.** `sentBefore:2026-02-01` → 1, `sentAfter:2026-07-01` → 30; Ergebnisse unterscheiden sich nachweislich von `before`/`after` |
| `minSize` / `maxSize` | OK (`minSize:1000` → nur die 8226-Byte-Mail) |
| `hasKeyword` / `notKeyword` | OK |
| `allInThreadHaveKeyword` / `someInThreadHaveKeyword` / `noneInThreadHaveKeyword` | OK, Ergebnisse plausibel (2/2/3) |
| `text`, `from`, `to`, `cc`, `bcc`, `subject`, `body` | OK; `bcc:"archiv"` findet die Mail (Volltext auf BCC funktioniert) |
| `hasAttachment` true/false | OK |
| `id` | OK (Array) |
| `operator: AND / OR / NOT` mit `conditions` | OK |
| `header` | **akzeptiert, aber funktionslos** — `["Subject"]`, `["subject"]`, `["Message-ID"]`, `["List-Id"]`, `["X-Waxwing-Test"]`, `["X-Waxwing-Test","magicvalue123"]`: **jeder** Aufruf liefert `total 0`, obwohl der Header nachweislich existiert (`Email/get` zeigt ihn). Kein Fehler, nur nichts. |
| `attachmentType` / `attachmentName` / `attachmentBody` | `unsupportedFilter` |
| `threadId` | `unsupportedFilter` |

### Client nutzt

`apps/web/src/mail/search/search-query.ts:17-28` definiert die Grammatik: `from: to: cc: subject: body:
has:attachment is:unread|read|flagged|starred in: before: after:`. Übersetzung in Conditions:
`search-query.ts:149-176`. Zusätzlich `inMailbox` als Scope (`search-query.ts:131`), `after` als
Cache-Horizont (`apps/web/src/sync/engine/backfill.ts:37-38`), `notKeyword:'$snoozed'` (`backfill.ts:46`),
`hasKeyword` für Labels (`apps/web/src/mail/labels/use-label-view.ts:27`), `before` für „Ältere löschen"
(`apps/web/src/sync/engine/engine.ts:1564`). Ein Formular für erweiterte Suche gibt es nicht — nur Textzeile
+ Chips (`apps/web/src/mail/search/search-chips.ts:33-51`, `SearchBox.tsx:108-190`).

Nie gesendet: `minSize`, `maxSize`, `bcc`, `inMailboxOtherThan`, `sentBefore`/`sentAfter`, die drei
Thread-Keyword-Bedingungen, `header`, `id`, `operator: OR|NOT`.

### Lücken (nach Spürbarkeit)

1. **Suche „alle Ordner" durchsucht auch Papierkorb und Spam.** `apps/web/src/mail/search/use-search.ts:58-60`:
   Scope `all` ⇒ `filterScope = undefined` ⇒ **gar kein** `inMailbox`. Der Server kann
   `inMailboxOtherThan: [trashId, junkId]` — genau dafür ist es da. Heute liefert jede Suche gelöschte und
   als Spam einsortierte Mails mit, ohne dass man das abschalten kann.
2. **Keine Suche nach Größe.** `minSize`/`maxSize` gehen serverseitig; die Grammatik hat kein
   `larger:`/`smaller:`. Die App zeigt einen Quota-Balken (`MailScreen.tsx:408`) — aber wenn er rot wird,
   gibt es keinen Weg, die großen Mails zu finden.
3. **Kein „nur ungelesene Konversationen".** `noneInThreadHaveKeyword:"$seen"` liefert serverseitig genau das
   (verifiziert: total 3); das UI kann nur `is:unread` (= `notKeyword:$seen`) auf Einzelmails.
4. **Kein `OR`, kein `NOT` im Suchfeld.** Der Parser ANDet alles (`search-query.ts:138`), obwohl der Server
   `FilterOperator` in allen drei Formen beherrscht. Kein `-from:x`, kein `a OR b`.
5. **Kein `bcc:`** — Server kann es; im Gesendet-Ordner der einzige Weg, eine Blindkopie wiederzufinden.
6. `sentBefore`/`sentAfter`: `before:`/`after:` filtern nach *Empfangs*-, nicht Sendezeit; für importierte
   Mailarchive ist das der falsche Wert. Nichtstandard, daher nur ein Hinweis.
7. **`header` ist keine Lücke.** Der Client sendet ihn nicht, der Server kann ihn faktisch nicht (immer 0
   Treffer). Ein `list:`-Operator über `header:["List-Id",…]` wäre also heute nicht baubar.

---

## 3. `Email/set` — Keywords

### Server kann (`probe_kw.py`, jeweils gesetzt + zurückgelesen)

**Akzeptiert wird alles.** `$seen, $flagged, $draft, $answered, $forwarded, $phishing, $junk, $notjunk,
$deleted, $recent, $important, $mdnsent` — und beliebige eigene: `custom_label`, `Projekt-Zebra`,
`umlautäöü`, sogar `"with space"`. Zwei Details:

- Keywords werden **kleingeschrieben gespeichert**: `$Seen` → gelesen als `$seen`.
- Obergrenze **128 Zeichen** (300 `a` kamen als 128 `a` zurück), ohne Fehlermeldung — stille Kürzung.
- Patch-Form `{"keywords/$x": true}` und Vollersetzung `{"keywords": {…}}` funktionieren beide.

### Client nutzt

`$seen` (`apps/web/src/mail/use-message-actions.ts:58`), `$flagged` (`:61-66`), `$draft`+`$seen`
(`apps/web/src/compose/draft-email.ts:107`, `apps/web/src/compose/use-draft-sync.ts:275-276`),
`$answered`/`$forwarded` (`apps/web/src/compose/composer-store.ts:24`,
`apps/web/src/sync/engine/outbox.ts:1836`), `$snoozed` (`apps/web/src/mail/snooze.ts:18`),
`$mdnsent` (`apps/web/src/mail/mdn-client.ts:93`), sowie **freie Benutzer-Labels** über ein vollständiges
Label-Modell (`apps/web/src/mail/labels/label-model.ts`, Menü `labels/LabelMenu.tsx:134`) — Slug auf
IMAP-sichere Zeichen, max. 64 Zeichen.

`$junk`/`$notjunk` stehen nur auf der Sperrliste der Systemkeywords
(`apps/web/src/mail/labels/label-model.ts:32-40`) und werden **nie gesetzt**; „Als Spam" ist ein Verschieben
in die Mailbox mit `role:'junk'` (`apps/web/src/mail/use-triage.ts:54`, `MessageView.tsx:680`).
`$phishing` kommt im Repo nicht vor.

### Lücke

**Kein Spam-Training über die Standard-Keywords.** Der Server nimmt `$junk`/`$notjunk` an; Waxwing signalisiert
„Spam"/„kein Spam" ausschließlich über den Ordnerwechsel. Ob Stalwart aus dem Ordnerwechsel allein lernt, habe
ich **nicht** verifizieren können (s. Unsicherheiten) — die Lücke ist also „möglicherweise lernt der
Spamfilter nicht mit", nicht „lernt sicher nicht". `$phishing` fehlt komplett; das ist eine reine
Kennzeichnung ohne Serverwirkung und daher unerheblich.

---

## 4. `Email/get` — Body-Properties und Header-Formen

### Server kann (`probe_get.py`)

Alle Header-Formen funktionieren, auf einer echten Mail geprüft:

| Property | Antwort |
|---|---|
| `header:Subject:asText` | `"Re: Rechnung Januar"` |
| `header:Subject:asRaw` / `header:Subject` | `" Re: Rechnung Januar"` (Schlüssel kommt **ohne** `:asRaw` zurück) |
| `header:From:asAddresses` | `[{"name":"anna","email":"anna@example.com"}]` |
| `header:Message-ID:asMessageIds` | `["18cd…@mail.waxwing.test"]` |
| `header:Date:asDate` | `"2026-06-01T14:12:00Z"` |
| `header:X-Waxwing-Test:asURLs` | `null` (Wert ist keine URL — Form selbst wird akzeptiert) |
| `header:To:asGroupedAddresses` | `[{"name":null,"addresses":[{…}]}]` |
| `header:Subject:asText:all` | `["Re: Rechnung Januar"]` |
| `header:Subject:asBogus` | keine Fehlermeldung, Property fehlt einfach in der Antwort |

`bodyStructure`, `textBody`, `htmlBody`, `attachments`, `hasAttachment`, `preview`, `headers` (Rohliste),
`bodyProperties` inkl. `headers` je Part, `fetchTextBodyValues`, `fetchHTMLBodyValues`, `fetchAllBodyValues`,
`maxBodyValueBytes` (kürzt mit `isTruncated:true`) — alles funktioniert. Ebenso `Email/parse`,
`Email/import`, `Email/changes`, `Thread/get`.

Eine Kuriosität: `header:List-ID:asText` liefert `null`, obwohl `headers` den Header
`{"name":"List-ID","value":" <list.example.com>"}` zeigt; `header:List-ID:asRaw` liefert ihn korrekt.
Stalwart hat für `List-ID` offenbar keinen Text-Parser.

### Client nutzt

Zwei Profile in `apps/web/src/sync/engine/types.ts`, gesendet in `apps/web/src/sync/engine/port.ts:172-195`:

- Envelope (`types.ts:227-246`): `id, blobId, threadId, mailboxIds, keywords, size, receivedAt, sentAt, from,
  to, cc, replyTo, subject, messageId, inReplyTo, references, preview, hasAttachment`
- Body (`types.ts:351-365`): `bodyValues, bodyStructure, textBody, htmlBody, attachments, hasAttachment, bcc,
  sender` + `fetchTextBodyValues:true`, `fetchHTMLBodyValues:true` (`port.ts:193-194`)
- `bodyProperties` (`types.ts:368-377`): `partId, blobId, type, size, name, disposition, cid, charset`
- Header-Properties, genau vier: `header:Authentication-Results:asText:all` (`types.ts:288`),
  `header:List-Unsubscribe:asURLs` (`:300`), `header:List-Unsubscribe-Post:asText` (`:301`),
  `header:Disposition-Notification-To:asText` (`:310`)
- `fetchAllBodyValues`/`maxBodyValueBytes` nur bei `Email/parse` für eingebettete `message/rfc822`
  (`apps/web/src/mail/use-parsed-message.ts:53-80`)

### Lücke

**Praktisch keine.** `asAddresses`/`asGroupedAddresses`/`asMessageIds`/`asDate` würden nur Felder liefern, die
der Client bereits als getypte Top-Level-Properties (`from`, `to`, `messageId`, `sentAt`) holt. Die rohe
`headers`-Liste wird bewusst nicht angefordert (`types.ts:347-350`), der Rohtext kommt per Blob-Download
(`apps/web/src/mail/use-message-source.ts:11-18`) — das ist die sparsamere Variante. Das ist genau die Sorte
„exotischer Header-Formatwandler", die keinem Benutzer fehlt.

---

## 5. `Email/copy`

### Server

- Gleiches Konto: hart abgelehnt — `{"type":"invalidArguments","description":"From accountId is equal to
  fromAccountId"}`.
- Fremdes Konto (`fromAccountId:"b"` = alice): `{"type":"forbidden","description":"You do not have access to
  account b"}`.

**Nicht testbar**, ob `Email/copy` funktioniert: dafür bräuchte bob eine Freigabe auf ein zweites Konto
(`urn:ietf:params:jmap:mail:share` ist zwar in den `accountCapabilities` gelistet, aber Bobs Session enthält
nur ein einziges Konto `c`). Ich habe keine Freigabe eingerichtet, weil das andere Konten der Fixture berührt
hätte.

### Client

`Email/copy` existiert im Repo nicht — weder Typ noch Methodenname (`packages/jmap/src/methods.ts:157-175`
listet get/changes/query/queryChanges/set/parse/import).

### Lücke

Bei einer Ein-Konto-Anwendung folgenlos. Erst wenn Waxwing mehrere Konten oder geteilte Postfächer
unterstützt, fehlt „Mail in anderes Konto kopieren".

---

## 6. `EmailSubmission/set` — zeitversetzt senden, DSN, onSuccess-Hooks

Das war der wichtigste Punkt, deshalb ausführlich (`probe_sub2.py`, `probe_sub3.py`).

### Server kann — `envelope.mailFrom.parameters`

| Parameter | Antwort auf `:18080` (v0.16.14) |
|---|---|
| *(ohne)* | `created: {sendAt:"2026-08-21T15:51:59Z", undoStatus:"final"}` |
| `{"holdfor":"3600"}` | **OK — `sendAt` springt auf `16:51:59`** (+3600 s). Groß-/Kleinschreibung egal (`HOLDFOR`, `holdFor`, `holdfor` alle OK) |
| `{"holdfor":"604800"}` | OK → `sendAt` = +7 Tage |
| `{"holdfor":"604801"}` bzw. `"2592000"` | `{"type":"forbiddenMailFrom","description":"Server rejected MAIL-FROM: 501 5.5.4 Requested hold time exceeds maximum of 604800 seconds."}` |
| `{"HOLDUNTIL":"2026-08-21T18:00:00Z"}` | **abgelehnt:** `"Failed to parse mailFrom parameters: Invalid parameter: HOLDUNTIL."` |
| `{"HOLDUNTIL":"1787340000"}` (Unix-Zeit) | **OK** → `sendAt` = `2026-08-21T19:20:00Z` |
| `{"ret":"HDRS","envid":"abc123"}` | OK |
| `rcptTo[].parameters {"notify":"SUCCESS,FAILURE","orcpt":"rfc822;bob@…"}` | OK |
| `{"mt-priority":"3"}`, `{"requiretls":null}`, `{"size":"1000"}`, `{"by":"3600;R"}` | alle OK |
| `{"totallybogusparam":"x"}` | `"Unsupported parameter: TOTALLYBOGUSPARAM=X."` |
| `{"holdfor": 3600}` (JSON-**Zahl** statt String) | `"Unsupported parameter: HOLDFOR."` — Werte müssen Strings sein |

**Gegenprobe auf `:18081` (v0.16.18):** genau umgekehrt —
`{"HOLDUNTIL":"2026-08-21T19:00:00Z"}` → OK, `sendAt` exakt `19:00:00Z`, `undoStatus:"pending"`;
`{"HOLDUNTIL":"1787340000"}` → `"Invalid parameter: HOLDUNTIL."`; `{"HOLDFOR":"3600"}` → OK.

Weiteres:
- **`maxDelayedSend: 2592000` in der Session ist falsch.** Der MTA riegelt bei **604800 s (7 Tage)** ab —
  exakt gemessen an der `604800`/`604801`-Grenze.
- **`undoStatus` und Stornieren:** die `create`-Antwort auf 0.16.14 meldet irreführend `"final"`, aber
  `EmailSubmission/get` mit expliziten `ids` liefert für zurückgehaltene Sendungen
  `"undoStatus":"pending"` samt `deliveryStatus.…delivered:"queued"`. `EmailSubmission/set update
  {undoStatus:"canceled"}` **funktioniert** (danach zurückgelesen: `"canceled"`), `destroy` ebenfalls.
  Auf 0.16.18 steht schon in der `create`-Antwort `"pending"`.
- `EmailSubmission/get` **ohne** `ids` gibt `list: []` zurück — man muss `EmailSubmission/query`
  (funktioniert, inkl. Filter) oder explizite ids benutzen. `EmailSubmission/changes` funktioniert.
- `onSuccessUpdateEmail` und `onSuccessDestroyEmail`: **beide verifiziert wirksam** — die Mail wurde
  Drafts→Sent verschoben und `$draft` entfernt bzw. gelöscht (`notFound` danach).
- `Identity/set create` funktioniert (Alias mit `replyTo`, `bcc`, `textSignature`, `htmlSignature`).

### Client nutzt

- Envelope: `apps/web/src/compose/use-draft-sync.ts:256-271` — `mailFrom.email` + `rcptTo[].email`,
  **`rcptTo[].parameters` nie**.
- Zeitversetzt senden ist **implementiert**: `apps/web/src/compose/scheduled-send.ts`, Parameter
  `{HOLDUNTIL: <ISO 8601>}` (`scheduled-send.ts:24,104-106`), gesetzt in `use-draft-sync.ts:261-263`.
  UI: Button `apps/web/src/compose/ComposerWindow.tsx:502-506`, Dialog `ScheduleSendDialog.tsx`.
- Die Datei kennt die Server-Eigenheiten bereits und beschreibt sie korrekt:
  `scheduled-send.ts:15-18` („`maxDelayedSend: 2592000` … der MTA erzwingt 7 Tage"),
  `CONSERVATIVE_MAX_MS = 7 * 24 * 60 * 60 * 1000` (`:36`) — **deckt sich exakt mit den gemessenen 604800 s** —
  und `:100-102` („Unix-Timestamp bis 0.16.16, RFC 3339 ab 0.16.17").
- Liste + Stornieren: `apps/web/src/outbox/scheduled-client.ts:41-52` (`EmailSubmission/query`,
  `filter:{undoStatus:'pending', after: now}`) und `:90` (`update {undoStatus:'canceled'}`).
- `onSuccessUpdateEmail`: `use-draft-sync.ts:272-277`, verdrahtet `apps/web/src/sync/engine/port.ts:312-314`.
- `onSuccessDestroyEmail`: nur für Lesebestätigungen, `apps/web/src/mail/mdn-client.ts:88`.
- „Undo Send" ist rein clientseitig (Verzögerung der Outbox-Zeile über `notBefore`,
  `use-draft-sync.ts:280`, Einstellung `apps/web/src/compose/compose-prefs.ts:19,37-45`).

### Lücken

1. **Zeitversetzt senden ist gegen *diese* Fixture kaputt.** Der Client sendet ausschließlich RFC-3339-`HOLDUNTIL`;
   `v0.16.14` auf `:18080` lehnt genau das ab (`invalidProperties: Invalid parameter: HOLDUNTIL`). Der Client
   *hat* also das Feature, aber gegen die Dev-Fixture scheitert es mit einem Fehlerdialog. `HOLDFOR` (in
   Sekunden) funktioniert auf **beiden** Versionen und wäre der versionsunabhängige Weg — die Anwendung kennt
   ohnehin nur „in N Zeit" bis zum gewünschten Zeitpunkt. Das ist keine Server-Lücke, sondern eine
   Kompatibilitätsentscheidung, die die e2e-Fixture ausschließt.
2. **Keine Zustellbestätigung (DSN).** `ret`/`envid` auf `mailFrom` und `notify`/`orcpt` auf `rcptTo` nimmt der
   Server an; der Client setzt nie `rcptTo[].parameters`. Waxwing kann *Lese*bestätigungen (MDN, eigener
   Client `mail/mdn-client.ts`), aber nicht „sag mir, ob die Mail zugestellt wurde" — und
   `EmailSubmission.dsnBlobIds` bleibt dadurch immer leer. Spürbar für jeden, der eine wichtige Mail verschickt.
3. **REQUIRETLS ohne UI.** `{"requiretls":null}` wird angenommen; es gibt keinen Schalter „nur verschlüsselt
   zustellen". Nische, aber für eine Mail-App mit Datenschutz-Anspruch ein naheliegendes Häkchen.
4. **MT-PRIORITY / DELIVERYBY / SIZE:** angenommen, ungenutzt, kein spürbarer Nutzen. Ignorierbar.
5. `onSuccessDestroyEmail` wird nur für MDNs benutzt — korrekt so; für normale Mails soll die Kopie ja bleiben.

---

## 7. `Mailbox/set`

### Server kann (`probe_mbx.py`, `probe_mbx2.py`)

**`role` beim Anlegen:** `archive`, `important`, `snoozed`, `scheduled`, `memos` und `role:null` werden
akzeptiert. `drafts`/`inbox`/`junk`/`sent`/`trash` nur deshalb nicht, weil es sie schon gibt
(`"A mailbox with role 'drafts' already exists."`). Abgelehnt mit `"Invalid property or value."`:
`all`, `flagged`, `subscribed`, `templates`, `xcustom`.
**`role` lässt sich auch nachträglich per `update` setzen** (verifiziert: `{cid:{"role":"archive"}}` → `updated`).

`sortOrder` (create und update), `isSubscribed` (create `false` und update `true`), `name` (Umbenennen),
`parentId` (Verschieben, auch auf `null` = Wurzel), `destroy` — alles verifiziert, mit Rücklesen über
`Mailbox/get`. `myRights` wird vollständig geliefert.

### Client nutzt

`apps/web/src/sync/engine/outbox.ts:1788-1800` (über `port.ts:280-287`): create `{name, parentId}`,
update `{name}` bzw. `{parentId}`, `destroy`. Der Intent-Typ sieht `role` vor (`outbox.ts:102-109,1790`), aber
**kein Aufrufer setzt es** (`apps/web/src/mail/use-folder-actions.ts:42-47`).
`sortOrder` wird nur lokal optimistisch geführt (`outbox.ts:1412`), `isSubscribed` nur lokal
(`outbox.ts:1418`, `apps/web/src/sync/db.ts:120`) — **beide nie an den Server geschrieben**.
`onDestroyRemoveEmails` (Typ in `packages/jmap/src/types/mail.ts:188`) wird nie gesendet.
Bekannte Rollen im Client: `packages/jmap/src/types/mail.ts:62-73`; ausgewertet werden
inbox/drafts/sent/archive/junk/trash (`apps/web/src/mail/folder-tree.ts:12`).

### Lücken

1. **Ordnerreihenfolge bleibt lokal.** Der Server speichert `sortOrder`; Waxwing schreibt ihn nie. Wer seine
   Ordner sortiert, findet sie auf dem zweiten Gerät (und in Thunderbird/iOS Mail) wieder in Serverreihenfolge.
2. **Selbst angelegte Ordner bekommen nie eine `role`.** Legt der Benutzer „Archiv" an, ist es für den Server
   ein namenloser Ordner: kein `\Archive`-Special-Use für IMAP-Clients, und Waxwings eigene Archiv-Aktion
   (die auf `role:'archive'` prüft) erkennt ihn nicht. Der Server nähme `role:"archive"` bei create *oder*
   per nachträglichem update sofort an — ein „Diesen Ordner als Archiv verwenden"-Eintrag wäre billig.
3. **Kein Abonnement-Begriff.** `isSubscribed` wird gelesen, aber nie gesetzt; in einem IMAP-Haushalt mit
   vielen Ordnern gibt es damit keinen Weg, Ordner auszublenden, der auch für andere Clients gilt.
4. `onDestroyRemoveEmails`: Waxwing leert Ordner offenbar selbst — kein spürbarer Unterschied.

---

## 8. `Mailbox/query`

### Server kann

Filter: `hasAnyRole` (true/false), `role`, `name` (Teilstring: `{"name":"Probe"}` fand beide Probe-Ordner),
`parentId` (auch `null`), `isSubscribed`. Unbekannte Felder → `unsupportedFilter`.
Sortierung: `sortOrder`, `name`, `parentId` OK; `role` → `unsupportedSort`.
`sortAsTree:true` und `filterAsTree:true` werden akzeptiert und liefern plausible Ergebnisse
(`filterAsTree` + `hasAnyRole:false` → nur der Ordner ohne Rolle *und ohne rollenbehafteten Vorfahren*).

### Client nutzt

Gar nicht. `methods.ts:148-151` definiert `mailboxQuery`/`mailboxQueryChanges`, `sortAsTree`/`filterAsTree`
sind typisiert (`packages/jmap/src/types/mail.ts:166,168`) — **kein Aufruf**. Stattdessen immer
`Mailbox/get` mit `ids:null` (`port.ts:151`) plus `Mailbox/changes` (`port.ts:98`); Baum und Sortierung
lokal (`apps/web/src/mail/folder-tree.ts:30-51,87`).

### Lücke

**Keine spürbare.** Bei realistischen Ordnerzahlen ist „alles holen und lokal sortieren" die bessere
Architektur (der Baum ist offline verfügbar und filterbar ohne Roundtrip). Nur bei sehr großen geteilten
Postfächern würde `Mailbox/query` etwas bringen.

---

## 9. `SearchSnippet/get`

### Server liefert

Echte Antwort auf `{"filter":{"text":"Rechnung"}, "emailIds":[…4…]}`:

```json
{"emailId":"eaaaaab","subject":"<mark>Rechnung</mark> Januar",
 "preview":"Hallo Bob, anbei die <mark>Rechnung</mark>. Betrag 100 Euro. Zahlungsziel 14 Tage."}
```

Nicht getroffene Mails kommen mit `subject:null, preview:null` in der Liste (nicht in `notFound`; das ist
`null`). Verhalten je Filter: `{"subject":…}` markiert Betreff **und** Vorschau, `{"body":…}` nur die
Vorschau, `{"text":…}` beides. **`{"from":"anna"}` liefert für jede Mail `null`/`null`** — Adressfelder werden
nicht hervorgehoben. Der Snippet-Ausschnitt bei langem Text wird um den Treffer herum geschnitten.

### Client nutzt

`port.ts:259-264` — `{accountId, filter, emailIds}`, keine weiteren Argumente. Kette:
`apps/web/src/mail/search/use-snippets.ts:47` → `apps/web/src/sync/engine/engine.ts:753` → Port.
`<mark>`-Sanitizing in `apps/web/src/mail/search/snippet.ts:11-15`, gerendert in `MessageList.tsx:61`, nur
für den sichtbaren Ausschnitt.

### Lücke

Keine. Vollständig genutzt. (Dass `from:`-Suchen keine Hervorhebung bekommen, liegt am Server.)

---

## 10. `Quota/get`

### Server liefert

```json
{"id":"a","resourceType":"octets","used":29544,"warnLimit":null,"softLimit":null,
 "hardLimit":104857600,"scope":"account","name":"bob@waxwing.test",
 "description":"Bob Baker (Waxwing e2e)","types":["Email","SieveScript","FileNode","CalendarEvent","ContactCard"]}
```

Alle vom Auftrag genannten Properties existieren; `warnLimit` und `softLimit` sind auf dieser Fixture `null`.
**`Quota/query` funktioniert** (`ids:["a"], total:1, canCalculateChanges:false`).
**`Quota/changes` funktioniert nicht:** `{"type":"cannotCalculateChanges"}` — für jeden `sinceState`; ein
ungültiger State liefert vorher schon `invalidArguments`.

### Client nutzt

`apps/web/src/quota/quota-client.ts:25` — `{accountId, ids:null}` **ohne `properties`** (holt also alles),
bewusst nie mit Mail-Calls gebatcht (`quota-client.ts:3-9`), Capability-Gate `:35-41`.
Ausgewertet: `resourceType`, `scope`, `types`, `used`, `hardLimit`, `warnLimit`, `name`
(`apps/web/src/quota/quota-model.ts:40-66`). Anzeige: Sidebar-Balken
(`apps/web/src/app/shell/MailScreen.tsx:408`), Settings-Panel
(`apps/web/src/settings/ServerSection.tsx:113`), Warn-Toast (`quota/use-quota-notifier.ts`).
Kein `Quota/query`, kein `Quota/changes` — stattdessen TTL-Polling.

### Lücke

**Keine.** `Quota/query` bringt bei einem einzigen Quota-Objekt nichts, `Quota/changes` kann der Server
ohnehin nicht — das TTL-Polling ist hier die richtige Entscheidung, und `softLimit` liefert die Fixture nicht.
Dass `quotaLevel` bei `warnLimit:null` auf ein Verhältnis zurückfällt (`quota-model.ts:40`), ist korrekt.

---

## 11. `SieveScript` / `VacationResponse`

### Server kann

`maxNumberScripts: 100`, `maxSizeScript: 102400`, `maxNumberRedirects: 1`, `notificationMethods: ["mailto"]`.
Skripte werden **nur per `blobId`** angelegt (`{"blobId":null}` → `invalidProperties`); Upload über
`POST /jmap/upload/{accountId}/`.

Ich habe 30 Skripte hochgeladen und kompilieren lassen. **Erfolgreich kompiliert und gespeichert:**
`fileinto`, `mailbox` (`:create`), `mailboxid`, `imap4flags` (`setflag`/`addflag`), `vacation`,
`vacation-seconds`, `duplicate`, `regex`, `enotify` (`notify :message … "mailto:…"`), `spamtest` (+`relational`,
+`comparator-i;ascii-numeric`), `virustest`, `body`, `reject`, `ereject`, `editheader`, `variables`,
`subaddress`, `envelope`, `fcc`, `special-use`, `date`, `relational`, `copy` (`redirect :copy`), `include`,
`index`, `foreverypart`, `mime`, `imapsieve`, `extracttext`, `convert`, `environment`.
Fehlschläge waren durchweg **meine** Syntaxfehler und ließen sich mit korrigiertem Skript beheben —
die beworbene `sieveExtensions`-Liste hält also, was sie verspricht.

Zwei Beobachtungen:
- `require ["totally-bogus-extension"];` wird **akzeptiert** — Stalwart prüft `require` nicht gegen die
  eigene Extension-Liste.
- **`SieveScript/validate` funktioniert und liefert präzise Fehler:** `{"error":null}` bei gültigem Skript,
  sonst z. B. `{"type":"invalidScript","description":"Expected token \"command\" but found \"this\" at line 0, column 0."}`.
- `VacationResponse/set` (isEnabled, fromDate, toDate, subject, textBody, htmlBody) funktioniert und legt
  serverseitig **automatisch ein Sieve-Skript namens `vacation`** an — beim Zurücklesen tauchte es in
  `SieveScript/get` auf.
- `SieveScript/query` funktioniert; `onSuccessActivateScript`/`onSuccessDeactivateScript` ebenfalls
  (`isActive:true` verifiziert).

### Client nutzt

Regel-Editor vorhanden: `apps/web/src/settings/sieve/FiltersSection.tsx` (registriert
`apps/web/src/settings/SettingsPage.tsx:397`), Formular `apps/web/src/settings/sieve/RuleForm.tsx`.
Erzeugte `require`-Extensions, genau fünf (`apps/web/src/settings/sieve/rule-model.ts:57-63`):
`fileinto`, `mailboxid`, `imap4flags`, `body`, `variables`. Abgleich gegen `sieveExtensions` der Session:
`apps/web/src/settings/sieve/sieve-client.ts:228-236`.
Bedingungen im UI: `from|to|cc|subject|body` (`RuleForm.tsx:37`), `size over/under` (`:261`, erzeugt
`size :over N` — `rule-model.ts:139-140`), `hasAttachment` (`:262`).
Aktionen: `fileInto`, `addFlag \Seen`/`\Flagged`, `redirect`, `discard` (`RuleForm.tsx:392-395`),
plus `all`/`any` und `stop`.
Regeln liegen als JSON in einem Markerkommentar (`apps/web/src/settings/sieve/script-io.ts:37-45`);
fremde Skriptteile bleiben unangetastet. `SieveScript/validate` wird benutzt (`sieve-client.ts:176`),
`SieveScript/query` nicht (`methods.ts:212` definiert, kein Aufruf).
`VacationResponse/set` wird genutzt (`apps/web/src/settings/vacation-client.ts:66-72`, UI
`settings/VacationSection.tsx`); das Skript `vacation` ist im Filtereditor gesperrt (`sieve-client.ts:41`).

### Lücken (nach Spürbarkeit)

1. **`envelope`** — Regeln greifen auf den `From:`-Header, nicht auf den echten SMTP-Absender. Genau die
   Unterscheidung, mit der man gefälschte Absender abfängt. Server kann es.
2. **`spamtest` / `virustest`** — „alles mit Spam-Score ≥ 5 in Junk" ginge serverseitig
   (verifiziert kompilierbar); der Editor kennt keine Spam-Bedingung.
3. **`hasAttachment` ist gefälscht.** `rule-model.ts:141-145` schreibt
   `header :contains "Content-Type" "multipart/mixed"` — das übersieht `multipart/related`-Anhänge und trifft
   Inline-Bilder fälschlich. Mit `foreverypart` + `mime` (beide kompilieren) ginge es korrekt.
4. **`date` / `relational`** — keine zeitabhängigen Regeln („nur außerhalb der Arbeitszeit").
5. **`duplicate`** — kein „Dubletten unterdrücken".
6. **`reject` / `ereject`** — der Editor kann nur `discard` (stilles Wegwerfen); ein sichtbares Ablehnen
   mit Begründung geht serverseitig.
7. `regex`, `enotify`, `include`, `convert`, `extracttext`: vorhanden, aber für einen normalen Mail-Benutzer
   ohne spürbaren Wert.

---

## Priorisierte Zusammenfassung

| # | Lücke | Spürbarkeit |
|---|---|---|
| 1 | Suche „alle Ordner" liefert Papierkorb + Spam mit (`inMailboxOtherThan` ungenutzt) | hoch |
| 2 | Zeitversetzt senden nutzt nur `HOLDUNTIL`/RFC 3339 → auf der 0.16.14-Fixture defekt; `HOLDFOR` liefe überall | hoch (Kompatibilität, nicht Funktion) |
| 3 | Keine Suche nach Mailgröße (`minSize`/`maxSize`), obwohl Quota-Balken vorhanden | hoch |
| 4 | Ordner-`sortOrder` und `isSubscribed` werden nie zum Server geschrieben | mittel-hoch |
| 5 | Selbst angelegte Ordner bekommen keine `role` (kein Archiv-Special-Use) | mittel-hoch |
| 6 | Keine Zustellbestätigung (DSN `notify`/`ret`), `dsnBlobIds` bleibt leer | mittel |
| 7 | Kein „nur ungelesene Konversationen" (`noneInThreadHaveKeyword`) | mittel |
| 8 | Suchgrammatik kann kein `OR`/`NOT`, kein `bcc:` | mittel |
| 9 | Sieve-Editor ohne `envelope`, `spamtest`, `date`, `duplicate`, `reject`; `hasAttachment` per Header-Hack | mittel |
| 10 | `$junk`/`$notjunk` werden nicht gesetzt (Spam-Training womöglich ohne Signal) | mittel, unsicher |
| 11 | Sortierung nach `sentAt` und `to` fehlt | niedrig-mittel |
| 12 | REQUIRETLS ohne Schalter | niedrig |
| 13 | `Email/copy` fehlt (relevant erst bei Mehrkonto/Freigaben) | niedrig |
| — | `header`-Filter, `Mailbox/query`, `Quota/query`/`changes`, exotische `headers:*`-Formen | **keine** Lücke |

---

## Unsicherheiten

- **`Email/copy` konnte nicht getestet werden.** Bobs Session enthält nur ein Konto; ein Zugriff auf alices
  Konto `b` scheitert an `forbidden`. Ob Stalwart kontenübergreifendes Kopieren *mit* Freigabe beherrscht,
  ist damit offen — ich habe bewusst keine Freigabe eingerichtet, um fremde Konten nicht anzufassen.
- **`$junk`/`$notjunk`:** Der Server *nimmt* die Keywords an. Ob Stalwarts Bayes-Filter daraus lernt — und ob
  er stattdessen schon aus dem Verschieben in den Junk-Ordner lernt — habe ich **nicht** verifiziert; das
  bräuchte Zugriff auf die Serverkonfiguration/Logs. Punkt 10 der Tabelle steht deshalb unter Vorbehalt.
- **Sortierung nach `cc`** wird akzeptiert, aber nur eine Testmail hatte ein `Cc`; ob wirklich sortiert oder
  stillschweigend ignoriert wird, ist ungeprüft. Dasselbe gilt für `to` (alle Mails hatten denselben
  Empfänger).
- **`collation`** wird ohne Fehler entgegengenommen, auch ein erfundener Wert. Ob überhaupt eine Kollation
  angewandt wird oder immer dieselbe, ist ungeprüft.
- **`header`-Filter:** dass er in *allen* 16 getesteten Varianten 0 Treffer liefert, spricht stark für „nicht
  implementiert, aber auch nicht abgelehnt". Ich kenne die Ursache nicht — es könnte auch sein, dass Stalwart
  Header nur bei aktivem Volltextindex durchsucht und die Testmails zu neu waren. Ein Indexierungs-Delay ist
  unwahrscheinlich (dieselben Mails wurden über `text`/`subject`/`body` sofort gefunden), aber nicht
  ausgeschlossen.
- **`sentBefore`/`sentAfter`** stehen nicht in RFC 8621. Sie funktionieren hier nachweislich, aber ich habe
  keine Stalwart-Dokumentation dazu gelesen — ob das eine stabile Zusage ist, ist offen.
- **Versionsdrift:** Alle Aussagen gelten für `v0.16.14`. Der `HOLDUNTIL`-Fall zeigt, dass sich Verhalten
  zwischen Minor-Versionen umkehren kann. Die übrigen Befunde wurden **nicht** gegen 0.16.18 gegengeprüft.
- **`undoStatus` in der `create`-Antwort** meldete auf 0.16.14 `"final"`, obwohl `EmailSubmission/get`
  danach `"pending"` liefert. Ob das ein Bug oder Absicht ist, weiß ich nicht — für den Client heißt es:
  der `create`-Antwort nicht trauen, nachlesen. Der Client tut das bereits
  (`apps/web/src/outbox/scheduled-client.ts:6-11` beschreibt genau diesen Punkt).
- **Zurückgelassene Testdaten** in Bobs Konto: 8 Mails in Inbox/Junk, ~20 Draft-/Sent-Mails aus den
  Submission-Proben, ~15 `EmailSubmission`-Objekte (davon eines mit `undoStatus:"canceled"`), ein inaktives
  Sieve-Skript `vacation` (vom `VacationResponse/set`-Test; die Autoresponse selbst wurde wieder auf
  `isEnabled:false` gesetzt). Auf `:18081` (0.16.18) liegen 3 Draft-Mails und 2 Submissions aus der
  HOLDUNTIL-Gegenprobe.
