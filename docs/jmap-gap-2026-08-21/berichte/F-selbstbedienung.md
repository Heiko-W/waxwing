# F — Selbstbedienungs-Funktionen über `urn:stalwart:jmap` (Stalwart v0.16.18)

Gemessen am 2026-08-21 gegen `http://localhost:18081/jmap/`, Container
`waxwing-stalwart-probe`, Image `stalwartlabs/stalwart:v0.16.18-alpine`,
**Community Edition** (`GET /api/account` → `"edition":"community"`).
Konto: `dave@waxwing.test`, accountId `d`, `using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"]`.

Quellcode: Tarball von `stalwartlabs/stalwart` Tag `v0.16.18` (via `gh api …/tarball/v0.16.18`),
ausgepackt nach `/tmp/jmapgap/src`.

---

## 0. Wie die Methodenliste zustande kommt (Quellenlage)

Die vollständige Liste **steht im Quellcode** und musste nicht geraten werden.

**`crates/jmap-proto/src/request/method.rs:358-372`** — der Parser für `x:`-Methoden:

```rust
}).or_else(|| {
    let (obj, fnc) = s.strip_prefix("x:")?.split_once('/')?;
    let obj = ObjectType::parse(obj)?;
    let fnc = hashify::tiny_map!(fnc.as_bytes(),
        "get"   => MethodFunction::Get,
        "set"   => MethodFunction::Set,
        "query" => MethodFunction::Query,
    )?;

    if obj.flags() & OBJ_SINGLETON == 0 || fnc != MethodFunction::Query {
        (MethodObject::Registry(obj), fnc).into()
    } else {
        None
    }
})
```

Daraus folgt hart:

- Es gibt **genau drei Verben**: `get`, `set`, `query`. Kein `changes`, kein `queryChanges`,
  keine Spezialmethoden wie `x:Password/change`. Alles, was der Auftrag als
  „`unknownMethod`" gemessen hat, ist damit erklärt.
- Der Objektname muss ein `ObjectType` sein. Die Enum-Liste steht in
  `crates/registry/src/schema/properties.rs:134-252` und in
  `crates/registry/src/schema/properties_impl.rs:135-256` (`as_str`) —
  **117 Typen**, von `Account` bis `WebHook`.
- **Singletons haben kein `/query`** (`OBJ_SINGLETON`-Flag). 58 der 117 Typen sind Singletons,
  darunter `AccountPassword` und `AccountSettings` — deshalb ist `x:AccountPassword/query`
  `unknownMethod`, obwohl der Typ existiert.

Die Rechteprüfung sitzt in `crates/jmap/src/api/auth.rs:88-92 / 202-212 / 294-299`; sie
delegiert an `ObjectType::get_permission()` / `set_permission()` / `query_permission()`
(`crates/registry/src/schema/properties_impl.rs:3613 / 3800 / 3735`). Jeder Typ hat ein
Permission-Präfix `sys<Typname>` mit den Suffixen `Get/Query/Create/Update/Destroy`.

**Es gibt außerdem einen REST-Endpunkt, der die eigenen Rechte ausliest** —
`GET /api/account` (`crates/http/src/api/mod.rs:89-93`, Handler
`crates/http/src/auth/permissions.rs`). Das ist die verlässlichste Abkürzung; keine Rate-Limits,
keine Rätselei:

```console
$ curl -s -u 'dave@waxwing.test:waxwing-e2e-Pw1!' http://localhost:18081/api/account
```

→ 239 Permissions, davon **33 `sys*`**, und nur diese betreffen `x:`-Methoden:

| Objekt | Get | Query | Create | Update | Destroy |
|---|---|---|---|---|---|
| `AccountPassword` | ja | — (Singleton) | — | **ja** | — |
| `AccountSettings` | ja | — (Singleton) | — | **ja** | — |
| `AppPassword` | ja | ja | ja | ja | ja |
| `ApiKey` | ja | ja | ja | ja | ja |
| `PublicKey` | ja | ja | ja | ja | ja |
| `SpamTrainingSample` | ja | ja | **nein** | ja | ja |
| `ArchivedItem` | ja | ja | ja | ja | ja | *(Enterprise-only, s.u.)* |
| `MaskedEmail` | ja | ja | ja | ja | ja | *(Enterprise-only, s.u.)* |

