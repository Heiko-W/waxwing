# E — `urn:ietf:params:jmap:emailpush` in Stalwart v0.16.18: empirischer Nachweis

**Datum:** 2026-08-21 · **Server:** `stalwartlabs/stalwart:v0.16.18-alpine`

---

## Urteil

**Funktioniert.** Stalwart v0.16.18 verschickt bei einer echten Zustellung einen Web-Push
mit **Inhalt** — ein JSON-Objekt `{"@type":"EmailPush", ...}` mit `from`, `subject`,
`preview`, `receivedAt` (und auf Wunsch praktisch allen weiteren JMAP-`Email`-Properties),
sowohl unverschlüsselt (`keys: null`) als auch aes128gcm-verschlüsselt (RFC 8291), jeweils
mit VAPID-Authorization-Header.

---

## Der abgefangene Push-Payload (wörtlich)

### 1. Unverschlüsselt (`keys: null`), Konfiguration `properties: ["from","subject","preview","receivedAt"]`

Roher HTTP-Request am Push-Endpunkt (`POST https://push.example.com:19443/push`), 16:16:25.457Z:

```
ttl: 86400
urgency: normal
authorization: vapid t=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5jb206MTk0NDMiLCJleHAiOjE3ODczNzIxODUsInN1YiI6Im1haWx0bzpwb3N0bWFzdGVyQG1haWwud2F4d2luZy50ZXN0In0.hmOAuegCrjoDNroJ7V1Qi4hi2__9T8dTNlemBMW9pe8M6rJwcW5Ow2T2s-U1bJhz3HBSeKnGAtjJYoh0V7CDHw, k=BJobl6rrEhGP2okY8h5A0YJiARNyw2_MNixCrHURzGsvHSmrGtCiHcY7KvGcghOCTp_C3m6VLEQNqBQA9GzA11E
content-type: application/json
content-length: 307
```

Body (Klartext, 307 Bytes):

```json
{"@type":"EmailPush","accountId":"b","emails":[{"from":[{"name":"Bob Beispiel","email":"bob@waxwing.test"}],"subject":"Rechnung 2026-08 faellig","preview":"Hallo Alice, anbei die Rechnung fuer August. Bitte bis Ende der Woche pruefen. Viele Gruesse, Bob","receivedAt":"2026-08-21T16:16:25Z"}],"state":"sae"}
```

Der VAPID-JWT dekodiert:

```
header:  {"typ":"JWT","alg":"ES256"}
payload: {"aud":"https://push.example.com:19443","exp":1787372185,"sub":"mailto:postmaster@mail.waxwing.test"}
```

`exp` = +12 h. `sub` leitet sich aus dem **Container-Hostname** ab (`mailto:postmaster@{hostname}`);
`k=` ist exakt der `applicationServerKey` aus `capabilities["urn:ietf:params:jmap:webpush-vapid"]`.

### 2. Verschlüsselt (echtes P-256-Schlüsselpaar, aes128gcm)

Header: `content-encoding: aes128gcm`, `urgency: high`, `ttl: 86400`, Body 486 Bytes binär.
Entschlüsselter Klartext:

```json
{"@type":"EmailPush","accountId":"b","emails":[{"from":[{"name":"Bob Beispiel","email":"bob@waxwing.test"}],"subject":"WICHTIG Verschluesselter Push-Test","preview":"Umlaute: Grueße, Übung, straße. Dies ist der Preview-Text des verschluesselten Web-Push.","receivedAt":"2026-08-21T16:20:20Z"}],"state":"sau"}
```

Umlaute kommen korrekt als UTF-8 an.

**Wie entschlüsselt** (Standard RFC 8188 + RFC 8291, Implementierung in `/tmp/jmapgap/ece.mjs`,
nur `node:crypto`):

1. Body zerlegen: `salt` (16 B) ‖ `rs` (4 B BE, hier 4096) ‖ `idlen` (1 B) ‖ `keyid` = `as_public`
   (65 B, unkomprimierter P-256-Punkt) ‖ Ciphertext (letzte 16 B = GCM-Tag).
2. `shared = ECDH(ua_private, as_public)` (prime256v1).
3. `ikm = HKDF-SHA256(salt=auth_secret, ikm=shared, info="WebPush: info\0" ‖ ua_public ‖ as_public, L=32)`.
4. `cek = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: aes128gcm\0", L=16)`,
   `nonce = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: nonce\0", L=12)`.
