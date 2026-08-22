# Messung für M-5 / M-6 (Ordner), Stalwart v0.16.18, 21.08.2026

Alles echt aufgerufen, nichts vermutet.

## `Mailbox/set create` nimmt alle drei Felder an
```jsonc
create: { m: { name:"Archiv-Test", role:"archive", sortOrder:7, isSubscribed:true } }
→ {"created":{"m":{"id":"h"}}}
```
Zurückgelesen unverändert: `{"name":"Archiv-Test","role":"archive","sortOrder":7,"isSubscribed":true}`.

## `role` lässt sich auch NACHTRÄGLICH setzen (`update`)
| Rolle | Ergebnis |
|---|---|
| `archive` | **OK** |
| `important` | **OK** |
| `snoozed` | **OK** |
| `scheduled` | **OK** |
| `memos` | **OK** |
| `junk` | `invalidProperties: "A mailbox with role 'junk' already exists."` |
| `templates` | `invalidProperties: "Invalid property or value."` |

**Zwei Regeln für die UI, beide gemessen:**
1. **Rollen sind eindeutig je Konto.** Eine schon vergebene Rolle darf nicht angeboten werden —
   der Server lehnt sonst ab. Die belegten Rollen stehen in der `Mailbox/get`-Antwort.
2. **Nicht jede RFC-8621-Rolle existiert hier.** `templates` wird abgewiesen. Die anbietbare
   Liste ist also nicht „alles aus dem RFC", sondern die fünf oben plus die vom Server bereits
   vergebenen Standardrollen (`inbox`, `drafts`, `sent`, `trash`, `junk`, `archive` …).
   Anbieten heißt: aus der erlaubten Liste **minus** der bereits vergebenen.

## Warum das zählt
Ohne `role` erkennt kein anderer Client (Telefon, Thunderbird) einen selbst angelegten Ordner
als Archiv. Und `sortOrder`/`isSubscribed` bleiben heute rein lokal: wer die Ordner am Rechner
sortiert, findet am Telefon die alte Reihenfolge vor.