Die Doku bestätigt das unabhängig:
[Account Manager](https://stalw.art/docs/management/webui/account-manager/),
[AccountPassword](https://stalw.art/docs/ref/object/account-password/),
[AppPassword](https://stalw.art/docs/ref/object/app-password/) —
Stalwarts eigene End-User-Oberfläche („Account Manager", `/account`) baut auf genau
diesen Objekten auf.

---

## 1. Vollständige Tabelle: alle `x:`-Methoden für den Endbenutzer

Systematisch abgetastet: **alle 117 Objekttypen × `get` und `query`**, als `dave`
(Script-Ergebnis in `/tmp/jmapgap/probe-all.json`).

Ergebnis: `get` → 6× OK, 111× `forbidden`. `query` → 4× OK, 55× `forbidden`,
58× `unknownMethod` (= Singletons).

### 1.1 Erreichbar (6 Typen, 16 Methoden)

| `x:`-Methode | erlaubt? | was sie tut | Beleg (Antwort gekürzt) |
|---|---|---|---|
| `x:AccountPassword/get` | **ja** | Liest den Singleton `id:"singleton"`; Passwort und OTP-URL sind maskiert. Zeigt nur, **ob** 2FA aktiv ist. | `{"list":[{"secret":"****","otpAuth":{},"id":"singleton"}],"notFound":[]}` |
| `x:AccountPassword/set` | **ja** (nur `update`) | Passwortwechsel **und** TOTP-Ein/Ausschalten. Braucht `currentSecret`. | s. §3, §5 |
| `x:AccountPassword/query` | — | existiert nicht (Singleton) | `{"type":"unknownMethod","description":"x:AccountPassword/query"}` |
| `x:AccountSettings/get` | **ja** | Locale, Zeitzone, Beschreibung, Verschlüsselung-at-Rest. | `{"list":[{"description":"dave","locale":"en_US","timeZone":null,"encryptionAtRest":{"@type":"Disabled"},"id":"singleton"}]}` |
| `x:AccountSettings/set` | **ja** (nur `update`) | Locale/Zeitzone setzen, Verschlüsselung-at-Rest ein/aus. `create` wird stillschweigend ignoriert. | s. §4, §6 |
| `x:AccountSettings/query` | — | existiert nicht (Singleton) | `unknownMethod` |
| `x:AppPassword/get` | **ja** | Liste der App-Passwörter mit Metadaten; `secret` ist `"****"`. | s. §2 |
| `x:AppPassword/set` | **ja** | Anlegen (Server erzeugt das Geheimnis, einmalig sichtbar), ändern, löschen. | s. §2 |
| `x:AppPassword/query` | **ja** | IDs der eigenen App-Passwörter. | `{"queryState":"n","canCalculateChanges":true,"position":0,"ids":["b"]}` |
| `x:ApiKey/get` / `/set` / `/query` | **ja** | Wie App-Passwörter, aber Bearer-Token statt Basic-Auth. | s. §3 |
| `x:PublicKey/get` / `/set` / `/query` | **ja** | OpenPGP-/S-MIME-**Public**-Keys des Kontos verwalten (Basis für Verschlüsselung-at-Rest). | s. §6 |
| `x:SpamTrainingSample/get` / `/query` | **ja** | Die eigenen Spam-Trainingsproben einsehen. | s. §7 |
| `x:SpamTrainingSample/set` | **teilweise** | `update`/`destroy` ja, **`create` nein**. | `{"type":"forbidden","description":"You are not authorized to create objects of this type"}` |

### 1.2 Berechtigt, aber Enterprise-gesperrt (2 Typen)

`dave` **hat** die Permissions (`sysMaskedEmail*`, `sysArchivedItem*`), die Community-Edition
sperrt sie trotzdem — `crates/jmap/src/registry/mod.rs:20-43`
(`assert_enterprise_object` für `MaskedEmail | ArchivedItem | Metric | Trace`):

```json
["error",{"type":"forbidden","description":"This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial."},"4"]
```

| Typ | wäre | Bedeutung |
|---|---|---|
| `x:MaskedEmail/*` | Enterprise | Wegwerf-/Alias-Adressen à la Fastmail Masked Email (JMAP-Draft-Analogon) |
| `x:ArchivedItem/*` | Enterprise | Undelete: gelöschte Mails/Events/Karten wiederherstellen |

### 1.3 Alles Übrige: verboten (109 Typen)

Alle anderen 109 Objekttypen (`Account`, `Domain`, `Role`, `Tenant`, `SpamRule`,
`QueuedMessage`, `Certificate`, `NetworkListener`, `Mta*`, `Trace`, `Log`, `Metric`, …)
antworten dem Endbenutzer mit

```json
["error",{"type":"forbidden","description":"You are not authorized to perform this action"},"1"]
```

Das deckt sich mit den Messungen aus dem Auftrag (`x:Account/*`, `x:Domain/query`,
`x:Application/get`, `x:Trace/query`, `x:Log/query`, `x:Metric/get`).

---

## 2. App-Passwörter — `x:AppPassword`

Felder (aus `resources/schema/schema.json.gz`, im Server unter `GET /api/schema/{hash}`
ausgeliefert): `description` (Pflicht), `secret` (serverSet), `createdAt` (serverSet),
`expiresAt` (nullable), `allowedIps` (Set von IP/CIDR), `permissions`
(`Inherit` | `Disable` | `Replace`).

### Anlegen

```json
["x:AppPassword/set",{"accountId":"d","create":{
  "c":{"description":"Waxwing Test Client"}}},"2"]
```
```json
["x:AppPassword/set",{"accountId":"d","created":{
  "c":{"id":"b","secret":"app_aaaaaaodazswkhj7a1vusrdoeqydenhuii0a"}}},"2"]
```

**Das Geheimnis ist genau einmal sichtbar** — jedes spätere `get` liefert `"secret":"****"`.
`create` ohne `description` schlägt fehl:
`{"type":"validationFailed","validationErrors":[{"type":"Required","property":"description"}]}`.

### Funktioniert es wirklich als JMAP-Basic-Auth? Ja.

```console
$ curl -u 'dave@waxwing.test:app_aaaaaaodazswkhj7a1vusrdoeqydenhuii0a' \
    -H 'Content-Type: application/json' -X POST http://localhost:18081/jmap/ \
    -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
         "methodCalls":[["Mailbox/get",{"accountId":"d","properties":["name"]},"0"]]}'
{"methodResponses":[["Mailbox/get",{"accountId":"d","state":"n","list":[
  {"name":"Junk Mail","id":"c"},{"name":"Drafts","id":"d"},…]}]]}
```

Format: `app` + Base32 (`crates/common/src/auth/credential.rs:54-88`); es kodiert die
`credential_id`, deshalb reicht Benutzername + App-Passwort.

### Ablauf, IP-Allowlist, Rechte-Einschränkung

`allowedIps` ist **kein JSON-Array, sondern eine Map** (JMAP-Set-Konvention).
Ein Array wird abgelehnt:

```json
["x:AppPassword/set",{…,"create":{"a":{"description":"t1","allowedIps":["127.0.0.1"]}}},"0"]
→ {"notCreated":{"a":{"type":"invalidPatch","description":"Invalid value for object property","properties":["allowedIps"]}}}
```

Richtig, und wirksam:

```json
["x:AppPassword/set",{"accountId":"d","update":{"b":{
  "allowedIps":{"127.0.0.1/32":true},
  "expiresAt":"2027-01-01T00:00:00Z",
  "description":"Waxwing renamed"}}},"0"]
→ {"updated":{"b":null}}
```

Read-back normalisiert auf `"allowedIps":{"127.0.0.1":true}`. Danach schlägt die
Authentifizierung mit diesem App-Passwort **von der Docker-Bridge aus mit HTTP 403 fehl**;
nach `"allowedIps":{}` wieder **200**. Die Allowlist wird also durchgesetzt
(`AccessToken::assert_is_valid`, `crates/common/src/auth/access_token.rs:496-505`).

Eingeschränkte Protokolle/Rechte gehen über `permissions`:

```json
["x:AppPassword/set",{"accountId":"d","create":{"imaponly":{
  "description":"IMAP only",
  "permissions":{"@type":"Replace","permissions":{
    "authenticate":true,"imapAuthenticate":true,
    "imapList":true,"imapSelect":true,"imapFetch":true}}}}},"0"]
→ {"created":{"imaponly":{"id":"c","secret":"app_aaaaaavcgm0q1yuyp3hgxthhyqpy3h9mbzoq"}}}
```

Damit ist `GET /jmap/session` weiterhin **200**, aber:

```json
["Mailbox/get",…]        → {"type":"forbidden","description":"You are not authorized to perform this action"}
["x:AppPassword/query",…] → {"type":"forbidden","description":"You are not authorized to perform this action"}
```

Varianten: `Inherit` (Default, **alle** Kontorechte inkl. Credential-Verwaltung),
`Disable` (Liste abziehen), `Replace` (Liste als Gesamtmenge).
**Sicherheitsrelevant:** ein `Inherit`-App-Passwort darf selbst wieder App-Passwörter
anlegen und das Kontopasswort ändern — belegt: mit App-Passwort `b` konnte ich
`x:AccountPassword/set` erfolgreich aufrufen (§5).

### Löschen

```json
["x:AppPassword/set",{"accountId":"d","destroy":["b","c"]},"2"] → {"destroyed":["b","c"]}
```

---

## 3. API-Schlüssel — `x:ApiKey`

Gleiches Feldschema wie `AppPassword`. Unterschied: **Bearer statt Basic**.

```json
["x:ApiKey/set",{"accountId":"d","create":{"k1":{
  "description":"Waxwing API key","expiresAt":"2027-01-01T00:00:00Z"}}},"0"]
→ {"created":{"k1":{"id":"d","secret":"API_AAAAAwAAAAPBzVy93AdO6QWkB7ZkVILuvK5yaA"}}}
```

```console
# funktioniert:
$ curl -H 'Authorization: Bearer API_AAAAAwAAAAPBzVy93AdO6QWkB7ZkVILuvK5yaA' … /jmap/
{"methodResponses":[["Mailbox/get",{…"list":[{"name":"Inbox","id":"a"},…]}]]}

# funktioniert NICHT als Basic-Passwort:
$ curl -u 'dave@waxwing.test:API_AAAAAwAAAAPBzVy93AdO6QWkB7ZkVILuvK5yaA' … /jmap/
{"status":401,"title":"Unauthorized","detail":"You have to authenticate first."}
```

Der Token ist selbsttragend: `API_` + Base64url(`account_id` ‖ `credential_id` ‖ 20 Byte
Secret), `crates/common/src/auth/credential.rs:26-52` — kein Benutzername nötig.
`GET /api/account` funktioniert damit ebenfalls.

**Fazit für einen Mail-Client: API-Schlüssel sind für Waxwing praktisch nutzlos.**
Sie machen dasselbe wie App-Passwörter, nur mit anderem Auth-Header; ihr Zweck ist
Skript-/CLI-Zugriff.

---

## 4. Kontoeinstellungen — `x:AccountSettings`

```json
["x:AccountSettings/set",{"accountId":"d","update":{"singleton":{"locale":"de_DE"}}},"0"]
→ {"updated":{"singleton":null}}
```

`locale` ist ein Enum mit POSIX-Namen (`de_DE`, `en_US`, …); `"de"` wird abgelehnt:
`{"type":"invalidPatch","description":"Invalid value Str(\"de\") for enum type EnUS.","properties":["locale"]}`.
`timeZone` nimmt IANA-Namen (`Europe/Berlin`) und ist nullable.

**Quirk, den ein Client kennen muss:** ein `update` mit einem gültigen und einem ungültigen
Feld meldet `notUpdated` — **schreibt das gültige Feld aber trotzdem**. Belegt:
`{"timeZone":"Europe/Berlin","locale":"de"}` → `notUpdated[locale]`, danach steht
`timeZone` dauerhaft auf `Europe/Berlin`. Ein Client darf aus `notUpdated` also nicht auf
„nichts passiert" schließen und muss neu lesen.

`create` auf dem Singleton wird kommentarlos verschluckt (Antwort ohne `created`/`notCreated`).

---

## 5. Passwortwechsel und 2FA/TOTP — `x:AccountPassword`

Beides hängt an **demselben** Singleton. Felder: `secret`, `currentSecret`,
`otpAuth.otpUrl`, `otpAuth.otpCode`.

### 5.1 Passwortwechsel: das alte Passwort ist Pflicht

```json
["x:AccountPassword/set",{"accountId":"d","update":{"singleton":{"secret":"…"}}},"0"]
→ {"notUpdated":{"singleton":{"type":"forbidden",
     "description":"Current secret must be provided to change the password or OTP auth."}}}
```

Mit `currentSecret` klappt es (echt durchgeführt und wieder zurückgedreht — dave hat
wieder sein ursprüngliches Passwort):

```json
["x:AccountPassword/set",{"accountId":"d","update":{"singleton":{
  "currentSecret":"waxwing-e2e-Pw1!","secret":"waxwing-e2e-Pw2!"}}},"0"]
→ {"updated":{"singleton":null}}
```
```console
$ curl -o/dev/null -w '%{http_code}\n' -u 'dave@…:waxwing-e2e-Pw1!' …/jmap/session   → 401
$ curl -o/dev/null -w '%{http_code}\n' -u 'dave@…:waxwing-e2e-Pw2!' …/jmap/session   → 200
```

Beobachtungen aus `crates/jmap/src/registry/mapping/account.rs:186-330`:

- **Passwortstärke** wird serverseitig geprüft (`is_secure_password`) → `invalidProperties`
  auf `secret`.
- **Fail2ban**: zu viele falsche `currentSecret` führen zu `SecurityEvent::AuthenticationBan`
  („Too many failed password change attempts").
- **Externe Verzeichnisse** (LDAP/SQL): Passwortwechsel wird mit
  `forbidden / "Operation not allowed."` abgelehnt; zusätzlich entfernt
  `crates/http/src/auth/permissions.rs:100-104` dann `sysAccountPassword*` aus `/api/account`.
  → Ein Client kann das **vorab** an `/api/account` erkennen und den Menüpunkt ausblenden.
- **App-Passwörter überleben den Passwortwechsel** (verifiziert: App-Passwort blieb gültig).
- Ist das Passwort abgelaufen, werden die Rechte auf `Authenticate`, `SysAccountPasswordGet`,
  `SysAccountPasswordUpdate`, `EmailReceive` heruntergestuft, damit der Benutzer sich noch
  ein neues setzen kann (`access_token.rs:517-538`) — ein hübscher Zwangs-Passwortwechsel-Flow.

### 5.2 2FA/TOTP: ja, per JMAP einrichtbar — der Client erzeugt das Secret

`otpAuth.otpUrl` ist eine ganz normale `otpauth://totp/…?secret=BASE32`-URI; der Server
prüft sie mit `TOTP::from_url(...).check_current(token)`
(`crates/directory/src/core/secret.rs:33-75`). Der **Client** generiert also Secret und
QR-Code, der Server speichert nur die URI (und maskiert sie beim Lesen zu `"****"`).

Aktivieren (echt durchgeführt):

```json
["x:AccountPassword/set",{"accountId":"d","update":{"singleton":{
  "currentSecret":"waxwing-e2e-Pw1!",
  "otpAuth/otpUrl":"otpauth://totp/Stalwart:dave@waxwing.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Stalwart"}}},"0"]
→ {"updated":{"singleton":null}}

["x:AccountPassword/get",…] → {"list":[{"secret":"****","otpAuth":{"otpUrl":"****"},"id":"singleton"}]}
```

Deaktivieren braucht Passwort **und** gültigen Code:

```json
["x:AccountPassword/set",{"accountId":"d","update":{"singleton":{
  "currentSecret":"waxwing-e2e-Pw1!","otpAuth/otpCode":"226136","otpAuth/otpUrl":null}}},"0"]
→ {"updated":{"singleton":null}}
```

(Der Code kam aus `/tmp/jmapgap/totp.py`, HMAC-SHA1/30 s — der Server hat ihn akzeptiert,
das ist der Beweis, dass die URI wirklich als TOTP-Secret ausgewertet wird.)

### 5.3 Der Haken, der 2FA für Waxwing heute unbrauchbar macht

Mit aktivem TOTP:

| Auth-Weg | Ergebnis |
|---|---|
| HTTP **Basic** `dave:passwort` | **402** (MFA required) |
| HTTP Basic `dave:passwort$code` | 401 — es gibt **keine** Inline-Code-Syntax |
| App-Passwort (Basic) | **200** |
| API-Key (Bearer) | **200** |

Grund im Code: `mfa_token` wird **ausschließlich** vom OAuth-/Login-Endpunkt befüllt
(`crates/http/src/auth/oauth/auth.rs:92-127`, Feld `mfaToken` in `LoginRequest`).
HTTP-Basic (`crates/http/src/auth/authenticate.rs:155`), IMAP
(`crates/imap/src/op/login.rs:20`), POP3, SMTP und SASL setzen alle hart `mfa_token: None`.

Praktisch heißt das: **wer 2FA einschaltet, sperrt sich für Basic-Auth aus** und muss über
OAuth einloggen oder App-Passwörter benutzen. Ein Client, der 2FA anbietet, muss diesen
Zusammenhang mit anbieten, sonst produziert er Support-Fälle.

*(Meine Versuche gegen `POST /api/auth` mit `{"type":"authCode",…,"mfaToken":"…"}` gaben
401 — vermutlich, weil `clientId` ein registrierter OAuth-Client sein muss. Nicht
weiterverfolgt; für die Bewertung nicht nötig, weil der Code-Pfad eindeutig ist.
→ Unsicherheit, siehe §10.)*

---

## 6. Verschlüsselung at Rest — `x:PublicKey` + `x:AccountSettings.encryptionAtRest`

Zwei Schritte. Erst den eigenen **Public** Key hochladen:

```json
["x:PublicKey/set",{"accountId":"d","create":{"pk":{
  "description":"Dave OpenPGP",
  "key":"-----BEGIN PGP PUBLIC KEY BLOCK-----\n…",
  "emailAddresses":{"dave@waxwing.test":true}}}},"0"]
→ {"created":{"pk":{"id":"jaztfjh9ktaa"}}}
```

Dann die Verschlüsselung einschalten:

```json
["x:AccountSettings/set",{"accountId":"d","update":{"singleton":{
  "encryptionAtRest":{"@type":"Aes256","publicKey":"jaztfjh9ktaa",
                      "encryptOnAppend":true,"allowSpamTraining":true}}}},"0"]
→ {"updated":{"singleton":null}}
```

Varianten von `@type`: `Disabled`, `Aes128`, `Aes256`, `Aes256Gcm` (nur S/MIME),
`ChaCha20Poly1305` (nur S/MIME). Zusatzfelder: `encryptOnAppend`, `allowSpamTraining`.

**Ende-zu-Ende belegt.** Danach eine Mail an dave geschickt (`Email/set` + `EmailSubmission/set`)
und die zugestellte Nachricht angesehen:

```json
"bodyStructure":{"type":"multipart/encrypted","subParts":[
  {"partId":"1","type":"application/pgp-encrypted"},
  {"partId":"2","type":"application/octet-stream","name":"encrypted.asc"}]}
```

Der Roh-Download (`/jmap/download/d/<blobId>/mail.eml`) enthält den Klartext-Marker
`SECRETMARKER-12345` **null Mal**, und `gpg --decrypt` mit dem privaten Testschlüssel
liefert ihn zurück:

```
Content-Type: text/plain; charset="utf-8"

SECRETMARKER-12345 plaintext body
```

Das ist genau die Falle, die `docs/competitive-analysis-bulwark.md:55-58` beschreibt —
nur mit einer Ergänzung, die dort fehlt: **der Benutzer kann diesen Schalter über JMAP
selbst umlegen.** Waxwing könnte ihn also nicht nur diagnostizieren, sondern auch
ausschalten (das entschlüsselt Altbestände allerdings nicht rückwirkend).

---

## 7. Spam-Training — `x:SpamTrainingSample`

Der Benutzer darf **nicht anlegen** (`sysSpamTrainingSampleCreate` fehlt):

```json
["x:SpamTrainingSample/set",{…,"create":{…}}] →
{"type":"forbidden","description":"You are not authorized to create objects of this type"}
```

Der Server legt die Proben selbst an. Verifiziert: Mail nach Junk verschoben
(`Email/set` `mailboxIds:{"c":true}`), danach:

```json
["x:SpamTrainingSample/query",…] → {"ids":["jaztlnuqamaa"]}
["x:SpamTrainingSample/get",…]   → {"list":[{"from":"dave@waxwing.test",
  "subject":"Encryption at rest probe","blobId":"eaci…","isSpam":true,
  "deleteAfterUse":false,"expiresAt":"2027-02-17T00:00:00Z","id":"jaztlnuqamaa"}]}
```

Nutzwert für einen Endbenutzer: eine **Datenschutz-Funktion** („welche meiner Mails liegen
als Trainingsprobe herum, und weg damit") plus Korrektur von Fehleinstufungen. `destroy`
funktioniert.

---

## 8. Zwei Detailbefunde, die einen Client betreffen

### 8.1 Capability-Erkennung: `urn:stalwart:jmap` steht **nicht** in `capabilities`

Aus `GET /jmap/session` (v0.16.18):

- `capabilities` (Top-Level): 17 URNs, **`urn:stalwart:jmap` ist nicht dabei**.
- `accounts.d.accountCapabilities`: **enthält `urn:stalwart:jmap` als `{}`**.
- `primaryAccounts`: enthält `"urn:stalwart:jmap":"d"`.

Ein Client muss also **`accountCapabilities`** (oder `primaryAccounts`) prüfen, nicht das
Top-Level-Objekt. `docs/implementation-plan.md:2597-2598` sagt dazu heute:
*„`urn:stalwart:jmap` is absent from the session and its account capability is `{}`"* —
das ist im ersten Halbsatz missverständlich bis falsch. Die Capability **wird** angekündigt,
nur eben auf Kontoebene. Wer nach dem ersten Halbsatz implementiert, baut die Erkennung
an der falschen Stelle.

Angenehm ist: das ist exakt dasselbe Muster wie bei `urn:ietf:params:jmap:mail`, wo Waxwing
mit `getMailCapability(session, accountId)` schon die Kontoebene liest
(`apps/web/src/settings/capabilities-model.ts`). Die Mechanik existiert also bereits.

### 8.2 `GET /api/account` als Feature-Gate

Für eine Selbstbedienungs-UI ist das der ehrlichste Detektor: ein einzelner
GET liefert die exakte Rechteliste des eingeloggten Kontos. Damit lässt sich
**pro Funktion** entscheiden, ob der Menüpunkt erscheint — inklusive der Fälle
„externes Verzeichnis, daher kein Passwortwechsel" und „Community-Edition, daher
kein Masked Email". Nachteil: es ist ein proprietärer REST-Endpunkt außerhalb von JMAP.
Alternative ohne Zusatzendpunkt: `x:<Typ>/get` probieren und `forbidden` als „nicht
verfügbar" behandeln — ein Roundtrip pro Typ, aber rein JMAP.

---

## 9. Was Waxwing davon hat

### 9.1 Stand heute: nichts davon im Produkt

Gesucht im Repo `/home/heiko/repositories/waxwing`:

| Fundstelle | Was |
|---|---|
| `e2e/stalwart/fixture.mjs:42` | `MGMT_USING = ['urn:ietf:params:jmap:core','urn:stalwart:jmap']` |
| `e2e/stalwart/fixture.mjs:192` | `x:Domain/set` — Testdomain anlegen (**Admin**) |
| `e2e/stalwart/fixture.mjs:204, 245` | `x:Account/set` — Testkonten + `quotas.maxDiskQuota` (**Admin**) |
| `docs/adr/002-stalwart-dev-fixture-design.md:53` | ADR erwähnt die Capability nur für die Fixture |
| `docs/implementation-plan.md:2598` | die o.g. Aussage zur Capability-Erkennung |

**In `apps/` und `packages/` gibt es keinen einzigen `x:`-Aufruf.** Die Selbstbedienung
lebt ausschließlich im E2E-Provisionierungsskript, und dort mit Admin-Rechten.

### 9.2 Was die Docs heute sagen

- **`docs/functional-specification.md` §6 „Self-service Server Features (via JMAP)"**
  (Zeilen 447-483) listet **nur** FR-VAC-01 (Vacation), FR-CAL-01 (Kalender),
  FR-SIEVE-01/02 (Filter). **Kein Wort** zu Passwort, App-Passwörtern, API-Schlüsseln,
  2FA oder Verschlüsselung-at-Rest. Die Überschrift verspricht mehr, als der Abschnitt hält.
- **`docs/competitive-analysis-bulwark.md`**
  - Zeile 105: „2FA/MFA | Bulwark: TOTP, password & 2FA management via Stalwart admin API,
    structured MFA login | **Waxwing: OAuth + Basic only**" — als Bulwark-Vorsprung notiert,
    ohne die Feststellung, dass derselbe Weg über `urn:stalwart:jmap` offensteht.
    Der Wortlaut „via Stalwart **admin** API" ist überdies überholt: in 0.16 ist es die
    ganz normale User-API.
  - Zeilen 48/55-58: Verschlüsselung-at-Rest ist nur als **Lese**problem beschrieben
    („ohne PGP kann der Client das Postfach nicht lesen"). Dass der Benutzer den Schalter
    selbst bedienen kann, steht nirgends.
- **`FR-SRV-02`** (§2, Zeile 101) fordert bereits genau das Muster, das man hier bräuchte:
  „Feature detection via the JMAP Session capabilities object. Every feature beyond the
  baseline degrades gracefully when the capability is absent: the corresponding UI is
  hidden, never broken."

### 9.3 Bewertung gegen Produktprinzip 6 („Standards over cleverness")

Prinzip 6 verbietet nicht die Nutzung, sondern die **Abhängigkeit**: „no proprietary server
extensions *required*. Stalwart-specific niceties are progressive enhancements."
Alles Folgende ist als reine Progressive Enhancement baubar — ein Settings-Abschnitt
„Konto & Sicherheit", der ohne `urn:stalwart:jmap` in `accountCapabilities` gar nicht erst
gerendert wird, exakt wie `FiltersSection`/`VacationSection` heute schon verschwinden.

| Funktion | Nutzen für den Endbenutzer | Sauber als Option baubar? | Empfehlung |
|---|---|---|---|
| **App-Passwörter** | **hoch.** Das ist die Antwort auf „ich will mein Handy-Mailprogramm anbinden, ohne mein Hauptpasswort einzutippen", und die *einzige* praktikable Antwort, sobald 2FA an ist. Anlegen → Secret einmal zeigen → Liste mit Widerruf. | **sehr sauber.** 3 Methoden, flaches Schema, keine Krypto, keine neuen Abhängigkeiten. Fällt hinter einem Capability-Check komplett weg. | **Klarer Kandidat für V1.x.** Bestes Nutzen/Aufwand-Verhältnis der ganzen Liste. |
| **Passwortwechsel** | **hoch.** Der Klassiker, den jeder Webmailer hat und Waxwing nicht. Zwei Felder plus Bestätigung. | **sauber**, mit drei Fallstricken, die man behandeln muss: `currentSecret` ist Pflicht; externe Verzeichnisse verbieten es (an `/api/account` oder am `forbidden` erkennbar); die Stärkeprüfung liefert eine Servermeldung, die man anzeigen muss. | **Kandidat für V1.x**, zusammen mit App-Passwörtern in einem Abschnitt. |
| **2FA/TOTP** | mittel bis hoch, **aber gefährlich.** Der Nutzen ist real, doch das Einschalten killt Basic-Auth für alle bestehenden IMAP-/JMAP-Zugänge, und Waxwing selbst kann den Code beim Login nicht mitschicken. | technisch machbar (Client erzeugt Secret + QR, `otpauth://`-URI setzen), aber der **Auth-Pfad muss vorher sitzen**: OAuth-Login mit `mfaToken` oder App-Passwörter. | **Nicht vor** App-Passwörtern und einer geklärten MFA-Login-Story. Sonst baut man einen Schalter, der Benutzer aussperrt. |
| **Verschlüsselung at Rest** | mittel. Für Waxwing zunächst **diagnostisch** wertvoll: erklärt die heute unlesbaren Postfächer aus §5.1 der Wettbewerbsanalyse — „dein Server verschlüsselt eingehende Mail mit Schlüssel X; Waxwing kann sie ohne PGP-Stack nicht anzeigen". Das Ausschalten anzubieten ist heikel (wirkt nur nach vorn). | **Anzeige: sehr sauber** (1 Read auf `x:AccountSettings/get`). Verwaltung: braucht `x:PublicKey`-CRUD und eine sinnvolle Erklärung — mehr UI als Code. | **Nur-Lese-Diagnose zuerst.** Das ist billig und behebt eine echte Verwirrung. Volle Verwaltung erst zusammen mit dem PGP-Stack. |
| **Spam-Trainingsproben** | niedrig bis mittel. Nische, aber eine echte Datenschutzgeste. | sauber (get/query/destroy). | Nice-to-have, nicht priorisieren. |
| **API-Schlüssel** | **niedrig.** Zielgruppe sind Skripte, nicht Mailbenutzer; der Nutzen überlappt vollständig mit App-Passwörtern. | sauber, aber überflüssig. | **Weglassen.** |
| **Masked Email / Undelete** | wäre hoch, ist aber **Enterprise-only** und damit für die meisten Waxwing-Installationen tot. | — | Nur erwähnen, nicht bauen. |

Zwei zusätzliche Argumente, die für den Bau sprechen:

1. **Es kostet keine Abhängigkeit.** Kein neues Paket, kein Krypto-Stack, keine Server-Komponente.
   App-Passwörter + Passwortwechsel sind ein Formular und drei JMAP-Aufrufe.
2. **Es schließt eine Lücke, die die eigene Wettbewerbsanalyse benennt** (Zeile 105) — und zwar
   mit *weniger* Aufwand als dort unterstellt, weil kein Admin-API-Zugang nötig ist.

Ein Gegenargument, das man kennen sollte: **`urn:stalwart:jmap` ist ein Registry-Frontend, kein
JMAP-Feature.** Das Wire-Format (`@type`-Varianten, Sets als Maps, Singleton-IDs `"singleton"`,
Enum-Namen wie `de_DE`) folgt Stalwarts internem Schema-Generator, nicht JMAP-Konventionen —
und ist damit ähnlich driftanfällig wie der Kalender-Draft, den ADR/Spec schon als Risiko
führen. Wer das baut, sollte es hinter einer schmalen, gut getesteten Adapterschicht kapseln
und die Wire-Shapes gegen die laufende Fixture festnageln, so wie es die Spec beim Kalender
ausdrücklich vermerkt.

---

## 10. Unsicherheiten

1. **OAuth-Login mit `mfaToken` nicht verifiziert.** `POST /api/auth` mit
   `{"type":"authCode","accountName":…,"accountSecret":…,"mfaToken":…,"clientId":"waxwing"}`
   gab 401 — auch **ohne** aktives TOTP-Feld hätte ich das gegenprüfen müssen. Vermutlich
   braucht es einen registrierten OAuth-Client (`x:OAuthClient`, für dave verboten).
   Der Code-Pfad (`LoginRequest::AuthCode { mfa_token }` → `verify_mfa_secret_hash`)
   ist eindeutig, die **praktische** MFA-Login-Story für Waxwing habe ich aber nicht
   durchgemessen. Das ist die wichtigste offene Frage, bevor jemand 2FA baut.
2. **IMAP/POP3/SMTP mit App-Passwort nicht getestet** — der Probe-Container mappt nur 8080.
   Aus dem Code (`crates/imap/src/op/login.rs`, `crates/pop3/src/client.rs`,
   `crates/smtp/src/inbound/auth.rs` nutzen alle denselben `validate_credential`-Pfad) folgt,
   dass es funktioniert; gemessen habe ich es nicht.
3. **Nur Community-Edition gemessen.** `MaskedEmail` und `ArchivedItem` konnte ich nur bis
   zur Enterprise-Sperre verfolgen. Die Feldschemata stammen aus
   `resources/schema/schema.json.gz`, nicht aus echten Antworten.
4. **Nur internes Verzeichnis.** Alle Aussagen zu LDAP/SQL-Konten (Passwortwechsel gesperrt,
   `sysAccountPassword*` wird aus `/api/account` entfernt) stammen aus dem Quellcode
   (`crates/http/src/auth/permissions.rs:100-104`,
   `crates/jmap/src/registry/mapping/account.rs:200-212`), nicht aus einer Messung.
5. **`x:AppPassword`-Rechteliste nicht ausgereizt.** Ich habe `Replace` mit fünf Permissions
   belegt; ob `Disable` genauso funktioniert und ob eine Rechte-Erweiterung über die eigenen
   Kontorechte hinaus abgelehnt wird, habe ich nicht geprüft.
6. **Der `notUpdated`-trotzdem-geschrieben-Quirk (§4)** ist an genau einem Beispiel gemessen
   (`x:AccountSettings`). Ob er für alle Registry-Typen gilt, ist offen — für einen Client
   wäre die Antwort relevant.
7. **Version.** Alles gegen **v0.16.18**. Die Aussage in `implementation-plan.md` stammt aus
   einer Messung gegen die 0.16.14-Fixture auf Port 18080, den ich vereinbarungsgemäß nicht
   angefasst habe. Ein Versionsunterschied bei der Capability-Platzierung ist damit nicht
   ausgeschlossen.

---

## 11. Aufräumen

Alles wieder im Ausgangszustand, verifiziert per `query`/`get`:
App-Passwörter `b`,`c` gelöscht, API-Key `d` gelöscht, PublicKey `jaztfjh9ktaa` gelöscht,
Trainingsprobe `jaztlnuqamaa` gelöscht, `encryptionAtRest` → `Disabled`, `locale` → `en_US`,
`timeZone` → `null`, TOTP aus, **Passwort von `dave` wieder `waxwing-e2e-Pw1!`**
(`GET /jmap/session` → 200). Kein Wegwerfkonto `erik` angelegt; kein Container angefasst;
alice/bob nicht berührt; Port 18080 nicht berührt. Artefakte liegen in `/tmp/jmapgap/`.

Zurückgeblieben sind zwei Testmails im Konto `dave` (Entwurf + zugestellte, jetzt in Junk) —
absichtlich, als Beleg für §6/§7 nachvollziehbar.