5. AES-128-GCM entschlüsseln, dann RFC-8188-Padding entfernen (trailing `0x00`, davor `0x02`).

### 3. Voller Property-Satz

Mit `properties: ["id","blobId","threadId","mailboxIds","keywords","size","receivedAt","messageId","from","to","subject","sentAt","preview","hasAttachment","header:List-Id:asText"]`:

```json
{"@type":"EmailPush","accountId":"b","emails":[{"id":"uaaaaaf","blobId":"cdnzh1j3xp1g3afio2losxeaapvmhfvfksdjvdlhu29y3jxtz7fzcaiaau","threadId":"f","mailboxIds":{"a":true},"keywords":{},"size":1283,"receivedAt":"2026-08-21T16:21:46Z","messageId":["18cdde88bd0e0c32.4b6ae7f66c078906.62202f0826a3586d@mail.waxwing.test"],"from":[{"name":"Bob Beispiel","email":"bob@waxwing.test"}],"to":[{"name":"Alice Beispiel","email":"alice@waxwing.test"}],"subject":"Alle Properties Test","sentAt":"2026-08-21T16:21:46Z","preview":"Kurzer Text fuer die Property-Probe.","hasAttachment":false,"header:List-Id:asText":null}],"state":"say"}
```

### 4. Verifikations-Push (unverschlüsselt)

```json
{"@type":"PushVerification","pushSubscriptionId":"b","verificationCode":"QbWnUr8uZBJLaOzkHS5kwaUV7njJfmgy"}
```

---

## Filter — wirkt

`emailPush: { "b": { "filter": {"subject":"WICHTIG"}, "properties":[...] } }`, dann zwei Mails
hintereinander an dieselbe Inbox:

| Betreff | in Inbox zugestellt | Push |
|---|---|---|
| `WICHTIG Serverausfall heute` | ja | **EmailPush mit Inhalt** |
| `Newsletter August` | ja | **gar kein Push** |

Beide Mails landeten nachweislich in alices Inbox (`Email/query` zeigt beide, `totalEmails: 3`).
Für die nicht passende Mail kam **auch kein blanker `StateChange`** — die Subscription bleibt
bei einem Filter-Miss komplett still. Das ist relevant: wer parallel den State synchron halten
will, braucht dafür einen zweiten Kanal (WebSocket/EventSource oder eine zweite Subscription
ohne `emailPush`).

Der Filter ist ein normaler JMAP-`Email`-FilterObject (`FilterWrapper<EmailFilter>` in
`crates/jmap/src/push/set.rs:481`), also auch `{"inMailbox":"a"}`, `{"hasKeyword":"$flagged"}`,
`operator`/`conditions` usw.

---

## Genauer Ablauf zum Nachbauen

### 0. Voraussetzung: Stalwart akzeptiert die Push-URL

v0.16.18 validiert die URL beim Anlegen (`crates/jmap/src/push/set.rs`). Empirisch abgelehnt/akzeptiert:

| URL | Ergebnis |
|---|---|
| `http://172.20.0.1:19222/push` | `invalidProperties` — „Push subscription URLs must use the https scheme." |
| `https://172.20.0.1:19443/push` | `invalidProperties` — „…must not point to a local or reserved IP address." |
| `https://203.0.113.9:19443/push` | dieselbe Ablehnung (TEST-NET-3 gilt als reserviert) |
| `https://8.8.8.8:19443/push` | **akzeptiert** |
| `https://localhost:19443/push` | **akzeptiert** |
| `https://push.example.com:19443/push` | **akzeptiert** |

Also: nur **literale** reservierte IPs werden geprüft, Hostnamen werden beim Anlegen **nicht**
aufgelöst. Beim Senden löst Stalwart über den System-Resolver auf und liest dabei `/etc/hosts`
des Containers (mit `--add-host` gesetzt). Das Zertifikat wird **voll validiert**
(`build_push_client()` → `utils::http::http_client_builder(cfg!(feature = "test_mode"))`,
im Release-Build also mit Verifikation) gegen den **nativen** Trust-Store
(`/etc/ssl/certs/ca-certificates.crt`).

**Wichtig:** Der Push-HTTP-Client wird **einmal beim Start** des Push-Managers gebaut
(`let push_client = build_push_client();`, `crates/services/src/state_manager/push.rs:43`),
und reqwest cached die nativen Roots prozessweit. Eine CA, die man dem laufenden Container
nachträglich in den Trust-Store legt, wird **nicht** mehr übernommen — genau das ist bei
`waxwing-stalwart-probe` passiert (TLS-Alert 48 `unknown_ca`, siehe `/tmp/jmapgap/push-log.txt`,
16:00:35Z). Die eigene CA muss **vor** dem Start im Container liegen.

### 1. Test-Setup (so wurde es gemacht)

```sh
# eigene CA + Leaf für push.example.com
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3 \
  -subj "/CN=jmapgap Probe CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=push.example.com"
# leaf.ext: basicConstraints=critical,CA:FALSE / keyUsage / extendedKeyUsage=serverAuth
#           subjectAltName=DNS:push.example.com,IP:172.20.0.1
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem \
  -days 3 -extfile leaf.ext
cat leaf.pem ca.pem > chain.pem
cat <alpine-ca-bundle> ca.pem > ca-bundle.crt

# Node-HTTPS-Server auf dem Host, Port 19443, loggt Methode/Header/Body (hex+utf8)
node /tmp/jmapgap/push-server-tls.mjs

# eigener Stalwart-Container mit vorinstallierter CA
docker run -d --name waxwing-stalwart-emailpush --hostname mail.waxwing.test \
  -e STALWART_PUBLIC_URL=http://localhost:18082 \
  -e STALWART_RECOVERY_ADMIN='admin:waxwing-e2e-Pw1!' \
  -p 127.0.0.1:18082:8080 \
  --add-host push.example.com:172.20.0.1 \
  -v /tmp/jmapgap/stalwart-config:/etc/stalwart:ro \
  -v /tmp/jmapgap/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro \
  -v waxwing-emailpush-data:/var/lib/stalwart \
  --tmpfs /var/log/stalwart:uid=2000,gid=2000,mode=0755 \
  stalwartlabs/stalwart:v0.16.18-alpine --config /etc/stalwart/config.json
```

Domain + Accounts danach wie `e2e/stalwart/fixture.mjs` über `x:Domain/set` / `x:Account/set`
(`using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"]`, Basic `admin`). Achtung: bei
`x:Account/set` ist `name` nur der **Local Part** (`"alice"`), sonst
`invalidPatch — "Invalid email local part"`.

### 2. Subscription anlegen

```json
["PushSubscription/set", {"create": {"s1": {
  "deviceClientId": "emailpush-probe",
  "url": "https://push.example.com:19443/push",
  "types": ["EmailDelivery"],
  "keys": null,
  "emailPush": {"b": {"filter": null,
                      "properties": ["from","subject","preview","receivedAt"]}}
}}}, "0"]
```

`using` muss `urn:ietf:params:jmap:emailpush` enthalten. Antwort:
`created: {"s1": {"id":"b","keys":null,"expires":"…"}}`.
Der Key der `emailPush`-Map ist die **accountId** (hier `"b"` = alice); fremde Accounts →
„No access to one of the accounts in the emailPush map."

### 3. Verifikations-Handshake (RFC 8620 §7.2)

Direkt nach dem `create` (hier < 0,5 s) POSTet Stalwart an die URL:

```json
{"@type":"PushVerification","pushSubscriptionId":"b","verificationCode":"QbWnUr8uZBJLaOzkHS5kwaUV7njJfmgy"}
```

Der Code wird zurückgeschrieben:

```json
["PushSubscription/set", {"update": {"b": {"verificationCode": "QbWnUr8uZBJLaOzkHS5kwaUV7njJfmgy"}}}, "0"]
```

→ `updated: {"b": null}`. **Vorher kommt kein einziger weiterer Push.** `PushSubscription/get`
liefert `verificationCode: null` — sowohl vor als auch nach der Verifikation; man kann daran
also nicht ablesen, ob eine Subscription verifiziert ist.

`emailPush`, `types` und `filter` lassen sich per `update` **nachträglich ändern, ohne neu zu
verifizieren** (empirisch bestätigt).

### 4. Zustellung auslösen

Als bob: `Email/set` (Draft in `role: "drafts"`) + `EmailSubmission/set` mit `identityId`
und `envelope`, `emailId: "#d1"`. Die Mail landete jeweils nachweislich in alices Inbox
(`Email/query`/`Email/get`). Der Push traf **unter 500 ms** nach `sendAt` ein.

---

## Was ein Client-Entwickler daraus bauen kann

Eine echte „Neue Mail von X: Betreff" -Benachrichtigung auf dem Sperrbildschirm — ohne dass die
PWA nach dem Aufwachen erst den Server fragen muss. Der Service Worker kann `event.data.json()`
direkt in `showNotification()` gießen. Das ist der Unterschied zu blankem `StateChange`, bei dem
der SW erst einen authentifizierten JMAP-Roundtrip braucht (Token evtl. abgelaufen, offline,
Latenz, iOS-Budget).

Clientseitig nötig:

1. **VAPID-Key vom Server**, nicht selbst erzeugt:
   `session.capabilities["urn:ietf:params:jmap:webpush-vapid"].applicationServerKey`
   (base64url, unkomprimierter P-256-Punkt) → als `applicationServerKey` in
   `registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`.
   Stalwart erzeugt dieses Keypair **einmalig beim ersten Boot in eine jungfräuliche Registry**
   (siehe `e2e/stalwart/README.md`).
2. **Service Worker** mit `push`-Handler. Der Payload ist bereits vom Browser entschlüsselt;
   der SW muss nur `@type` unterscheiden: `EmailPush` → Notification bauen,
   `StateChange` → Sync anstoßen, `PushVerification` → Code an den Client weiterreichen,
   `CalendarAlert` → Termin-Alarm.
3. **Verifikations-Handshake im Client-Code.** Der `PushVerification`-Push kommt über
   denselben SW-`push`-Handler; der Code muss zur App (z. B. via `postMessage`/IndexedDB) und
   von dort per `PushSubscription/set update` zurück. Ohne das bleibt die Subscription tot.
4. **Keine eigene Entschlüsselung.** `p256dh`/`auth` liefert `PushSubscription.getKey()`;
   die Entschlüsselung macht der Browser. Eigenen ECE-Code braucht nur, wer (wie hier) mit
   einem selbstgebauten Endpunkt testet.
5. **Server-Constraints beachten:** Push-Body max. 4096 B (`WEBPUSH_MAX_BODY_SIZE`),
   verschlüsselt entsprechend weniger; Stalwart kürzt den Property-Satz/`emails`-Array
   selbst, wenn das Budget reißt. `properties` sparsam wählen — `from`, `subject`, `preview`,
   `receivedAt`, `id` reichen für eine Notification.
6. **`urgency`** (`"very-low" | "low" | "normal" | "high"`) ist pro Account-Config setzbar und
   landet 1:1 im RFC-8030-`Urgency`-Header. Default `normal`.
7. **HTTPS-Endpunkt.** Kein Problem bei echten Push-Diensten (FCM/Mozilla/Apple), aber im
   lokalen E2E-Setup der Grund, warum ein Fake-Endpunkt nur mit gültiger Chain funktioniert.

Erlaubte `properties` (aus `EmailPushProperty`, `crates/jmap-proto/src/object/push_subscription.rs:142`):
`id`, `blobId`, `threadId`, `mailboxIds`, `keywords`, `size`, `receivedAt`, `messageId`,
`inReplyTo`, `references`, `sender`, `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `sentAt`,
`preview`, `hasAttachment`, `bodyStructure`, `bodyValues`, `textBody`, `htmlBody`, `attachments`,
`headers` sowie `header:<Name>:<Form>` (z. B. `header:List-Id:asText`). Unbekannte →
„Unknown email property."

---

## Zusatzbefund: EmailPush **ersetzt** den StateChange

`crates/services/src/state_manager/push.rs:332` — eine Zustellung erzeugt genau **eine**
`PushNotification::EmailPush`. Hat die Subscription keine passende `emailPush`-Config, wird sie
zu einem `StateChange` **heruntergestuft**; hat sie eine, wird der `EmailPush` gesendet — nie beides.
Empirisch bestätigt: mit `types: ["Email","EmailDelivery","Mailbox","Thread"]` **und** `emailPush`
kam trotzdem nur ein einziger Request, der `EmailPush`. Das `state`-Feld im Payload trägt die
Change-Id (z. B. `"say"`), mit der man den Sync anstoßen kann.

Der **WebSocket**-Kanal (`urn:ietf:params:jmap:websocket`, `supportsPush: true`) und
**EventSource** liefern weiterhin nur blanke `StateChange`-Objekte — dort gibt es keine
`emailPush`-Konfiguration. Gemessen an derselben Zustellung:

```
WS:          {"@type":"StateChange","changed":{"b":{"EmailDelivery":"sae"}}}
EventSource: {"@type":"StateChange","changed":{"b":{"Thread":"sae","Mailbox":"sae","EmailDelivery":"sae","Email":"sae"}}}
```

---

## Unsicherheiten

- **Der Nachweis lief auf einem zweiten, frisch gestarteten v0.16.18-Container**
  (`waxwing-stalwart-emailpush`, Port 18082), nicht auf `waxwing-stalwart-probe`. Grund: die
  eigene Test-CA muss beim Prozessstart im Trust-Store liegen (reqwest cached native Roots).
  Image-Tag, Config-Form (`RocksDb`) und Provisionierung sind identisch zur Fixture; die
  Aussagen über Payload-Form sind damit auf die Version bezogen belastbar, aber nicht auf
  exakt jenen Container.
- Die **URL-Validierung wurde umgangen**, indem ein Hostname statt einer privaten IP benutzt
  und im Container per `--add-host` auf das Docker-Gateway gemappt wurde. Ob ein echter
  Push-Dienst (FCM/Mozilla/Apple) exakt dieselben Payloads durchreicht, wurde **nicht** getestet
  — es wurde ein selbstgebauter Endpunkt verwendet.
- **VAPID-Signatur nicht verifiziert.** Der `Authorization: vapid`-Header wurde nur dekodiert,
  nicht kryptografisch gegen den `applicationServerKey` geprüft. Ein echter Push-Dienst tut das;
  ob Stalwarts Signatur dort durchgeht, ist hier nicht belegt. (Der `sub` hängt am
  Container-Hostname — laut `docker-compose.yml`-Kommentar ist genau das auf Safari/APNs
  schon einmal zum Problem geworden.)
- **Größenverhalten nicht ausgetestet:** Wie Stalwart bei Überschreiten von 4096 B kürzt
  (Properties weglassen? `emails`-Array kappen? Push ganz verwerfen?), wurde nicht empirisch
  provoziert — nur im Code gesehen (`push_max_size`, `PUSH_OBJECT_OVERHEAD`, `remaining`).
- **Mehrere Mails gleichzeitig:** Das `emails`-Array kann laut Code mehrere Nachrichten
  bündeln (Throttle-Fenster `push_throttle`). Ein Bündel-Push wurde nicht erzwungen; alle
  beobachteten Pushes enthielten genau eine Mail.
- **`filter` mit Body-/Text-Bedingungen** (`EmailFilter::Body/Text`) lädt laut Code den
  kompletten Blob — Performance-Wirkung ungetestet.
- **Kein Server-Log.** `docker logs waxwing-stalwart-probe` ist leer, weil der Default-Tracer
  nach `/var/log/stalwart` schreibt und das Verzeichnis dort fehlt (im Compose-Setup ein tmpfs).
  Alle Aussagen stützen sich deshalb auf den Wire-Mitschnitt am Push-Endpunkt und auf den
  Quelltext v0.16.18 (`/tmp/jmapgap/src`), nicht auf Serverprotokolle.

## Artefakte

- `/tmp/jmapgap/push-log.txt` — vollständiges Roh-Protokoll aller eingehenden Requests
  (inkl. der beiden gescheiterten TLS-Handshakes gegen `waxwing-stalwart-probe`).
- `/tmp/jmapgap/push-raw.jsonl` — dieselben Requests als JSONL (Header + Body b64/utf8).
- `/tmp/jmapgap/ece.mjs` — aes128gcm-Entschlüsselung, `/tmp/jmapgap/decrypt-last.mjs` — Anwendung.
- `/tmp/jmapgap/push-server-tls.mjs` — der Push-Endpunkt.
- `/tmp/jmapgap/ws-log.txt`, `/tmp/jmapgap/es-log.txt` — WebSocket- / EventSource-Vergleich.
