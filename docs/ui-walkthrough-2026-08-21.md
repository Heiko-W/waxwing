# UI-Walkthrough Waxwing — 21. August 2026

> Vier parallele Bereichsdurchläufe — Kalender, Kontakte, Einstellungen, Mail/App-Hülle/Dateien —
> hier zu **einer** Liste zusammengeführt. Jeder Befund trägt einen Beleg: Screenshot,
> Konsolenausgabe, Messwert oder JMAP-Antwort. **Eine Ursache steht nur dort, wo ein
> Quellbericht sie mit Datei und Zeile belegt hat**; wo ein Bericht einen Vorbehalt notiert hat,
> steht der Vorbehalt beim Befund.

## Wie geprüft wurde

| | |
|---|---|
| Anwendung | Waxwing **v0.14.0**, Vite-Dev-Server mit `WAXWING_E2E=1` auf `http://localhost:5173` |
| Server | lokale **Stalwart-Fixture v0.16** in Docker auf `http://localhost:18080` |
| Durchläufe | vier parallele Playwright-Durchläufe, je Bereich einer, mit eigenem Konto (siehe Einschränkung unten) |
| Viewports | Desktop 1280×900 · Tablet 820×1180 · Phone 390×844 — Phone und Tablet mit `hasTouch`, also unter `pointer: coarse`. Der Einstellungs-Durchlauf zusätzlich 1920×1080, 1280×700 und 414×896 |
| Designs | hell und dunkel |
| Sprache | Deutsch (`de-DE`), Zeitzone `Europe/Berlin` |
| Belege | Screenshots unter `/tmp/waxwing-walkthrough/shots/`, mitgelesener JMAP-Verkehr, Gegenproben per `curl` direkt gegen die Fixture |

**Geprüft wurde gegen die Fixture, nicht gegen die Produktivinstanz.** Stalwart läuft dort in
derselben Hauptversion (v0.16), die unten zitierten Serverantworten sind deshalb übertragbar —
aber **nicht bewiesenermaßen identisch**. Wo der Server Verursacher oder Mitverursacher ist,
steht der Fall zusätzlich im Abschnitt [Serverseitig](#serverseitig).

**Zur Kontotrennung:** Kontakte lief als `bob@waxwing.test`, Einstellungen als
`carol@waxwing.test` — Kalender und Mail/App-Hülle/Dateien liefen **beide** als
`alice@waxwing.test`, und der Mail-Durchlauf hat seine Sendeproben in `bob@waxwing.test`
abgelegt (12 Testnachrichten, dort bewusst nicht aufgeräumt, weil parallel geprüft wurde). Die
Durchläufe waren also nicht vollständig voneinander isoliert.

**Was der Aufbau nicht hergibt:** Der Vite-Dev-Server liefert Lazy-Chunks einzeln über das Netz
und ohne Service-Worker aus. Ein Produktionsbuild wurde nicht geprüft; App und Fixture wurden
während der Durchläufe nicht neu gestartet. Befund **T3**, Befund **G4** und drei Einträge unter
[Nicht reproduzierbar](#nicht-reproduzierbar) tragen deshalb einen ausdrücklichen Vorbehalt.

## Überblick

| Gruppe | Bereich | Anzahl | davon blockierend |
|---|---|---|---|
| **T** | Kalender/Termine | 15 | 3 |
| **N** | Kontakte | 14 | 3 |
| **G** | Einstellungen | 15 | 1 |
| **M** | Mail, App-Hülle, Dateien | 12 | 1 |
| **U** | übergreifend | 2 | — |
| | **Summe** | **58** | **8** |

Die Kürzel **T · N · G · M · U** sind neu vergeben, damit sie weder mit **A–E**
([`ui-audit.md`](./ui-audit.md)) noch mit **R · S · K · Z · F**
([`ui-review-2026-08-20.md`](./ui-review-2026-08-20.md)) kollidieren. Innerhalb jeder Gruppe
stehen die Befunde nach Schwere: blockierend, dann störend, dann kosmetisch. Sortiert wird
ausschließlich nach Schwere, nicht nach Aufwand — der ist hier nicht bekannt.

## Stand der Umsetzung (21.08.2026)

**Alle 58 Befunde sind bearbeitet: 54 behoben, 4 begründet zurückgewiesen.** Die Arbeit lief in
vier parallelen Durchgängen je Gruppe, danach eine Sichtprüfung im Browser, aus der neun
Nachbesserungen hervorgingen.

| Gruppe | behoben | zurückgewiesen | wer |
|---|---|---|---|
| **T** Kalender | 14 | 1 (T15) | vier Commits, plus eine Nachbesserung an T1 |
| **N** Kontakte | 13 | 1 (N13) | sieben Commits |
| **G** Einstellungen | 15 | — | fünf Commits |
| **M** + **U** Mail/Hülle/Dateien/Anmeldung | 12 | 2 (M5, M6) | acht Commits |

### Die vier Zurückweisungen

- **T15** — die gemessenen 34 × 34 px stammten aus einem Playwright-Kontext **ohne** `hasTouch`,
  in dem der Browser `pointer: fine` meldet und `tokens.css` korrekterweise den kleineren Wert
  liefert. Mit `hasTouch` messen dieselben Schaltflächen 44 × 44 px. **Der Befund war ein
  Messfehler dieser Prüfung**, nicht ein Fehler der Anwendung — in der Sichtprüfung
  gegengeprüft.
- **N13** — eine doppelte E-Mail-Adresse ist kein Fehler: RFC 9553 erlaubt dieselbe Adresse mit
  verschiedenen `contexts`. Verhindern verbietet gültige Daten, Zusammenführen verliert welche,
  und ein Hinweis ohne nächsten Schritt ist genau die Meldungsart, die dieses Repo sonst
  ausschließt.
- **M5** — die Sortierung nach Betreff ordnet serverseitig falsch. Clientseitiges Nachsortieren
  würde eine seitenweise nachgeladene Liste in sich widersprüchlich machen: schlimmer als das
  Symptom.
- **M6** — die Spaltenbreiten 340/480 auf dem Tablet sind eine bereits belegte Entscheidung
  (`MailScreen.tsx:326‑339`, Vorbild iPad Mail) und werden nicht ohne neuen Grund umgestoßen.

### Zwei Befunde, deren Ursache eine andere war als vermutet

- **T1** war mit der `uid`-Verknüpfung zunächst **nicht** behoben. Die erste Korrektur war gegen
  jsdom grün und scheiterte gegen einen echten Stalwart: `draftToEvent()` schickt kein `uid`,
  Stalwart vergibt von sich aus keins, und damit fehlte der Verknüpfungsschlüssel ausgerechnet
  bei den Terminen, die Waxwing selbst angelegt hat — bei fremden hätte es funktioniert.
  Gefunden hat das der E2E-Test, nicht die 3800 Unit-Tests. Die Verknüpfung läuft jetzt über
  eine Signatur aus `start`, `duration`, `title`, `calendarIds` und `showWithoutTime`;
  `timeZone` ist bewusst nicht darin, weil die expandierte Antwort `Etc/UTC` sagt, wo ein
  direkter Lesevorgang `null` sagt (derselbe Widerspruch wie in **T12**).
- **U2** lag nicht am veralteten lokalen Zustand, sondern an einer Vererbungslücke:
  `packages/jmap` verzweigt die Fehlerklasse an der Form des Antwortkörpers, nicht am Transport.
  Stalwart beantwortet ein abgelehntes Passwort mit `application/problem+json`, daraus wird ein
  `JmapProblemError` — **keine** Unterklasse von `JmapHttpError`. `error instanceof
  JmapHttpError` war damit für jeden echten 401 falsch. Folge: ein vertipptes Passwort zeigte
  „Etwas ist schiefgelaufen" **und** bot daneben an, die lokalen Daten zu löschen. Dieselbe
  Lücke war in M3.3 schon einmal privat in `sync/engine/conflict.ts` geschlossen worden;
  `httpStatusOf` steht jetzt in `packages/jmap` und wird von beiden Stellen benutzt.

### Neun Nachbesserungen aus der Sichtprüfung

Die Sichtprüfung im Browser fand neun Punkte, die kein Unit-Test sehen konnte — darunter **zwei,
die durch die Korrekturen selbst entstanden waren**: die neue Fokusführung schob auf dem Phone
den Zurück-Link aus dem Bild (**G5**), und die neuen `~all`-Links machten einen Kontakt-Deeplink
alltäglich, bei dem auf dem Phone die Karte nie ankam (**F3**) — Kontaktkarten erreichten die
lokale Kopie nur über die `ContactCard/query` der **Listenspalte**, die unterhalb von 40 em gar
nicht rendert. Die Replik meldete korrekt „keine Zeile", was zeichengleich ist mit „gibt es
nicht".

Die übrigen sieben: **M1** hatte kein Bedienelement zum Umbenennen, **G6** war toter CSS-Code
(Medienabfrage vor der Regel, die sie überschreiben sollte), **G2** zog in der Identitätenliste
einen zweiten Rahmen, **F2** schob „Weitere Aktionen" aus dem Bild, **F1** schrumpfte die
Kalenderüberschrift auf „A…", **N2** ließ das Wertfeld schmaler als das Menü daneben.

---

## T — Kalender/Termine

### T1 · Termine lassen sich weder ändern noch löschen — Waxwing schreibt mit synthetischen Ids

- **Schwere:** blockierend
- **Schritte:** (1) Als `alice@waxwing.test` anmelden, „Kalender" öffnen. (2) „Neuer Termin" →
  Titel „Leitbefund Termin", Beginn `21.08.2026, 16:00` → „Speichern"; der Termin erscheint.
  (3) Auf den Chip klicken → „Termin bearbeiten". (4) Titel ändern, Beginn auf
  `22.08.2026, 08:00` → „Speichern". (5) Im selben Dialog „Löschen".
- **Erwartet:** Schritt 4 speichert die Änderung, Schritt 5 entfernt den Termin.
- **Beobachtet:** Anlegen gelingt. Ändern und Löschen scheitern bei **jedem** Termin: Der Dialog
  bleibt offen, es erscheint der Toast „Der Termin konnte nicht gespeichert werden.", im Raster
  ändert sich nichts. Per `curl` liegt der Termin danach unverändert auf dem Server — es geht
  nichts verloren, es kommt nur nichts an.
- **Beleg:** Die Abfrage der Oberfläche läuft mit `expandRecurrences: true` und liefert
  `"ids":["eaaaaa0"]` statt `["0"]`. Der Schreibversuch darauf:
  `notUpdated → invalidProperties, "Updating synthetic ids is not yet supported."` bzw.
  `notDestroyed → "Deleting synthetic ids is not yet supported."`.
  Gegenprobe per `curl`: dieselbe Abfrage **ohne** `expandRecurrences` liefert `"ids":["0"]`,
  derselbe Patch an `"0"` ergibt `"updated":{"0":null}`, `destroy` ergibt `"destroyed":["0"]`.
  Der von Waxwing gebaute Rumpf wird also unverändert akzeptiert — es scheitert allein an der Id.
  Screenshots: `/tmp/waxwing-walkthrough/shots/kalender-90-leitbefund-angelegt.png`,
  `…/kalender-91-leitbefund-aendern-fehlgeschlagen.png`,
  `…/kalender-92-leitbefund-loeschen-fehlgeschlagen.png`.
- **Ursache:** `apps/web/src/calendar/calendar-client.ts` setzt in `eventsInRange()` **immer**
  `expandRecurrences: true` (Zeile 135) und verwendet die daraus gewonnenen Ids unverändert in
  `updateEvent()` (Zeile 164) und `destroyEvent()` (Zeile 171). Ids einer expandierten Abfrage
  identifizieren Vorkommen, nicht Objekte. `isEditable()` (Zeile 62 ff.) hält Serientermine
  korrekt vom Editor fern — ein Einzeltermin trägt kein `recurrenceId` und gilt deshalb als
  bearbeitbar, obwohl seine Id aus derselben expandierten Abfrage stammt.
- **Serveranteil:** siehe [Serverseitig](#serverseitig), Punkt 1.

### T2 · Monatsraster: ein einziger Termin sprengt die Spaltenbreiten — auf dem Phone fehlen 4 von 7 Tagen

- **Schwere:** blockierend (Phone) · störend (Tablet und Desktop mit langen Titeln)
- **Schritte:** Kalender mit mindestens einem Termin öffnen, dessen Titel länger als ein paar
  Zeichen ist; auf Phone, Tablet und Desktop ansehen. Zusatzfall: Termin mit 300-Zeichen-Titel.
- **Erwartet:** Sieben gleich breite Spalten, Titel werden gekürzt, das Raster passt in die Fläche.
- **Beobachtet:** **Phone (390 px):** nur Mo, Di und ein Teil von Mi sichtbar; **Do, Fr, Sa und So
  fehlen vollständig** und sind auch nicht erscrollbar. Die Wochentagsköpfe stehen über der vollen
  Breite und passen zu keiner Spalte mehr. Gemessen: Raster 342 px breit, Rasterinhalt 655 px.
  **Tablet (820 px):** alle sieben Spalten da, Fr/Sa/So auf 41 px zusammengedrückt.
  **Desktop (1280 px):** mit 300-Zeichen-Titel 2 von 7 Spalten außerhalb (Raster 1136 px,
  Inhalt 2309 px).
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-71-phone-monat.png`,
  `…/kalender-71-tablet-monat.png`, `…/kalender-30-langer-titel-layout.png`.
  Gegenprobe (bewusst herbeigeführt, `page.route` mit leerer Ergebnisliste): derselbe Phone-Monat
  **ohne Termine** ergibt sieben Spalten zu je 49 px und keinen Überlauf
  (`…/kalender-81-phone-leer.png`) — die Chips sind die Ursache, nicht der Viewport.
- **Ursache:** `apps/web/src/calendar/calendar.module.css`: `.grid` nutzt
  `grid-template-columns: repeat(7, 1fr)`; `1fr` ist `minmax(auto, 1fr)`. Die Rasterzelle `.day`
  (Zeile 100 ff.) hat kein `min-inline-size: 0` — nur der innere `.dayEvents`-Container hat es.
  Damit setzt der längste Titel die Mindestbreite seiner Spalte, und `.grid { overflow: hidden }`
  schneidet den Überschuss ab.

### T3 · Offline: Klick auf eine Tageszelle leert die gesamte Anwendung

- **Schwere:** blockierend
- **Schritte:** Kalender öffnen, Verbindung trennen (`context.setOffline(true)`), auf eine leere
  Tageszelle klicken.
- **Erwartet:** Entweder eine Meldung „nur mit Verbindung möglich" — die „+"-Schaltfläche zeigt
  genau das korrekt an — oder ein Dialog mit einem Fehler beim Speichern.
- **Beobachtet:** Der Bildschirm wird vollständig weiß, `document.body.innerHTML` ist danach leer
  (Länge 0), `#main` existiert nicht mehr. Auch nach Wiederherstellen der Verbindung kommt die
  Anwendung nicht zurück; nur ein Reload hilft, und der meldet ab (M8).
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-98-offline-leerer-bildschirm.png`,
  `…/kalender-99-offline-danach-online.png`. Konsole:
  `TypeError: Failed to fetch dynamically imported module: http://localhost:5173/src/calendar/EventDialog.tsx`
  und `The above error occurred in one of your React components … ChunkErrorBoundary`.
- **Ursache:** `CalendarPage.tsx` gattert den Offline-Fall nur an der „+"-Schaltfläche (Zeile 289,
  `unavailableReason={online ? undefined : t('calendar.offline')}`). Die Tageszelle (Zeile 424)
  und der Termin-Chip (Zeile 436) rufen denselben Dialog ohne diese Prüfung auf. Der Dialog ist
  ein `lazy()`-Chunk (Zeile 44); offline scheitert sein Nachladen, und die `ChunkErrorBoundary`
  rendert nichts.
- **Vorbehalt (aus dem Quellbericht übernommen):** Gegen den Vite-Dev-Server reproduziert. Im
  Produktions-Build mit Service-Worker kann derselbe Chunk vorab im Cache liegen, dann bliebe der
  weiße Bildschirm aus. Die **Lücke in der Offline-Sperre** — Tageszelle und Chip sind nicht
  gesperrt, die „+"-Schaltfläche schon — besteht davon unabhängig: offline lässt sich der Dialog
  über die Zelle öffnen und ausfüllen, und das Speichern muss dann scheitern.

### T4 · Mehrtägige ganztägige Termine erscheinen nur am ersten Tag

- **Schwere:** störend
- **Schritte:** Per `curl` einen ganztägigen Termin über drei Tage anlegen
  (`start: "2026-08-12T00:00:00"`, `duration: "P3D"`, `showWithoutTime: true`), Monatsansicht
  August 2026 öffnen.
- **Erwartet:** Der Termin steht am 12., 13. und 14. August.
- **Beobachtet:** Er steht ausschließlich am 12. August; der 13. und 14. sind leer. In der
  Wochenansicht taucht er gar nicht auf. Ein mehrtägiger Termin ist damit unsichtbar, sobald man
  auf den zweiten oder dritten Tag schaut.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-50-monat-gefuellt.png`; Seitentext
  `… | 12 | Mehrtaegig ganztaegig | 13 | 14 | 15 …`.
- **Ursache:** `CalendarPage.tsx` Zeile 192 ff.: `byDay` wird ausschließlich über
  `placed.startsAt` geschlüsselt, `endsAt` wird für die Platzierung nicht ausgewertet.
- **Nebenbefund:** Über die Oberfläche lässt sich ein mehrtägiger ganztägiger Termin gar nicht
  erst anlegen — mit „Ganztägig" verschwindet das Feld „Dauer in Minuten", und `draftToEvent()`
  schreibt fest `duration: "P1D"` (`calendar-client.ts` Zeile 77).

### T5 · Fehlerzustand zeigt gleichzeitig veraltete Termine, als wären sie gültig

- **Schwere:** störend
- **Schritte** (Fehler **bewusst herbeigeführt**): August 2026 laden lassen, alle
  `CalendarEvent/*`-Aufrufe per `page.route` mit HTTP 500 beantworten, „Nächster Monat" klicken.
- **Erwartet:** Kopfzeile „September 2026", darunter entweder nur die Fehlermeldung oder ein
  erkennbar leeres Raster.
- **Beobachtet:** Die Meldung „Der Kalender konnte nicht geladen werden." wird **über** dem Raster
  eingeblendet, das Raster bleibt darunter stehen und zeigt im September einen Termin, der aus der
  **August**-Abfrage stammt. Nach „Erneut versuchen" kommt ein zweiter Termin hinzu, der vorher
  fehlte. Wer die Meldung überliest, sieht einen scheinbar vollständigen, tatsächlich lückenhaften
  Monat. Der Fehlerblock (rund 440 px leere Höhe) schiebt zudem die letzte Rasterzeile aus dem
  Sichtfeld. Messung: `{fehlertext: true, rasterDa: true, spinnerDa: true}` — alle drei Zustände
  gleichzeitig im DOM.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-61-fehlerzustand.png`,
  `…/kalender-62-nach-retry.png`.
- **Ursache:** `CalendarPage.tsx` Zeile 149 ff.: im `catch` wird nur `setFailed(true)` gesetzt,
  `events` behält den alten Inhalt; Zeile 298 ff. rendert `failed` **zusätzlich** zur Ansicht,
  nicht anstelle von ihr.

### T6 · Die Wochenansicht lässt sich nicht wochenweise navigieren

- **Schwere:** störend
- **Schritte:** Kalender öffnen (Fokus 21.08.2026), Ansicht „Woche" (zeigt Mo 17. – So 23. August),
  rechte Pfeilschaltfläche drücken. Ergänzend: in der Monatsansicht eine Tageszelle anklicken.
- **Erwartet:** Der Pfeil schaltet eine Woche weiter; ein Klick auf einen Tag wählt diesen Tag aus.
- **Beobachtet:** Die Pfeile heißen auch in der Wochenansicht „Voriger Monat" / „Nächster Monat"
  und springen einen **ganzen Monat** — von Mo 17.–So 23. August direkt auf Mo 21.–So 27.
  September (`…/calendar/2026-09-21`). Die dazwischenliegenden Wochen sind nicht erreichbar. Ein
  Klick auf eine Tageszelle öffnet stattdessen „Neuer Termin", die URL und damit der Fokustag
  ändern sich nicht. Die Überschrift lautet in der Wochenansicht weiterhin „August 2026" statt
  eines Wochenbereichs.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-04-woche-navigation.png`,
  `…/kalender-52-woche-gefuellt.png`; Protokoll `Mo 17 … So 23` → nach „>" → `Mo 21 … So 27`.
- **Ursache:** `CalendarPage.tsx`: die Pfeile rufen ansichtsunabhängig
  `goto(addMonths(focus, ±1))` (Zeile 210/224). `MonthView` bekommt ein `onPick`-Callback
  übergeben (Zeile 320), verwendet es aber nirgends — die Tageszelle ruft ausschließlich `onCreate`
  (Zeile 424). `onPick` ist toter Code.

### T7 · Fehlgeschlagenes Löschen meldet „konnte nicht gespeichert werden" und nennt den Grund nicht

- **Schwere:** störend
- **Schritte:** Einen Termin öffnen, „Löschen" drücken (scheitert derzeit immer, siehe T1).
- **Erwartet:** Eine Meldung, die von *Löschen* spricht und den Grund des Servers wiedergibt.
- **Beobachtet:** Toast „Der Termin konnte nicht **gespeichert** werden." — dieselbe Meldung wie
  beim Speichern. Der vom Server mitgeschickte Grund (`invalidProperties` / „Deleting synthetic
  ids is not yet supported.") erscheint nirgends, auch nicht in der Konsole. Der
  Bearbeiten-Dialog bleibt offen, was wirkt, als sei nur das Speichern misslungen.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-92-leitbefund-loeschen-fehlgeschlagen.png`;
  `de/common.json` kennt nur `calendar.saveFailed`, kein Gegenstück fürs Löschen.
- **Ursache:** `CalendarPage.tsx` Zeile 170 ff.: `run()` wird für Anlegen, Ändern und Löschen
  gleichermaßen benutzt und meldet im `catch` immer `t('calendar.saveFailed')`. Die geworfene
  `CalendarSetError` trägt `type` und `description` (`calendar-client.ts` Zeile 186 ff.); beides
  wird verworfen.

### T8 · „+N weitere" wird abgeschnitten, die verborgenen Termine sind im Monat nicht erreichbar

- **Schwere:** störend
- **Schritte:** An einem Tag fünf Termine anlegen, Monatsansicht öffnen (Desktop 1280×900).
- **Erwartet:** Ein Hinweis „+2 weitere", der anklickbar oder wenigstens vollständig lesbar ist.
- **Beobachtet:** Die Zeile „+2 weitere" wird an der Zellgrenze waagerecht durchgeschnitten, etwa
  die obere Hälfte der Schrift ist zu sehen. Sie ist kein Bedienelement — ein Klick trifft die
  Tageszelle darunter und öffnet „Neuer Termin". Die beiden verborgenen Termine sind in der
  Monatsansicht auf keinem Weg erreichbar. Auf dem Tablet ist die Zeile vollständig sichtbar, auf
  dem Desktop nicht; die Zeilenhöhe wächst nicht mit.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-50-monat-gefuellt.png` (Zelle 19. August).
- **Ursache:** `.grid { grid-auto-rows: 1fr; overflow: hidden }` in `calendar.module.css`
  (Zeile 77 ff.) zusammen mit der festen Kappung auf drei Chips (`CalendarPage.tsx` Zeile 428,
  `dayEvents.slice(0, 3)`) und dem Hinweis als reinem `<span>` (Zeile 445).

### T9 · Verschachtelte Schaltflächen im Monatsraster (ungültiges HTML, Konsolenfehler)

- **Schwere:** störend
- **Schritte:** Kalender mit mindestens einem Termin öffnen, Browserkonsole beobachten.
- **Erwartet:** Keine Konsolenfehler.
- **Beobachtet:** Bei **jedem** Aufruf des Kalenders zwei React-Fehler: „In HTML, `<button>` cannot
  be a descendant of `<button>`. This will cause a hydration error." Der Klick auf den Chip
  funktioniert dank `stopPropagation`, aber die Verschachtelung ist ungültiges HTML; das Verhalten
  bei Tastatur und Hilfstechnik ist damit nicht definiert. Die Meldungen verrauschen außerdem jede
  Konsolendiagnose im Kalender.
- **Beleg:** Konsolenprotokoll aller Läufe; Stack zeigt
  `<button class="_day_…" aria-label="Montag, 24. August 2026"> › <span class="_dayEvents…"> › <button class="_chip_…">`.
- **Ursache:** `CalendarPage.tsx` Zeile 413 (`<button>` für die Tageszelle) und Zeile 432
  (`<button>` für den Chip darin).

### T10 · Wochenansicht auf dem Phone zeigt keine Termintitel

- **Schwere:** störend
- **Schritte:** Phone 390×844, Kalender öffnen, über das Menü „Kalenderansicht" die Woche wählen.
- **Erwartet:** Man erkennt, welcher Termin wann liegt.
- **Beobachtet:** Sieben Spalten zu je rund 40 px. In den Terminblöcken steht nur noch die Uhrzeit
  („08:00", „09:00", „10:00"), der Titel ist vollständig abgeschnitten; nur bei einem breiteren
  Block ist „Ter…" zu erahnen. Die Wochenansicht beantwortet auf dem Phone damit nicht, *was*
  ansteht. Zusätzlich ist die oberste Stundenmarke „00 Uhr" halb vom Kopfbereich verdeckt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-73-phone-woche.png`.

### T11 · Ort, Teilnehmer und Wiederholung: weder anzeigbar noch eingebbar

- **Schwere:** störend
- **Schritte:** Per `curl` einen Termin mit `locations` („Besprechungsraum 3, Verl") und
  `participants` (Bob Baker) anlegen, in der Oberfläche öffnen; ebenso „Neuer Termin" öffnen.
- **Erwartet:** Zumindest eine Anzeige der vorhandenen Angaben.
- **Beobachtet:** Der Dialog bietet ausschließlich Titel, Beginnt (bzw. Tag), Ganztägig, Dauer in
  Minuten, Kalender, Notizen. **Ort und Teilnehmer werden nirgends gezeigt.** Es fehlt jede
  Möglichkeit, eine Wiederholung anzulegen, und es gibt kein Endzeit-Feld, nur eine Dauer in
  Minuten. Bemerkenswert: `calendar-client.ts` fordert `locations` und `participants` in
  `EVENT_PROPERTIES` (Zeile 86 ff.) ausdrücklich vom Server an — die Daten liegen im Client vor
  und werden nur nicht dargestellt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-55-ort-teilnehmer.png`,
  `…/kalender-10-dialog-neu.png`; Feldinventar: `INPUT(text)`, `INPUT(datetime-local)`,
  `INPUT(checkbox)`, `INPUT(number)`, `SELECT`, `TEXTAREA` — mehr gibt es nicht.
- **Einordnung:** Dass Serientermine nicht bearbeitbar sind, ist gewollt und wird dem Nutzer
  erklärt (siehe „Geprüft und in Ordnung"). Das Fehlen von Ort und Teilnehmern in der **Anzeige**
  ist davon unabhängig.

### T12 · Die Agenda zeigt „Etc/UTC" neben ganztägigen Terminen

- **Schwere:** störend
- **Schritte:** Per `curl` einen ganztägigen Termin anlegen (`showWithoutTime: true`, `timeZone`
  nicht gesetzt), Ansicht „Agenda" öffnen.
- **Erwartet:** „Sa., 29. Aug. · Ganztägig · Zukunft ganztaegig" — ohne Zeitzone, denn ein
  ganztägiger Termin hat keine.
- **Beobachtet:** Unter dem Titel steht „Etc/UTC", an genau der Stelle, an der sonst eine echte
  abweichende Zone steht (bei einem Tokio-Termin korrekt „Asia/Tokyo"). Das legt nahe, der
  ganztägige Termin liege in einer fremden Zone.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-95-agenda-zeitzone.png`.
- **Ursache (geteilt):** *Server:* `CalendarEvent/get` mit direkter Id liefert `timeZone: null`,
  dieselbe Eigenschaft desselben Termins über die expandierte Abfrage liefert `"Etc/UTC"` (per
  `curl` gegengeprüft). *Oberfläche:* `CalendarPage.tsx` Zeile 489 prüft nur
  `zoneDiffersFromLocal(timeZone)` und klammert `placed.allDay` nicht aus; `jscalendar-time.ts`
  Zeile 146 ff. behandelt jede nicht-leere Zone als anzeigewürdig. Siehe
  [Serverseitig](#serverseitig), Punkt 2.

### T13 · „Löschen" wird ohne Rückfrage ausgeführt

- **Schwere:** störend
- **Schritte:** Einen Termin öffnen, „Löschen" drücken.
- **Erwartet:** Eine Rückfrage oder eine Möglichkeit zum Rückgängigmachen — Löschen ist die
  einzige nicht umkehrbare Aktion dieses Bildschirms.
- **Beobachtet:** Der Aufruf geht sofort und ohne jede Rückfrage an den Server. Dass derzeit
  nichts passiert, liegt allein an T1; sobald T1 behoben ist, löscht ein Fehlklick den Termin
  unwiderruflich. Die Schaltfläche steht zudem unmittelbar links neben „Abbrechen".
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-13-dialog-bearbeiten.png` (Reihenfolge
  Löschen · Abbrechen · Speichern).
- **Ursache:** `CalendarPage.tsx` Zeile 363 ff. ruft `run(() => client.destroyEvent(target.id))`
  direkt aus `onDestroy`.

### T14 · Ungültige Dauer: nur die native Browser-Blase, keine Meldung der App

- **Schwere:** kosmetisch
- **Schritte:** „Neuer Termin", Titel füllen, „Dauer in Minuten" auf `-30`, `0` oder leer setzen,
  „Speichern" drücken.
- **Erwartet:** Eine Rückmeldung im Dialog.
- **Beobachtet:** Es geht **kein** JMAP-Aufruf hinaus (gemessen: 0 Aufrufe), der Dialog bleibt
  offen und wirkt reglos. Einzige Rückmeldung ist die native Browser-Blase („Value must be greater
  than or equal to 1."); die App selbst zeigt nichts an. Leert man das Feld, springt der Wert
  sofort auf `0` (React-kontrolliert über `Number('')`), das Feld lässt sich also nicht „leer
  machen und neu tippen". `999999999` Minuten (rund 1900 Jahre) wird dagegen anstandslos angelegt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-40-dauer-negativ.png`,
  `…/kalender-40-dauer-leer.png`; Feldzustand
  `{"value":"-30","valid":false,"rangeUnderflow":true,"msg":"Value must be greater than or equal to 1."}`.
- **Vorbehalt (aus dem Quellbericht übernommen):** Die Sprache nativer Validierungsblasen richtet
  sich nach der Oberflächensprache des Browsers, nicht nach der Seitensprache; im Testaufbau
  (headless Chromium, englische UI-Sprache) ist Englisch erwartbar und **kein belastbarer
  i18n-Befund**. Belegbar ist allein, dass die App selbst keine Meldung ausgibt. Derselbe Fall im
  Kontaktformular: N9.
- **Randnotiz:** Der Dialog kennt keine Endzeit, nur eine Dauer — „Endzeit vor Startzeit" ist
  hier also die negative Dauer.

### T15 · Tippziele im Kalenderkopf auf dem Phone 34 × 34 px

- **Schwere:** kosmetisch
- **Schritte:** Phone 390×844, Kalender öffnen, Größe der Kopfschaltflächen messen.
- **Erwartet:** Mindestens 44 × 44 px unter `pointer: coarse`.
- **Beobachtet:** „Voriger Monat" 34 × 34, „Nächster Monat" 34 × 34, „Kalenderansicht" 38 × 34,
  „Neuer Termin" 34 × 34 — dicht nebeneinander in einer Reihe mit den beiden Schaltflächen der
  Hülle. Auf dem Tablet wurden insgesamt 40 Elemente unter 44 px gezählt; ein Teil davon
  (Tageszellen, Chips) ist von Natur aus klein, die vier Kopfschaltflächen sind es nicht.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-71-phone-monat.png`; Messwerte im Protokoll
  von `cal-09-responsive.mjs`.

---

## N — Kontakte

> Die Ausgangsmeldung „Beim Anlegen eines Kontakts mit E-Mail-Adressen gibt es Probleme" ist
> berechtigt, aber nicht so, wie sie klingt: **Es gehen keine Daten verloren.** Ein über die
> Oberfläche angelegter Kontakt mit drei E-Mail-Adressen landet vollständig, in der richtigen
> Reihenfolge und mit den richtigen `contexts` auf dem Server (per `curl` nachgelesen). Den
> Eindruck erzeugen drei Dinge um das Anlegen herum: N2, N3 und N1.

### N1 · Kontakte lassen sich in der Ansicht „Alle Kontakte" nicht öffnen

- **Schwere:** blockierend
- **Schritte:** (1) Anmelden, links „Kontakte" (landet auf `/contacts` = „Alle Kontakte").
  (2) Auf eine Kontaktzeile klicken. (3) Alternativ: Liste fokussieren, `Pfeil runter`, `Enter`.
- **Erwartet:** Der Kontakt öffnet sich im Detailbereich.
- **Beobachtet:** Nichts passiert. Die URL bleibt `/contacts`, `aria-selected` bleibt `false`, der
  Detailbereich zeigt weiter „Wählen Sie einen Kontakt aus, um die Details zu sehen." Getestet mit
  Einfachklick, Doppelklick, Klick auf den Namens-Span und über die Tastatur — alle wirkungslos.
  Wählt man stattdessen links das konkrete Adressbuch (`/contacts/b`), funktioniert derselbe Klick
  sofort. Betrifft auch die **Suchergebnisse** in „Alle Kontakte" und ist auf dem **Phone die
  Standardansicht** — dort ist der Kontaktbereich ohne Umweg über den Adressbuch-Drawer komplett
  unbenutzbar.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-bug-alle-kontakte-klick.png`,
  `…/kontakte-auswahl-tastatur.png`, `…/kontakte-phone-alle-kontakte-klick.png`,
  `…/kontakte-alle-kontakte-suche-klick.png`, Gegenprobe `…/kontakte-detail-im-buch.png`.
  Keine Konsolenfehler, kein JMAP-Verkehr beim Klick.
- **Ursache:** `ContactList.tsx:88-91` navigiert mit `navigate(contactsPath(bookId, card.id))`. In
  „Alle Kontakte" ist `bookId === undefined`, und `contactsPath`
  (`apps/web/src/app/route/route.ts:231-235`) verwirft in diesem Fall die Karten-Id:
  `if (bookId === undefined) return CONTACTS_PATH`. Ergebnis ist eine Navigation nach `/contacts`,
  also auf die Seite, auf der man schon steht.

### N2 · E-Mail- und Telefon-Eingabefeld im Kontaktformular auf ~26 px zusammengeschrumpft

- **Schwere:** blockierend (Formular praktisch nicht bedienbar)
- **Schritte:** Adressbuch wählen → „Neuer Kontakt" (oder einen Kontakt „Bearbeiten") →
  Abschnitt „E-MAIL" bzw. „TELEFON" ansehen.
- **Erwartet:** Typ-Auswahl links (7,5 rem), daneben ein breites Feld für die Adresse, rechts das X.
- **Beobachtet:** Die Typ-Auswahl wird über die halbe Zeile gestreckt, das Wertfeld ist ein 26 px
  schmaler Streifen unmittelbar links vom X. Man kann hineintippen, sieht aber nie mehr als ein bis
  zwei Zeichen. Gemessene Boundingboxen in **allen drei Viewports** identisch:
  `select` 120 × 39, `input` **26 × 39**, X-Button 34 × 34. Kein horizontales Überlaufen
  (`scrollWidth == clientWidth`), das Feld ist einfach zusammengedrückt. Zusätzlich wird der Text
  der Typ-Auswahl abgeschnitten („Geschäftl" statt „Geschäftlich").
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-formular-alle-felder.png`,
  `…/kontakte-tablet-formular.png`, `…/kontakte-phone-formular.png`,
  `…/kontakte-formular-3-mails.png`.
- **Ursache:** `apps/web/src/contacts/contacts.module.css:536-544` definiert
  `.commType { flex: none; inline-size: 7.5rem }` und `.commValue { flex: 1; min-inline-size: 0 }`.
  `commType` landet laut ausgeliefertem DOM aber auf dem inneren `<select>`, nicht auf dem Wrapper,
  den die `Select`-Komponente rendert. Dieser Wrapper ist das eigentliche Flex-Kind und hat
  `inline-size: 100%` (`apps/web/src/ui/Select.module.css:1-5`) — er beansprucht die volle
  Zeilenbreite und drückt `.commValue` auf das Minimum. Bei der Adresszeile fällt es nicht auf,
  weil dort kein Wertfeld neben dem Typ steht.

### N3 · Nach dem Speichern eines neuen Kontakts: „Dieser Kontakt ist nicht verfügbar."

- **Schwere:** blockierend
- **Schritte:** Adressbuch wählen → „Neuer Kontakt" → Vor-/Nachname und mindestens eine
  E-Mail-Adresse eintragen → „Speichern".
- **Erwartet:** Der neu angelegte Kontakt wird geöffnet und angezeigt.
- **Beobachtet:** Die App springt auf `/contacts/b/<Erstellungs-ID>` und zeigt dauerhaft „Dieser
  Kontakt ist nicht verfügbar." — auch nach 16 s unverändert. Der Kontakt **ist** angelegt und
  steht korrekt in der Liste; klickt man ihn dort an, öffnet er sich unter der echten Server-Id.
  Der Zustand tritt bei **jedem** Anlegen auf.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-bug-nach-speichern-nicht-verfuegbar.png`,
  `…/kontakte-nach-speichern.png`. JMAP-Antwort auf das Anlegen (Server meldet Erfolg, vergibt
  Id `d`):
  `["ContactCard/set",{…,"created":{"4ca20cfd-f86c-4b46-96ce-6931b8e6dcfb":{"id":"d"}}},"c0"]` —
  die App navigiert danach nach `/contacts/b/4ca20cfd-f86c-4b46-96ce-6931b8e6dcfb`, also auf die
  **Erstellungs-Id**, nicht auf `d`.
- **Ursache:** `ContactsScreen.tsx:168-170` navigiert nach dem Anlegen auf
  `contactsPath(targetId, newCardId)`, wobei `newCardId` die `creationId` aus
  `useContactActions.create` ist (`use-contact-actions.ts:45-46`,
  `sync/engine/contact-mutations.ts:53-59`). Ein Replica-Eintrag unter dieser `creationId` ist zu
  diesem Zeitpunkt und danach nicht auffindbar.

### N4 · Adresse bearbeiten löscht stillschweigend `full`, `countryCode`, `timeZone`, `pref` und den Typ

- **Schwere:** störend — **stiller, serverseitig bestätigter Datenverlust**
- **Schritte:** (1) Testkarte per `curl` anlegen (Adresse mit `full`, `countryCode`, `timeZone`,
  `pref: 1`, `contexts: {work: true}`). (2) Kontakt öffnen → „Bearbeiten" → nur „Straße" ändern →
  „Speichern".
- **Erwartet:** Nur die Straße ändert sich. Der Modulkopf von `contact-card-mapping.ts:16-19` sagt
  genau das zu: „every entry-level property the form does not surface … ride through untouched".
- **Beobachtet:** Der Patch ersetzt das komplette Adressobjekt. Vorher `full`, `countryCode`,
  `timeZone`, `pref`, `contexts`; nachher nur noch `{ components: […], isOrdered: true,
  "@type": "Address" }`. Sichtbar wird das sofort: Vor der Bearbeitung stand über der Adresse das
  Typ-Label „Geschäftlich", danach ist es weg.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-label-probe-vorher.png` und `…-nachher.png`;
  gesendeter Patch `{"update":{"g":{… "addresses":{"a1":{"@type":"Address","components":[…]}}}}}`;
  Server-Antwort `"updated":{"g":null}` — kein Fehler, der Verlust ist rein clientseitig.
- **Ursache:** `apps/web/src/contacts/contact-card-mapping.ts:452` baut die Adresse immer frisch
  auf (`const base: Record<string, unknown> = { '@type': 'Address' }`), während die
  Geschwisterfunktionen `formToEmails:366-368`, `formToPhones:380-382` und `formToNotes:466-468`
  korrekt `{ ...entry.original }` als Basis nehmen. **E-Mail-Adressen und Telefonnummern sind
  nicht betroffen** — dort reiten `pref` und `label` sauber durch (im Test nachgewiesen).

### N5 · vCard-Export bricht bei einem Kontakt ohne `uid` komplett ab — ohne Fehlermeldung

- **Schwere:** störend
- **Schritte:** (1) Eine Karte ohne `uid` im Adressbuch (im Test per `curl` erzeugt).
  (2) Toolbar → „Importieren oder exportieren" → Export „vCard 4.0" → „Herunterladen".
- **Erwartet:** Datei wird erzeugt, notfalls mit Hinweis auf übersprungene Karten.
- **Beobachtet:** Kein Download. Der Dialog bleibt unverändert stehen, **keine Fehlermeldung, kein
  Hinweis** — für den Nutzer passiert schlicht nichts.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-export-vcard.png`; Konsole:
  `TypeError: Cannot read properties of undefined (reading 'replace') at escapeText … at toVCard …
  at serializeExport (src/contacts/contact-io.ts:215:10) at ContactImportExportDialog.tsx:94:20`.
  Gegenprobe: nach dem Löschen der `uid`-losen Karten funktionieren beide Exportformate einwandfrei.
- **Ursache:** `packages/jscontact/src/to-vcard.ts:322` —
  `out.push({ name: 'UID', value: escapeText(card.uid) })` ohne Undefined-Behandlung.
- **Vorbehalt (aus dem Quellbericht übernommen):** Die auslösende Karte stammt aus einem eigenen
  `curl`-Aufruf; der Fixture-Server ist insofern beteiligt, als er keine `uid` nachträgt. **Absturz
  und fehlende Fehlermeldung sind aber App-seitig** — der Export darf an einer unvollständigen
  Fremdkarte weder abstürzen noch stumm scheitern.

### N6 · vCard-Import verliert stillschweigend eine E-Mail-Adresse und meldet trotzdem Erfolg

- **Schwere:** störend (stiller Datenverlust)
- **Schritte:** `.vcf` mit einer Karte importieren, die `PROP-ID` und Zeilen ohne `PROP-ID` mischt
  (`EMAIL;PROP-ID=e2;TYPE=work:erste@…`, `EMAIL;TYPE=home:zweite@…`, `EMAIL:dritte@…`), dann
  Toolbar → „Importieren oder exportieren" → Datei wählen → „3 Kontakte importieren".
- **Erwartet:** Drei E-Mail-Adressen im importierten Kontakt, oder wenigstens ein Hinweis auf
  übersprungene Einträge.
- **Beobachtet:** Der Dialog meldet „3 Kontakte importiert." Der Kontakt hat aber nur **zwei**
  Adressen — `erste@import.example` fehlt vollständig, ohne jeden Hinweis.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-import-ergebnis.png`,
  `…/kontakte-import-detail.png`; im JMAP-Request werden nur zwei `emails`-Einträge überhaupt
  gesendet — der Verlust passiert beim Parsen, nicht beim Server.
- **Ursache:** `packages/jscontact/src/from-vcard.ts:159-162`: der Fallback-Key `e${index+1}` teilt
  sich den Namensraum mit explizit gesetzten `PROP-ID`-Werten. Zeile 1 (`PROP-ID=e2`) und Zeile 2
  (Index 1 → Fallback `e2`) kollidieren, die zweite überschreibt die erste. Gleiche Mechanik für
  `tel`, `adr`, `org`, `nick`, `link` u. a.
- **Nebenbefund:** Der Import nimmt eine Adresse **ohne `@`** kommentarlos an, während das Formular
  sie blockiert.

### N7 · Typwechsel bleibt wirkungslos, wenn der Eintrag ein Freitext-`label` trägt

- **Schwere:** störend
- **Schritte:** Kontakt mit einer E-Mail-Adresse `{ contexts: {work: true}, label: "Büro" }` (z. B.
  aus einem vCard-Import mit `LABEL`) → „Bearbeiten" → Typ von „Geschäftlich" auf „Privat" →
  „Speichern".
- **Erwartet:** Die Detailansicht zeigt „Privat".
- **Beobachtet:** Die Detailansicht zeigt weiterhin **„Büro"**. Der Wechsel ist gespeichert
  (`contexts` steht auf `private`), aber unsichtbar — und das `label` kann der Nutzer in der
  Oberfläche nirgends sehen oder ändern.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-label-probe-vorher.png` / `…-nachher.png`;
  Stand per `curl`:
  `"e1": {"address":"buero@example.com","contexts":{"private":true},"pref":1,"label":"Büro"}`.
- **Ursache:** `contact-card-mapping.ts:345-358` (`applyType`) löscht `features` und `contexts`,
  nie aber `label`; `ContactDetail.tsx:311-313` lässt `label` immer gewinnen
  (`const free = entry.label?.trim(); if (free) return free`).

### N8 · Doppelklick auf das X entfernt zwei E-Mail-Zeilen

- **Schwere:** störend
- **Schritte:** Neuer Kontakt, drei E-Mail-Zeilen `a@…`, `b@…`, `c@…` füllen, auf das X der
  **ersten** Zeile doppelklicken.
- **Erwartet:** Eine Zeile weniger.
- **Beobachtet:** **Zwei** Zeilen sind weg, übrig bleibt nur `c@example.com`. Der zweite Klick
  trifft die nachgerutschte Zeile.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-edge-doppelklick-x.png`.
- **Ursache:** `ContactForm.tsx:272-275`, `removeAt` ist rein index-basiert und benutzt den
  Render-Zeit-Index.

### N9 · E-Mail-Adressen mit Umlauten lassen sich nicht speichern — ohne sichtbare Fehlermeldung

- **Schwere:** störend
- **Schritte:** Neuer Kontakt, E-Mail-Adresse `björn.müller@exämple.de` eintragen, „Speichern".
- **Erwartet:** Entweder speichern oder eine Fehlermeldung im Formular.
- **Beobachtet:** Nichts passiert sichtbar — das Formular bleibt stehen, es wird **kein**
  JMAP-Aufruf abgesetzt, und im Formular steht **kein** Fehlertext. Der Submit wird still von der
  nativen `type="email"`-Validierung blockiert (`validity.valid === false`). Dasselbe bei einer
  Adresse ohne `@`. Es gibt in der App **keine eigene Validierung**: kein `aria-invalid`, kein
  Inline-Fehler, kein Fokus-Hinweis. Der Compose-Bereich hat mit `compose/address-validation.ts`
  eine eigene Adressprüfung — das Kontaktformular importiert sie nicht.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-edge-lang-umlaut.png`,
  `…/kontakte-ungueltige-adresse.png`, `…/kontakte-phone-ungueltig.png`;
  `ContactForm.tsx:180-184` setzt kein `noValidate`.
- **Vorbehalt (aus dem Quellbericht übernommen):** Der Text der Browser-Blase kam im Test auf
  Englisch. Die Sprache dieser Blase hängt an der UI-Sprache des Browsers, nicht am Seiten-Locale —
  das englische Wording ist vermutlich ein Artefakt des headless-Chromium und **kein belastbarer
  i18n-Befund**. Belastbar ist, dass die App selbst keine Rückmeldung gibt. Derselbe Fall im
  Kalenderdialog: T14.

### N10 · Phone: Der Adressbuch-Drawer lässt sich mit dem Toggle nicht schließen und bleibt nach der Buchwahl offen

- **Schwere:** störend
- **Schritte** (390×844): (1) Kontakte öffnen → „Adressbücher anzeigen" antippen (Drawer öffnet
  sich). (2) Erneut auf denselben Toggle tippen. (3) Alternativ: im Drawer ein Adressbuch wählen.
- **Erwartet:** (2) Drawer schließt. (3) Drawer schließt nach der Auswahl, wie bei einer
  Ordnerauswahl in der Mail-Ansicht.
- **Beobachtet:** (2) Der Drawer bleibt offen (`nav#waxwing-books-region` behält
  `…booksRegionOpen…`). (3) Nach der Buchwahl bleibt er offen und legt sich als Overlay über die
  Liste; Klicks auf Kontaktzeilen und sogar auf „Speichern" im Formular werden vom Drawer bzw.
  seinem Backdrop abgefangen. Nur `Escape` oder ein Tipp auf den Backdrop schließen ihn.
  Zusätzlich bleibt das `aria-label` des Toggles „Adressbücher anzeigen", obwohl
  `aria-expanded="true"` ist.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-phone-drawer.png`,
  `…/kontakte-phone-nach-buchwahl.png`, `…/kontakte-phone-drawer-nach-buchwahl-toggle.png`;
  Messprotokoll: Toggle→OFFEN, Toggle→**OFFEN**, Escape→zu, Backdrop-Tipp→zu.

### N11 · Telefonnummer und Notiz werden ungetrimmt gespeichert, der `tel:`-Link enthält Leerzeichen

- **Schwere:** kosmetisch
- **Schritte:** Neuer Kontakt, Telefon `"  +49 123 456  "`, Notiz `"   Notiz mit Rand   "`,
  speichern.
- **Erwartet:** Randleerzeichen werden entfernt.
- **Beobachtet:** Auf dem Server stehen die Werte wörtlich mit Leerzeichen (per `curl`
  gegengelesen); in der Detailansicht wird die Notiz mit Einrückung dargestellt. E-Mail-Adressen
  sind **nicht** betroffen — das native `type="email"`-Feld trimmt schon beim Eingeben. Verwandt:
  Der `mailto:`-Link ist korrekt, der Telefon-Link lautet aber `tel:+49 171 1234567` —
  ungeschützte Leerzeichen in einer `tel:`-URI (RFC 3966).
- **Beleg:** `curl`-Antwort für Karte `k`;
  `/tmp/waxwing-walkthrough/shots/kontakte-detail-desktop.png`.
- **Ursache:** `contact-card-mapping.ts:381/383` und `:465/469` — es wird mit `.trim()` auf
  Leerheit geprüft, aber der **ungetrimmte** Wert gespeichert.

### N12 · Eine leergeräumte Bestandsadresse erzeugt ein leeres `Address`-Objekt

- **Schwere:** kosmetisch (in dieser Umgebung folgenlos)
- **Schritte:** Kontakt mit vorhandener Adresse bearbeiten, alle fünf Adressfelder leeren (statt
  das X zu benutzen), speichern.
- **Erwartet:** Die Adresse wird entfernt — so verhalten sich E-Mail und Telefon.
- **Beobachtet:** Die App sendet `"addresses": { "a1": { "@type": "Address" } }`, also ein
  inhaltsloses Adressobjekt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kontakte-edge-leere-adresse.png`; Request und
  `curl`-Gegenprobe.
- **Ursache:** `contact-card-mapping.ts:442` — der Leer-Guard greift nur für neue Zeilen.
- **Vorbehalt (aus dem Quellbericht übernommen):** Der Stalwart-Fixture **verwirft** das leere
  Objekt, `ContactCard/get` liefert danach gar kein `addresses`-Feld mehr, also keine sichtbare
  Geisterzeile. Auf einem Server, der das Objekt behält, wäre eine leere Adresszeile in der
  Detailansicht die Folge.

### N13 · Eine doppelte E-Mail-Adresse wird kommentarlos angenommen

- **Schwere:** kosmetisch
- **Schritte:** Zweimal `doppelt@example.com` eintragen (einmal geschäftlich, einmal privat),
  speichern.
- **Erwartet:** Ein Hinweis oder eine Zusammenführung.
- **Beobachtet:** Beide Einträge werden ohne Hinweis gespeichert und in der Detailansicht zweimal
  untereinander angezeigt.
- **Beleg:** JMAP-Request mit zwei identischen `address`-Werten;
  `/tmp/waxwing-walkthrough/shots/kontakte-liste-sortierung.png`.

### N14 · Vier kleinere Darstellungs- und Beschriftungsmängel

- **Schwere:** kosmetisch
- **Beobachtet und belegt:**
  - **Gruppen-Toolbar wird abgeschnitten:** In der Gruppenansicht steht „‹ Alle Kontakte · Gruppe
    bearbeiten · Gruppe löschen" in der 340 px breiten Listenspalte; „Gruppe löschen" ragt sichtbar
    über den Spaltenrand hinaus (`…/kontakte-gruppe-mit-mitgliedern.png`).
  - **Irreführendes Toolbar-Icon:** „Importieren oder exportieren" benutzt `arrow-down-up`, das wie
    ein Sortier-Umschalter aussieht. Eine Sortieroption gibt es im Kontaktbereich gar nicht
    (`…/kontakte-liste-desktop.png`).
  - **Mehrfach vergebene Accessible Names:** Alle E-Mail-Zeilen tragen dasselbe
    `aria-label="E-Mail"`, alle Typ-Auswahlen dasselbe `aria-label="Typ"`, alle X-Buttons dasselbe
    „E-Mail entfernen". Mit mehreren Zeilen ist per Screenreader nicht unterscheidbar, welche Zeile
    gemeint ist.
  - **Adressanzeige ohne Trennzeichen:** „33415 Verl NRW" — Ort und Region stehen ohne Komma
    direkt nebeneinander (`…/kontakte-detail-desktop.png`).

---

## G — Einstellungen

> Die Ausgangsmeldung „Diverse Darstellungsprobleme bei den Einstellungen" ist reproduzierbar und
> hat im Wesentlichen **eine gemeinsame Ursache** (G2–G4, G7): Seit dem Umbau vom 20.08.2026
> (`20fe24f`) ist `.controls` eine Karte mit Rahmen; neun Abschnitte benutzen dieselbe Klasse aber
> weiterhin als bloßen Flex-Container, wodurch Karten ineinander verschachtelt werden und Zeilen
> ohne Innenabstand direkt auf dem Rahmen liegen.

### G1 · Phone: Die letzten drei Abschnitte sind nicht erreichbar — die Abschnittsliste scrollt nicht

- **Schwere:** blockierend
- **Schritte:** (1) 390×844 mit `hasTouch`, als `carol@waxwing.test` anmelden.
  (2) „Einstellungen" antippen — die Abschnittsliste ist die ganze Seite. (3) In der Liste nach
  unten scrollen versuchen (Mausrad, Wischen).
- **Erwartet:** Alle vierzehn Abschnitte sind erreichbar; die Liste scrollt, wenn sie länger ist
  als der Schirm.
- **Beobachtet:** Die Liste endet sichtbar bei „Filter", die Gruppenüberschrift „SYSTEM" liegt halb
  hinter der unteren Tab-Leiste, **„Offline & Speicher", „Server" und „Über" sind gar nicht
  erreichbar**. Nichts scrollt — weder die Leiste noch das Dokument:
  `innerHeight 844` · `.rail` y = 77 … 917 (73 px unterhalb des Viewports) ·
  `.rail scrollHeight 840 = clientHeight 840` → scrollbar um 0 px · `.page overflow hidden` ·
  `.page scrollHeight − clientHeight = 146 px` abgeschnitten. Nach `wheel 300/600/1200/3000`:
  `railScrollTop = 0`, `docScrollTop = 0`. `document.elementFromPoint()` liefert in der Mitte der
  drei Zeilen `null` bzw. ein fremdes Element — sie sind nicht antippbar. Auf 414×896 dasselbe in
  kleinerem Umfang („Server" und „Über"); auf Desktop 1280×700 tritt der Effekt **nicht** auf,
  dort ist `.rail` tatsächlich scrollbar.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-liste-phone-abgeschnitten.png`,
  `…/einstellungen-liste-phone-nach-scrollversuch.png` (identisch — vier Scroll-Versuche ohne jede
  Wirkung), `…/einstellungen-rail-phone-390x844.png`, `…/einstellungen-rail-phone-414x896.png`.
- **Ursache:** `apps/web/src/settings/settings.module.css`: `.rail` hat `flex: 0 0 auto` und
  `overflow-y: auto`. Im Phone-Layout wird `.page` auf `flex-direction: column` umgestellt, `.rail`
  behält aber `flex: 0 0 auto` — der Kasten schrumpft nie, sein eigenes `overflow-y` greift nie,
  und `.page { overflow: hidden }` schneidet den Überstand ersatzlos ab.

### G2 · Doppelter Kartenrahmen in zehn von vierzehn Abschnitten

- **Schwere:** störend
- **Schritte:** Einstellungen → „Lesen" (ebenso Benachrichtigungen, Wischgesten, Verfassen,
  Vorlagen, Identitäten, Abwesenheitsnotiz, Filter, Offline & Speicher, Server).
- **Erwartet:** Ein Abschnitt ist **eine** Karte mit **einem** Rahmen.
- **Beobachtet:** Zwei ineinanderliegende Karten mit je eigenem Rahmen und eigener Eckenrundung,
  versetzt um genau 1 px. Gemessen im Abschnitt „Lesen": Karte 1 `x=376 y=100 b=672 h=183`,
  Karte 2 `x=377 y=101 b=670 h=181`, beide `border 1px rgb(210,210,215)`, `radius 16px`. An den
  Ecken sind zwei konzentrische Bögen zu sehen, an den Kanten ein doppelt so dicker Strich.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-doppelter-kartenrahmen-6x.png`
  (Eckausschnitt bei 6-facher Gerätepixeldichte), `…/einstellungen-reading-desktop.png`,
  `…/einstellungen-templates-desktop.png`.
- **Ursache:** `SettingsPage.tsx` Z. 120 rendert `<div className={styles.controls}>` um jeden
  Abschnitt; die Abschnittskomponenten benutzen dieselbe Klasse zusätzlich als eigenen
  Wurzelcontainer: `ComposeSection.tsx:29`, `TemplatesSection.tsx:43`, `ReadingSection.tsx:35`,
  `SwipeSection.tsx:23`, `VacationSection.tsx:186`, `StorageSection.tsx:103`,
  `ServerSection.tsx:85`, `IdentitiesSection.tsx:269`, `NotificationsSection.tsx:205`. Bis
  `20fe24f` war `.controls` nur `display:flex; gap`, seither trägt sie `border`, `border-radius`,
  `background` und `overflow: hidden`. In den Benachrichtigungen gibt es sogar eine **dritte**
  Ebene (`NotificationsSection.tsx:252`, Ruhezeiten). Frei davon sind nur Allgemein, Darstellung,
  Geplant und Über.

### G3 · Zeilen ohne Innenabstand: Text klebt am Kartenrahmen und wird angeschnitten

- **Schwere:** störend
- **Schritte:** Einstellungen → „Offline & Speicher" (ebenso Benachrichtigungen, Vorlagen, Geplant,
  Identitäten, Abwesenheitsnotiz, Filter, Server, Über).
- **Erwartet:** Jede Zeile in der Karte hat denselben Innenabstand wie die Einstellungszeilen
  (12 px / 16 px).
- **Beobachtet:** Alle Zeilen, die kein `.field` sind — Beschreibungstexte, `<dl>`, `<ul>`,
  `<fieldset>` und einzeln stehende Schaltflächen — haben `padding: 0px` und beginnen 1 px hinter
  dem Kartenrahmen. Der erste Buchstabe wird vom Rahmen angeschnitten („**W**axwing behält aktuelle
  E-Mails …", „**0** Ordner werden offline behalten", „**V**ersion 0.14.0"). Die Trennlinien
  zwischen den Karteneinträgen schneiden zusätzlich mitten durch die Textblöcke. Am deutlichsten in
  den Ruhezeiten der Benachrichtigungen: „Von" und „Bis" liegen direkt **auf** dem Rahmen der
  inneren Karte. Der große Abstand rechts (bis 317 px) kommt von `max-inline-size: 22rem` auf
  `.breakdown`/`.fieldset` bzw. `34rem` auf `.identityList` — die Werte-Spalte steht dadurch in der
  Mitte statt am rechten Kartenrand.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-offline-desktop.png`,
  `…/einstellungen-notifications-aktiv-desktop.png` (Ruhezeiten),
  `…/einstellungen-notifications-aktiv-phone.png`, `…/einstellungen-templates-desktop.png`,
  `…/einstellungen-server-desktop.png`, `…/einstellungen-about-desktop.png`,
  `…/einstellungen-scheduled-desktop.png`; Messtabelle je Abschnitt mit `padding 0px` gegen
  `.field` mit `12px 16px`.
- **Ursache:** `settings.module.css`: der Innenabstand wurde in `20fe24f` ausschließlich `.field`
  gegeben (`padding: var(--waxwing-space-3) var(--waxwing-space-4)`), `.controls` selbst hat
  keinen. `.controls > * + *` setzt zusätzlich eine Trennlinie über jedes dieser Elemente.

### G4 · Die Abwesenheitsnotiz meldet ohne Zutun „konnte nicht gespeichert werden"

- **Schwere:** störend (irreführend — die Notiz ist in Wahrheit gespeichert und aktiv)
- **Schritte:** (1) Einstellungen öffnen, einen anderen Abschnitt anwählen (z. B. „Filter").
  (2) „Abwesenheitsnotiz" anwählen. (3) Nichts eingeben, nichts speichern.
- **Erwartet:** Ein frisch geöffneter Abschnitt zeigt keine Fehlermeldung.
- **Beobachtet:** Rot und mit `role="alert"`: **„Die Abwesenheitsnotiz konnte nicht gespeichert
  werden."** — obwohl nichts gespeichert wurde und das Laden erfolgreich war. In 6 von 6
  Durchläufen reproduziert; die Meldung verschwindet erst, wenn der Benutzer irgendein Feld ändert.
  Nach `page.reload()` steht sie wieder da, auch wenn die Notiz kurz zuvor erfolgreich gespeichert
  wurde und der Server sie als aktiv zurückliefert. Im Offline-Zustand ist es dieselbe Meldung, und
  sie ist sachlich falsch: was scheitert, ist das *Laden* — die Nachbarabschnitte sagen korrekt
  „Die Filter konnten nicht **geladen** werden." Weil die Zeichenkette identisch mit der echten
  Speicherfehlermeldung ist, kann ein Benutzer einen echten Speicherfehler nicht von diesem Phantom
  unterscheiden.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-vacation-fehler-ohne-aktion.png`,
  `…/einstellungen-vacation-desktop.png`, `…/einstellungen-vacation-tablet.png`,
  `…/einstellungen-vacation-offline-desktop.png`. Die zugehörige JMAP-Antwort ist einwandfrei:
  `["VacationResponse/get",{…,"list":[{"id":"singleton","isEnabled":false,…}],"notFound":[]},"v0"]`.
- **Ursache:** `apps/web/src/settings/VacationSection.tsx` —
  `void load(controller.signal).catch(() => setError({ key: 'settings.vacation.error.generic' }))`.
  Zwei Dinge in einer Zeile: (1) Ein **Abbruch** (`AbortError` aus dem Cleanup) wird wie ein
  Fehlschlag behandelt; genau diesen Fall behandelt `IdentitiesSection.tsx:184` ausdrücklich
  („An aborted request is not a failure — it is us, tearing the effect down. React StrictMode …").
  (2) Der Schlüssel `settings.vacation.error.generic` lautet „Die Abwesenheitsnotiz konnte nicht
  gespeichert werden."; ein Gegenstück `settings.vacation.error.loadFailed` existiert in
  `apps/web/src/i18n/locales/de/common.json` gar nicht.
- **Vorbehalt (aus dem Quellbericht übernommen):** Punkt 1 wird durch Reacts StrictMode (nur im
  Dev-Server, `apps/web/src/main.tsx:61`) zuverlässig ausgelöst; im Produktionsbuild würde er
  seltener greifen. Punkt 2 — der falsche Meldungstext für einen Ladefehler — ist davon unabhängig
  und trifft jeden Ladefehler, auch offline.

### G5 · Phone: Der Fokus geht beim Abschnittswechsel verloren

- **Schwere:** störend (Barrierefreiheit)
- **Schritte:** Phone 390×844 → Einstellungen → einen Abschnitt anwählen → `document.activeElement`
  prüfen → über „‹ Einstellungen" zurück → erneut prüfen.
- **Erwartet:** Der Fokus landet im geöffneten Abschnitt (die `<section>` trägt `tabIndex={-1}`
  genau dafür) bzw. beim Zurückgehen wieder auf dem verlassenen Listeneintrag.
- **Beobachtet:** Beide Male `activeElement === document.body`. Auf dem Phone wird die Leiste beim
  Öffnen eines Abschnitts aus dem DOM entfernt; das fokussierte `<a>` verschwindet mit ihr, der
  Fokus fällt an den Dokumentanfang zurück. Ein Tastatur- oder Screenreader-Benutzer muss sich nach
  jedem Abschnittswechsel erneut durch Kopfzeile und Hauptnavigation arbeiten. Auf Desktop tritt
  das nicht auf (die Leiste bleibt stehen), aber auch dort bekommt die Sektion keinen Fokus — der
  Kommentar in `SettingsPage.tsx` („`tabIndex={-1}` so a deep link can put focus here, not merely
  scroll") beschreibt ein Verhalten, das es nicht gibt.
- **Beleg:** Skriptausgabe (Phone) `focus after select: BODY|…` / `focus after back: BODY|…`;
  `/tmp/waxwing-walkthrough/shots/einstellungen-filter-phone-detail.png`.

### G6 · Phone: Die Detailseite hat keine Überschrift der Ebene 1

- **Schwere:** störend (Überschriftenhierarchie)
- **Schritte:** Phone 390×844 → beliebigen Abschnitt öffnen → alle `h1…h6` auslesen.
- **Erwartet:** Jede Seite beginnt mit genau einer `<h1>`.
- **Beobachtet:** In allen vierzehn Abschnitten auf dem Phone `["H2:<Abschnittsname>"]` — keine
  `<h1>`. Die einzige `<h1>` der Seite ist „Einstellungen" in der Leiste, und die Leiste wird auf
  dem Phone durch die Detailansicht ersetzt. Auf Desktop und Tablet ist die Reihenfolge korrekt.
  Zusätzlich in allen Viewports: die einzige `<h1>` liegt **innerhalb** von
  `<nav aria-label="Einstellungen">` — die Navigation trägt denselben Namen wie die Überschrift,
  die sie enthält.
- **Beleg:** Skriptausgabe des Phone-Rundlaufs (14× `HEADINGS ["H2:…"]`);
  `/tmp/waxwing-walkthrough/shots/einstellungen-general-phone.png` bis `…-about-phone.png`.

### G7 · Schaltflächen in drei verschiedenen Breiten, zwei verschiedenen Schriftgrößen

- **Schwere:** störend
- **Schritte:** Desktop 1280×900 (Kartenbreite je 672 px), Abschnitte Vorlagen, Filter,
  Identitäten, Abwesenheitsnotiz, Offline & Speicher, Server durchgehen.
- **Erwartet:** Gleichrangige Aktionen sehen gleich aus.
- **Beobachtet:** „Neue Vorlage" und „Regel hinzufügen" **668 px** (volle Kartenbreite),
  „Skript anzeigen" 668 px bei **12 px** Schrift statt 14, „Identität hinzufügen" **148 px**
  (natürliche Breite), „Speichern", „Vorschau anzeigen", „Jetzt Speicher freigeben" und
  „config.json erzeugen" je **352 px** (22 rem). Im Ergebnis ist „Speichern" halb so breit wie die
  Karte mit zentrierter Beschriftung, während „Regel hinzufügen" den Rahmen berührt; „Skript
  anzeigen" steht direkt darunter und ist zwei Punkt kleiner gesetzt. Die Höhe ist überall 34 px —
  unter `pointer: coarse` korrekt 44 px.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-filters-desktop.png`,
  `…/einstellungen-templates-desktop.png`, `…/einstellungen-identities-desktop.png`,
  `…/einstellungen-vacation-desktop.png`.
- **Ursache:** Die 668-px-Varianten sind eine Folge von G3 (die Schaltfläche ist direktes Kind der
  Karte und wird über die ganze Breite gezogen), die 352-px-Varianten stammen aus
  `.field:not(:has(textarea)) > :not(.label):not(.hint) { flex: 0 1 22rem }`.

### G8 · Filter-Regelformular: eine Zeile mit Beschriftung daneben, alle übrigen darunter — und ausgefranste Feldbreiten

- **Schwere:** störend
- **Schritte:** Einstellungen → Filter → „Regel hinzufügen".
- **Erwartet:** Ein Formular mit einer erkennbaren Ausrichtung.
- **Beobachtet:** Im selben 512 px breiten Dialog: „Name" mit Beschriftung links und Feld rechts
  (352 px, Feldbeginn x = 511); „Anwenden, wenn", „Bereich", „Vergleich", „Wert", „Aktion",
  „Markieren als" mit Beschriftung oben und Feld darunter (je x = 417). Feldbreiten der
  Auswahllisten: 320, 224, 208, 252, 256, 192 px — jede so breit wie ihr längster Eintrag, dadurch
  ein ausgefranster rechter Rand über sechs Zeilen. Die Legenden „Bedingungen" und „Aktionen"
  stehen bei x = 402, ihr Inhalt bei x = 417 — eine Einrückung um 15 px ohne erkennbare Regel.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-filters-regelformular-desktop.png`.
- **Ursache:** `.fieldset` hat `max-inline-size: 22rem`; die enthaltenen `.field` bekommen über die
  Medienabfrage `flex: 0 1 22rem` für ihr Steuerelement, was zusammen mit der Beschriftung breiter
  ist als die 22 rem des Fieldsets und deshalb umbricht — sie *sehen* gestapelt aus, sind aber
  Zeilen. „Name" liegt außerhalb des Fieldsets und bleibt daher eine echte Zeile.

### G9 · Beschriftungen schweben mittig neben hohen Blöcken

- **Schwere:** störend
- **Schritte:** Einstellungen → Server; Einstellungen → Identitäten → „… bearbeiten".
- **Erwartet:** Die Beschriftung einer mehrzeiligen Gruppe steht an deren Oberkante.
- **Beobachtet:** `.field` bekommt ab 40 em `align-items: center`. Bei hohen Zeilen steht die
  Beschriftung deshalb in der vertikalen Mitte einer sonst leeren linken Spalte: Server
  „Grenzwerte" (242 px), „Grenzwerte für E-Mail" (213 px), „Optionale Funktionen" (296 px),
  während „Weitere Funktionen, die dieser Server nennt" (200 px) oben steht — vier Zeilen desselben
  Abschnitts mit zwei Ausrichtungen. Identitäten: „Signatur" neben dem 180 px hohen
  Rich-Text-Editor.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-server-vollstaendig-desktop.png`,
  `…/einstellungen-identities-formular-desktop.png`.

### G10 · Abwesenheitsnotiz: Der Text-Editor durchbricht die Karte

- **Schwere:** störend
- **Schritte:** Einstellungen → Abwesenheitsnotiz.
- **Erwartet:** Der Editor sitzt wie jede andere Zeile mit Innenabstand in der Karte.
- **Beobachtet:** Der `RichTextEditor` ist direktes Kind der Karte (`padding: 0`, Höhe 173 px) und
  bringt seinen eigenen Rahmen samt Eckenrundung mit. Werkzeugleiste und Textfeld reichen bis auf
  1 px an den Kartenrahmen heran, die runden Ecken des Editors schneiden sichtbar in die gerade
  Kartenkante. Auf Tablet und Phone derselbe Effekt; auf dem Phone bricht die Werkzeugleiste zudem
  auf zwei Zeilen um.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-vacation-desktop.png`,
  `…/einstellungen-vacation-tablet.png`, `…/einstellungen-vacation-phone.png`.

### G11 · Filter bleiben offline bedienbar, Identitäten sperren korrekt

- **Schwere:** störend
- **Schritte:** Einstellungen öffnen, Netzwerk trennen (`context.setOffline(true)`), nacheinander
  „Filter" und „Identitäten" öffnen.
- **Erwartet:** Gleiches Verhalten in beiden Abschnitten — beide speichern nur online.
- **Beobachtet:** *Identitäten:* „Die Identitäten konnten nicht geladen werden." plus „Sie sind
  offline. Identitäten lassen sich nur mit Verbindung ändern.", „Identität hinzufügen"
  **deaktiviert**. *Filter:* „Die Filter konnten nicht geladen werden.", „Regel hinzufügen" und
  „Skript anzeigen" bleiben **aktiv**. Offline lässt sich also ein vollständiges Filterformular
  ausfüllen; erst beim Speichern erscheint der Fehler. Der Hinweistext
  `settings.filters.error.offline` existiert, wird beim Laden aber nicht verwendet.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-filters-offline-desktop.png`,
  `…/einstellungen-identities-offline-desktop.png`.

### G12 · Abschnittsüberschrift und Gruppenbeschriftung der Leiste sind kaum zu unterscheiden

- **Schwere:** kosmetisch
- **Beobachtet:** Die `<h2>` des geöffneten Abschnitts und die Gruppenbeschriftungen der Leiste
  haben dieselbe Farbe (`rgb(99,99,102)` hell / `rgb(180,180,188)` dunkel), dieselbe
  Großschreibung, dieselbe Laufweite, und unterscheiden sich nur in der Größe (14 px gegen 12 px).
  Im Abschnitt „Allgemein" steht dadurch links „ALLGEMEIN" als Gruppenname und rechts „ALLGEMEIN"
  als Abschnittsüberschrift — zwei optisch gleiche Marken für zwei verschiedene Dinge. Die
  Überschrift wiederholt außerdem den in der Leiste bereits markierten Eintrag.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-general-desktop.png`.

### G13 · Auf breiten Schirmen bleiben rechts 872 px leer

- **Schwere:** kosmetisch
- **Schritte:** 1920×1080, Einstellungen → Darstellung.
- **Beobachtet:** `.detail` hat `max-inline-size: 42rem`; das Panel endet bei x = 1048, die Seite
  bei x = 1920 — **872 px leere Fläche**. Bei 1280 px sind es 233 px. Der Umbau `20fe24f` nennt als
  Anlass ausdrücklich „at 1440px the content ended at x≈735 with ~700px of nothing beside it"; der
  Zustand ist bei ≥ 1440 px unverändert, nur die Karte hat jetzt einen Rahmen. Entspricht **S10**
  aus [`ui-review-2026-08-20.md`](./ui-review-2026-08-20.md), dort als erledigt verzeichnet.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-appearance-1920.png`.

### G14 · Unbekannter Abschnitts-Slug: URL und markierter Eintrag gehen auseinander

- **Schwere:** kosmetisch
- **Schritte:** `http://localhost:5173/settings/gibtsnicht` aufrufen.
- **Erwartet:** Umleitung auf `/settings` oder eine Meldung.
- **Beobachtet:** Die Seite zeigt den ersten Abschnitt („Allgemein") und markiert ihn mit
  `aria-current="page"` — die Adresszeile behält aber `/settings/gibtsnicht`. Ein Lesezeichen auf
  diese Adresse ist damit stumm falsch. Auf dem Phone wird stattdessen die Abschnittsliste gezeigt,
  auch dort bleibt die URL stehen.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-unbekannter-abschnitt-desktop.png`.

### G15 · Identitätsformular: Eingabefelder und Textfeld enden auf verschiedenen Höhen

- **Schwere:** kosmetisch
- **Beobachtet:** „E-Mail-Adresse", „Anzeigename", „Antwort an" und „Automatische Blindkopie" enden
  bei x = 1029 (22-rem-Regel), das Textfeld „Signatur als reiner Text" bei x = 938
  (`.textarea { max-inline-size: 34rem }`), der Rich-Text-Editor wieder bei x = 1029 — drei
  verschiedene rechte Kanten in einem Formular. Die Schaltfläche „Aus der Signatur oben übernehmen"
  beginnt bei x = 408 statt bei x = 396 wie alle Beschriftungen darüber.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/einstellungen-identities-formular-desktop.png`.

---

## M — Mail, App-Hülle, Dateien

### M1 · Der Bereich „Dateien" ist vollständig unbenutzbar

- **Schwere:** blockierend
- **Schritte:** (1) Als `alice@waxwing.test` anmelden. (2) In der Navigationsleiste „Dateien"
  anklicken.
- **Erwartet:** Dateiliste oder ein sauberer leerer Zustand.
- **Beobachtet:** Ganzflächig „Die Dateien konnten nicht geladen werden." mit „Erneut versuchen";
  die Schaltfläche ändert nichts. Der Zustand ist in hell, dunkel, auf Phone, Tablet und Desktop
  identisch und auch über den Deep-Link `/files/<id>` nicht zu umgehen. Ein leerer Zustand ist
  deshalb **nie** erreichbar; Herunterladen, Umbenennen, Löschen und Freigeben sind über die
  Oberfläche gar nicht erst zu erreichen.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-04-nav-Dateien.png`,
  `…/mail-40-dark-files.png`, `…/mail-49-phone-files.png`, `…/mail-41-tablet-files.png`,
  `…/mail-49-phone-files-deeplink.png`. Konsole: `400 (Bad Request)`; JMAP-Antwort
  `{"type":"urn:ietf:params:jmap:error:notRequest","status":400,…}` auf die Anfrage
  `["FileNode/query",{"accountId":"b","filter":{"parentId":null},…}]`.
- **Ursache (Server- und Client-Anteil getrennt, per `curl` isoliert):**
  `FileNode/query {accountId}` ohne Filter → **OK**; `filter:{parentId:"a"}` → **OK**;
  `filter:{parentId:null}` → `invalidArguments: "invalid type: null, expected a borrowed string"`;
  die komplette Anfrage der App → HTTP 400 `notRequest`, die **ganze** Anfrage scheitert. Der
  Client schickt für die Wurzelebene `filter: { parentId: null }`
  (`/home/heiko/repositories/waxwing/apps/web/src/files/files-client.ts`, Zeile 112–118,
  `filter: { parentId }` mit `parentId === null` an der Wurzel). Stalwart akzeptiert `parentId` im
  Filter **nur als String**, obwohl es dasselbe Feld in der Antwort selbst als `null` zurückgibt;
  weil es daraufhin die gesamte Anfrage abweist, fällt auch das nachgelagerte `FileNode/get` weg.
  Siehe [Serverseitig](#serverseitig), Punkt 4.
- **Zusatzbefund (verschärfend):** Hochladen und Ordner-Anlegen erreichen den Server
  **erfolgreich**, sind in der Oberfläche aber unsichtbar und werden nicht rückgemeldet. Nach einem
  Upload zeigt die Oberfläche unverändert die Fehlerseite, auf dem Server liegt die Datei aber:
  `{"id":"b","parentId":null,"nodeType":"file","name":"waxwing-datei.txt","size":47,…}`. Der Nutzer
  lädt Dateien hoch, bekommt keinerlei Bestätigung und sieht sie nie wieder.

### M2 · Die PDF-Anhangvorschau bleibt leer

- **Schwere:** störend
- **Schritte:** Posteingang → „Quarterly report (PDF)" öffnen → unter „Anhänge (1)" auf „Vorschau".
- **Erwartet:** Das PDF wird im Vorschaurahmen angezeigt.
- **Beobachtet:** Der Vorschaubereich klappt auf (`aria-expanded="true"`, „Vorschau ausblenden"),
  bleibt aber leer. Im vollen Chromium erscheint das Symbol für ein nicht darstellbares Dokument.
  Keine Konsolen- oder CSP-Meldung. Das Herunterladen des Anhangs funktioniert.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-12-pdf-preview.png` (headless-shell),
  `…/mail-14-pdf-preview-fullchromium.png`, `…/mail-41-tablet-pdf.png`. Kontrollversuche im
  **selben** Browser: dasselbe PDF im `<iframe>` **ohne** `sandbox` wird einwandfrei gerendert
  (`…/mail-15-pdfcontrol-chromium.png`), in `<iframe sandbox="">` erscheint dasselbe Fehlersymbol
  (`…/mail-16-pdfcontrol-sandboxed.png`), `text/plain` in `<iframe sandbox="">` wird angezeigt
  (`…/mail-54-txt-sandbox-control.png`) — betroffen ist ausschließlich PDF.
- **Ursache:** Die Vorschau nutzt bewusst `<iframe sandbox="">`
  (`apps/web/src/mail/preview-policy.ts`, Zeile 12–14; ebenso
  `apps/web/src/files/FilesPage.tsx:409`). Der eingebaute PDF-Betrachter von Chromium funktioniert
  unter dem maximal restriktiven Sandbox-Wert nicht. Die CSP ist **nicht** die Ursache — sie
  erlaubt `frame-src 'self' blob:`, und der Kontrollversuch ohne Sandbox lief auf derselben Seite
  mit derselben CSP.

### M3 · „Abmelden" wirkt erst nach rund 6 Sekunden — ohne jede Rückmeldung

- **Schwere:** störend
- **Schritte:** (1) Anmelden, Kontomenü öffnen. (2) „Abmelden" anklicken. (3) Sofort beobachten.
- **Erwartet:** Sofortige Rückmeldung, danach die Anmeldemaske.
- **Beobachtet:** Das Menü schließt sich, sonst passiert nichts. Kopfzeile („Angemeldet als
  alice@waxwing.test"), Ordnerbaum und der komplette Posteingang inklusive Betreffzeilen und
  Vorschautexten bleiben unverändert sichtbar. Erst nach im Mittel **6,1 s** (gemessen in einer
  250-ms-Schleife; ein zweiter Lauf lag zwischen 4 s und 8 s) erscheint die Anmeldemaske. In dieser
  Zeit gibt es keinen Ladeindikator, keine deaktivierte Oberfläche und keinen Hinweistext. Auf
  einem gemeinsam genutzten Rechner ist das die riskanteste Stelle: Man klickt „Abmelden" und geht
  weg, während die Mailbox noch sechs Sekunden offen auf dem Bildschirm steht.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-05-after-logout.png` (2,5 s **nach** dem Klick:
  vollständiger Posteingang, Kontoname in der Kopfzeile), `…/mail-07-logout-final.png`; Messung
  `LOGOUT COMPLETED AFTER ms = 6119`.

### M4 · Verfassen-Fenster: Der Texteditor wird auf zwei Zeilen zusammengequetscht

- **Schwere:** störend
- **Schritte** (Desktop 1280×900): (1) „Neue Nachricht" öffnen. (2) Zwei Empfänger in „An",
  „Kopie" aufklappen und einen Empfänger eintragen. (3) Eine Datei anhängen. (4) Acht Zeilen Text
  schreiben.
- **Erwartet:** Der Nachrichtentext bleibt der größte Bereich des Fensters, oder das Fenster wächst.
- **Beobachtet:** Das Fenster bleibt auf 448×512 px fixiert (`top: 388, bottom: 900, vh: 900`).
  Kopfbereich, Empfängerfelder, Betreff und Anhangzeile verbrauchen den Platz; für den Text bleiben
  **62 px sichtbare Höhe bei 171 px Inhalt** (`_editor_ scrollHeight 171 / clientHeight 62`).
  Sichtbar sind nur „Zeile 4", „Zeile 5" und eine halbe „Zeile 6"; die Formatierungsleiste ist aus
  dem sichtbaren Bereich herausgescrollt. Auf dem Phone tritt das nicht auf (dort ist das Fenster
  bildschirmfüllend), auf dem Tablet ist es abgeschwächt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-24-compose-clip.png`,
  `…/mail-23-compose-attachment.png`; Vergleich `…/mail-49-phone-compose-filled.png`,
  `…/mail-41-tablet-compose.png`.

### M5 · Sortieren nach „Betreff" ordnet falsch

- **Schwere:** störend · **Art:** Serverfehler, nicht Oberfläche
- **Schritte:** Posteingang → „Ansichtsoptionen anzeigen" → „Sortieren" auf „Betreff" stellen.
- **Erwartet:** Alphabetische Reihenfolge der Betreffzeilen.
- **Beobachtet:** „Fwd: the original quarterly figures" steht am Ende statt zwischen „Sehr…" und
  „Waxwing…". Sortieren nach Datum, Absender und Größe ist in Ordnung.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-46-sort-Betreff.png`; Vergleich
  `…/mail-46-sort-Absender.png`, `…/mail-46-sort-Groeße.png`.
- **Ursache:** Die App schickt `"sort":[{"property":"subject","isAscending":true}]` — korrekt und
  ohne eigene Kollation. Der Server sortiert nach dem RFC-5256-Basisbetreff (Präfixe `Re:`/`Fwd:`
  entfernt) und vergleicht dabei **case-sensitiv nach ASCII**, sodass das kleingeschriebene „the
  original quarterly figures" hinter allen großgeschriebenen Betreffs landet. Auch mit ausdrücklich
  gesetzter Kollation (`"collation":"i;unicode-casemap"`, per `curl`) ändert sich nichts. Siehe
  [Serverseitig](#serverseitig), Punkt 5.

### M6 · Tablet: Die Nachrichtenliste ist zu schmal, während der Lesebereich leer steht

- **Schwere:** störend
- **Schritte:** Viewport 820×1180 (`isMobile`, `hasTouch`), anmelden, Posteingang ansehen.
- **Erwartet:** Absender und Betreff sind lesbar, solange Platz vorhanden ist.
- **Beobachtet:** Die Liste ist rund 290 px breit, der **leere** Lesebereich daneben rund 450 px.
  Absender und Betreff werden stark gekürzt, obwohl mehr als die Hälfte der Breite ungenutzt
  bleibt: „Dana Langname…", „erin@waxwing.…", „security@bank.t…", „Sehr langer Betreff zum Test
  der …". Kein horizontales Scrollen, keine Überlappungen.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-41-tablet-inbox.png`; Vergleich Desktop 1280
  `…/mail-01-inbox-desktop.png` (Liste dort ~420 px).

### M7 · Tablet: Anhang-Dateiname auf „qu…" gekürzt

- **Schwere:** störend
- **Schritte:** Viewport 820×1180 → „Quarterly report (PDF)" öffnen → „Vorschau".
- **Erwartet:** Der Dateiname ist lesbar.
- **Beobachtet:** Die Anhangzeile zeigt `qu… 548 Byte Vorschau ausblenden ⤓`. Der Dateiname
  `quarterly-report.pdf` schrumpft auf zwei Zeichen, während die Beschriftung „Vorschau ausblenden"
  in voller Länge stehen bleibt. Auf dem Desktop ist der Name vollständig.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-41-tablet-compose.png` (Anhangzeile im
  Hintergrund), `…/mail-41-tablet-pdf.png`; Vergleich `…/mail-12-pdf-preview.png`.

### M8 · Ein Seiten-Reload meldet ab — als Befund zwischen den Berichten umstritten

- **Schwere:** störend (Einordnung strittig, siehe unten)
- **Schritte:** Anmelden, ohne „Öffentlicher oder gemeinsam genutzter Computer" anzuhaken;
  beliebigen Bildschirm öffnen; `page.reload()` bzw. `F5` oder direkte Navigation auf eine
  Deep-Link-URL.
- **Erwartet** (so die Durchläufe Kalender und Kontakte): Die Sitzung bleibt bestehen.
- **Beobachtet:** Nach dem Reload steht wieder die Anmeldemaske („Webmail für localhost:5173 —
  Anmelden"). Die URL bleibt erhalten (`/calendar/2026-09-21`), die Sitzung nicht; nach erneuter
  Anmeldung sind die Daten unversehrt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/kalender-05-nach-reload.png`,
  `…/kalender-80-nach-reload-abgemeldet.png`, `…/kontakte-reload-abmeldung.png`,
  `…/kontakte-reload-nach-anmeldung.png`.
- **Widerspruch zwischen den Berichten:** Kalender (K-16) und Kontakte führen den Vorgang als
  Befund und nennen das nicht angehakte Kästchen „Öffentlicher oder gemeinsam genutzter Computer".
  Der Mail-Durchlauf hält denselben Vorgang ausdrücklich für **beabsichtigt** und nennt ein anderes
  Kästchen: „Angemeldet bleiben" (Vorgabe: aus), Beleg `e2e/tests/helpers.ts:46`; mit gesetzter
  Checkbox überstand die Sitzung dort jeden Reload. Ob beide Kästchen dasselbe steuern, ist hier
  nicht geklärt; der vorige Durchgang hat sie unter **S7**
  ([`ui-review-2026-08-20.md`](./ui-review-2026-08-20.md)) als zwei unabhängige Kontrollkästchen
  mit gegensätzlicher Bedeutung notiert. Belastbar bleibt: Zwei von vier Prüfern hielten das
  Verhalten für einen Fehler — die Beschriftung trägt die Absicht nicht.
- **Folge für diese Prüfung:** Beide Durchläufe konnten ihre Reload-Gegenproben nicht in der
  Oberfläche fahren und haben sie durch erneute Anmeldung plus `curl`-Gegenprobe gegen den Server
  ersetzt.

### M9 · Die Kürzel- und Palettengruppe heißt „Sortieren", enthält aber Archivieren/Löschen/Markieren

- **Schwere:** kosmetisch
- **Schritte:** `?` drücken (Tastaturkürzel-Hilfe) oder Strg+K (Befehlspalette).
- **Erwartet:** Eine Gruppenüberschrift, die zu den Einträgen passt (etwa „Aktionen").
- **Beobachtet:** Die Überschrift lautet **„SORTIEREN"**; darunter stehen „Nachricht aus- oder
  abwählen", „Archivieren", „In den Papierkorb", „Als Spam markieren", „Als ungelesen markieren",
  „Markierung setzen oder entfernen", „Letzte Aktion rückgängig machen", „Labels anwenden", „In
  Ordner verschieben". In derselben Oberfläche heißt „Sortieren" außerdem bereits die
  Sortier-Auswahl in den Ansichtsoptionen — der Begriff ist doppelt belegt.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-04-shortcuts.png`,
  `…/mail-06-palette-button.png`, `…/mail-40-dark-shortcuts.png`.
- **Ursache:** `apps/web/src/i18n/locales/de/common.json`, Zeile 1402:
  `"shortcuts.groups.triage": "Sortieren"`. Im Englischen heißt der Schlüssel „Triage" — die
  deutsche Übersetzung hat die Bedeutung „vorsortieren/abarbeiten" zu „nach etwas sortieren"
  verschoben.

### M10 · Strg+K öffnet die Befehlspalette nicht, wenn der Fokus im Suchfeld steht

- **Schwere:** kosmetisch
- **Schritte:** In das Feld „E-Mails durchsuchen" klicken, Strg+K drücken.
- **Erwartet:** Die Befehlspalette öffnet sich — die Schaltfläche oben trägt die Beschriftung
  „Befehlspalette (Ctrl+K)", und die Kürzelhilfe listet sie ohne Bereichseinschränkung.
- **Beobachtet:** Nichts passiert (`[role="dialog"]`-Anzahl = 0). Außerhalb von Eingabefeldern
  funktioniert Strg+K einwandfrei.
- **Beleg:** Messprotokoll `CTRL-K from search input -> dialogs: 0` gegenüber `CTRL-K dialogs: 1`
  bei Fokus auf dem Seitenkörper; `/tmp/waxwing-walkthrough/shots/mail-06-ctrlk.png`.

### M11 · Phone: Der Kontakt-Avatar im Lesebereich liegt unter 44 px

- **Schwere:** kosmetisch
- **Schritte:** Phone 390×844, Nachricht öffnen.
- **Erwartet:** Mindestens 44×44 px unter `pointer: coarse` — die App löst das sonst überall ein.
- **Beobachtet:** Die Schaltfläche „Kontaktkarte von Bob Baker anzeigen" misst **36×36 px**. Alle
  übrigen geprüften Tippziele erfüllen die Zusage: Kopfzeilen-Schaltflächen 44×44, Ordner-Aktionen
  44×44, „Zurück zu den Nachrichten" 217×44. Die Auswahl-Checkboxen der Nachrichtenzeilen sehen mit
  18×18 px zu klein aus, ihr `<label>` liefert aber die vollen 44×44 px Trefferfläche.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-35-phone-message.png`,
  `…/mail-34-phone-inbox.png`.

### M12 · Phone: Die Wisch-Beschriftung der untersten Zeile liegt unter der Verfassen-Schaltfläche

- **Schwere:** kosmetisch
- **Schritte:** Phone 390×844, die unterste Zeile des Posteingangs nach links wischen.
- **Erwartet:** „Archivieren" vollständig lesbar.
- **Beobachtet:** Der blaue Aktionsstreifen liegt teilweise hinter der runden
  Verfassen-Schaltfläche unten rechts.
- **Beleg:** `/tmp/waxwing-walkthrough/shots/mail-43-swipe-left-open.png`.

---

## U — übergreifend

> Die beiden folgenden Befunde stammen **nicht** aus den vier Bereichsdurchläufen, sondern fielen
> beim Einrichten der Umgebung an. Beide treffen dieselbe Stelle: den Fehlertext „Etwas ist
> schiefgelaufen" beim Anmelden.

### U1 · „Etwas ist schiefgelaufen" verschweigt den einzigen Hinweis, der weiterhilft

- **Schwere:** störend
- **Schritte:** Eine Instanz betreiben, deren Session-Dokument eine `apiUrl` auf einer **anderen
  Herkunft** ausweist als der, auf der die App ausgeliefert wird; die App aufrufen und sich
  anmelden.
- **Erwartet:** Die App verweigert die Anmeldung — richtig — und benennt dabei, was falsch
  konfiguriert ist.
- **Beobachtet:** Die Oberfläche zeigt ausschließlich den generischen Text „Etwas ist
  schiefgelaufen". Der Betreiber erfährt nicht, dass seine Serverkonfiguration die falsche Herkunft
  bewirbt, und hat von der Oberfläche aus keinen Ansatzpunkt.
- **Beleg:** `packages/jmap` wirft in diesem Fall einen `JmapSessionOriginError` mit einer präzisen
  Meldung: „Session field apiUrl points at … which is not on the connected origin … refusing to
  send credentials there". `errToOnboard` in `apps/web/src/app/session/SessionProvider.tsx` bildet
  ihn auf `onboarding.error.generic` ab.
- **Einordnung:** Die Weigerung, Zugangsdaten an eine fremde Herkunft zu schicken, ist richtig und
  soll bleiben. Der Befund ist allein die Meldung: Die einzige Information, die den Fehler behebbar
  macht, liegt im Fehlerobjekt vor und wird verworfen.

### U2 · Veralteter lokaler Zustand endet im selben nichtssagenden Fehler, ohne Ausweg

- **Schwere:** störend
- **Schritte:** Nicht gezielt herstellbar — beobachtet beim Laden der App nach mehreren
  Einrichtungsversuchen.
- **Erwartet:** Entweder lädt die App, oder sie benennt, was sie hindert, und bietet einen Weg
  heraus.
- **Beobachtet:** Derselbe Text „Etwas ist schiefgelaufen", **ohne dass ein Netzwerkaufruf
  fehlschlug**. Nach dem Löschen der IndexedDB-Datenbanken `waxwing-auth` und `waxwing-replica`
  sowie des `localStorage` war der Zustand weg und die App lud normal.
- **Nicht ermittelt:** Welcher Bestandteil des lokalen Zustands genau stört, ist **nicht
  festgestellt**. Es wurde nicht einzeln geprüft, ob `waxwing-auth`, `waxwing-replica` oder der
  `localStorage` allein genügt hätten — hier steht deshalb keine Ursache.
- **Einordnung:** Unabhängig von der Ursache bietet die Oberfläche in dieser Lage keinen Weg an,
  den lokalen Zustand zurückzusetzen. Der einzige bekannte Ausweg führt über die
  Entwicklerwerkzeuge des Browsers — für einen Betreiber machbar, für einen Nutzer nicht.

---

## Geprüft und in Ordnung

Dieser Abschnitt ist kein Beiwerk: Er begrenzt, worüber die Liste oben überhaupt eine Aussage
macht. Was hier steht, wurde durchgespielt und blieb ohne Befund.

**Kalender**
- Anmeldung und Aufruf über die Seitenleiste; der Ladezustand zeigt einen Spinner, während die
  Kopfzeile mit Monat und Bedienelementen bereits steht.
- Ansichtswechsel Monat / Woche / Agenda in beide Richtungen; die aktive Ansicht ist über
  `aria-pressed="true"` und die Hervorhebung erkennbar. Auf dem Phone wandern die Ansichten korrekt
  in ein Menü mit Häkchen an der aktiven Ansicht und „Heute" als erstem Eintrag.
- Monatsnavigation vor/zurück und „Heute" arbeiten korrekt und schreiben den Fokustag in die URL.
- **Termin anlegen** funktioniert vollständig und landet nachweislich auf dem Server; der erzeugte
  JSCalendar-Rumpf ist korrekt (lokale Startzeit ohne Offset, `duration` als ISO-Dauer, `timeZone`
  der Leserzone, `description: null` statt Leerstring).
- Ganztägig-Umschalter tauscht „Beginnt" gegen „Tag" und blendet „Dauer in Minuten" aus; gesendet
  wird `showWithoutTime: true`, `timeZone: null`, `duration: "P1D"`.
- Leerer Titel wird verhindert (auch bei reinen Leerzeichen); Termin ohne Titel wird als
  „(ohne Titel)" dargestellt; ein Termin in der Vergangenheit lässt sich anlegen, und die Agenda
  blendet Vergangenes korrekt aus.
- **Zeitzonenumrechnung:** Ein Termin um 10:00 `Asia/Tokyo` erscheint in der Wochenansicht korrekt
  um 03:00 Ortszeit, und die Agenda weist die abweichende Zone aus.
- **Serientermine sind schreibgeschützt und sagen das auch:** Ein Klick auf ein Vorkommen öffnet
  einen Dialog mit einer verständlichen deutschen Erklärung; die Erkennung über `recurrenceId`
  greift zuverlässig.
- Leerer Zustand („Nichts in Sicht.") und Fehlerzustand (rot, Warndreieck, „Erneut versuchen" lädt
  tatsächlich neu) sind voneinander unterscheidbar. Ein Schreibfehler erzeugt einen gut sichtbaren
  roten Toast **über** dem modalen Dialog, und die Eingaben bleiben im offenen Dialog stehen.
- Die „+"-Schaltfläche ist offline korrekt deaktiviert (`aria-disabled="true"`) und begründet das;
  der Kopf zeigt ein „Offline"-Kennzeichen (Einschränkung: T3).
- Dialog und Agenda passen vollständig in Phone und Tablet; kein waagerechter Bildlauf des
  Dokuments in einem der drei Viewports. Der Monatstitel wird auf dem Phone korrekt abgekürzt.
- Tastatur: `Esc` schließt beide Dialoge, `Tab` erreicht Tageszellen und Chips der Reihe nach,
  `Enter` öffnet den Termin, die Tageszellen tragen ein vollständiges `aria-label`. Dass die
  Pfeiltasten den Fokus nicht im Raster bewegen, ist im Quelltext begründet (kein `role="grid"`,
  weil das Tastaturmuster nicht umgesetzt ist) und wird nicht als Befund gezählt.

**Kontakte**
- Anlegen mit Titel, Vor-, Zweit- und Nachnamen, Namenszusatz, Firma, Position, Geburtstag, Notiz,
  Adresse, zwei Telefonnummern und drei E-Mail-Adressen: alles landet vollständig und korrekt
  getypt auf dem Server (per `curl` gegengelesen).
- **Drei E-Mail-Adressen mit unterschiedlichen Typen** (`work`/`private`/ohne): korrekte
  `contexts`, korrekte Reihenfolge, korrektes Zurücklesen nach erneuter Anmeldung. Mittlere Zeile
  entfernen erzeugt keinen Index-Versatz; leere Zeilen werden beim Speichern verworfen; Typwechsel
  ohne `label` funktioniert.
- Umlaute und Sonderzeichen in Namen, Firma und Notiz (`äöüß & <b>HTML</b>`) korrekt gespeichert
  und angezeigt, kein HTML-Durchschlag. Sehr lange Adresse (261 Zeichen) bricht sauber um.
- Bearbeiten und Löschen: E-Mail-Adresse entfernen wirkt serverseitig; `pref` und `label`
  bestehender E-Mail-/Telefoneinträge überleben eine Bearbeitung; Löschen mit Bestätigungsdialog,
  Karte danach serverseitig zerstört; optimistische Aktualisierung ohne Flackern.
- Liste und Suche: Leerzustand korrekt, Sortierung nach Anzeigename mit korrekt ignorierter
  Groß-/Kleinschreibung, Suche über Name, E-Mail-Domain, Telefonnummer und Firma,
  diakritik-unempfindlich („bjoern" findet „Björn"), Kein-Treffer-Zustand korrekt. Auswahl per Maus
  und Tastatur funktioniert **innerhalb eines Adressbuchs** einwandfrei (Ausnahme: N1).
- Adressbücher und Gruppen: Rail mit „Alle Kontakte" und Standard-Badge; Gruppe anlegen
  (`kind: "group"`), Mitglieder hinzufügen, `members` wird korrekt als UID-Map geschrieben; Klick
  auf ein Mitglied öffnet dessen Karte.
- Import/Export: vCard 4.0 und JSContact erzeugen korrekte Dateien mit korrekter
  `TYPE=work`/`TYPE=home`-Abbildung, korrekter Zeilenfaltung und intakten Umlauten (Ausnahmen: N5,
  N6); Einzelexport eines Kontakts vorhanden.
- Kein horizontales Überlaufen in Liste, Detailansicht oder Formular bei 390, 820 und 1280 px.
  Keine JavaScript-Konsolenfehler in Liste, Detail, Formular, Suche, Gruppen oder Import — der
  einzige Laufzeitfehler des ganzen Durchlaufs ist der Export-Absturz aus N5.

**Einstellungen** (jeweils: Wert ändern → speichern → `page.reload()` → Wert steht noch da)
- Sprache, Farbschema, Akzentfarbe, Listendichte, Lesebereich, Wischgesten links/rechts, „Externe
  Bilder automatisch laden", „Als gelesen markieren", „Senden rückgängig machen" (30 s) und
  Signaturposition: alle nach Neuladen unverändert.
- Vorlagen anlegen, speichern, neu laden, löschen — vollständig funktionsfähig.
- Identitäten bearbeiten und speichern; die Validierung greift: eine ungültige Antwortadresse
  deaktiviert „Identität speichern" und zeigt „Eine Antwortadresse ist ungültig." als `role="alert"`
  in Danger-Farbe.
- Abwesenheitsnotiz einschalten, Betreff und Text setzen, speichern → „Abwesenheitsnotiz
  gespeichert", Status wechselt korrekt; nach Neuladen sind Schalter, Betreff und HTML-Text
  unverändert; Vorschau öffnet und rendert; Zurücksetzen funktioniert (Ausnahme: G4).
- Filter: Regel anlegen, speichern, neu laden, „Skript anzeigen" zeigt das erzeugte Sieve samt
  `# @waxwing:rules:v1`-Marke, Löschen entfernt sie wieder.
- Offline & Speicher zeigt Belegung, Aufschlüsselung und Kontingent; „Server → config.json
  erzeugen" liefert eine plausible Konfiguration mit den beiden richtigen Hinweisen; „Über" zeigt
  „Version 0.14.0" (dass keine Impressums-/Datenschutz-Links erscheinen, ist korrekt, weil
  `branding.links.*` in dieser Fixture unkonfiguriert ist).
- Navigation: Jeder Klick setzt die URL auf `/settings/<slug>` und `aria-current="page"` genau auf
  den gewählten Eintrag; Tab-Reihenfolge und Enter arbeiten korrekt, der Fokusring ist auf dem
  Desktop sichtbar; Browser-Zurück führt zuverlässig zurück. Auf dem Phone hat die Liste
  Trennlinien und Chevrons, der Zurückweg ist 112 × 44 px groß.
- **Kein horizontales Scrollen** in keinem Abschnitt und keinem Viewport
  (`documentElement.scrollWidth === window.innerWidth` in allen 14 × 4 Messungen); kein Element
  läuft aus dem Viewport.
- **Tippziele unter `pointer: coarse`:** `--waxwing-control-min` wird korrekt auf 2,75 rem
  umgestellt; kein Tippziel unter 44 px.
- **Kontraste** (hell / dunkel): markierter Leisteneintrag 4,68 / 5,13 · Hinweistext auf der Karte
  5,99 / 6,77 · Abschnittsüberschrift und Gruppenbeschriftung je 5,50 / 8,26 — alle über 4,5:1.
  Kein unsichtbarer Text, keine verschwindenden Ränder in einem der beiden Designs.
- Tablet 820×1180 ohne Überlappungen und ohne abgeschnittene Beschriftungen; Leerzustände korrekt
  formuliert; **die Abschnitte „Allgemein" und „Darstellung" blieben ohne jeden Befund** — sie sind
  die einzigen, die ausschließlich `.field`-Zeilen enthalten.

**Mail, App-Hülle, Dateien**
- Navigationsleiste: alle fünf Ziele erreichbar, aktiver Zustand korrekt über `aria-current="page"`;
  Kontomenü vollständig; erneute Anmeldung nach dem Abmelden funktioniert.
- Tastaturkürzel-Hilfe (`?`) und Befehlspalette öffnen, filtern und schließen korrekt und
  funktionieren auch außerhalb des Mail-Bereichs; `C` und Strg+N öffnen das Verfassen-Fenster
  ebenfalls bereichsübergreifend; `/` setzt den Fokus in das Suchfeld.
- Suche: Volltext, Filterausdruck `is:unread`, Umschalter „Dieser Ordner"/„Alle Ordner", sauberer
  Leerzustand mit hilfreichem Text und Löschen-Kreuz.
- Nachrichtenliste: Reihenfolge nach Datum korrekt, Konversationen werden zusammengefasst
  (8 Nachrichten → 6 Zeilen), Ansichtsumschalter und „Ungelesene zuerst" ordnen korrekt um;
  Mehrfachauswahl mit Kopfzeile „2 ausgewählt" und allen Sammelaktionen.
- Lesen: Konversationsansicht mit einzeln aufklappbaren älteren Beiträgen; Anhänge werden
  aufgelistet, `message/rfc822` wird eingebettet korrekt angezeigt; **externe Inhalte** werden
  geblockt, „Bilder laden" lädt einmalig, „immer erlauben" überdauert den Reload; HTML- und
  Nur-Text-Nachrichten sauber gerendert; 300-Zeichen-Betreff in der Liste gekürzt und im Lesebereich
  umgebrochen; „(Kein Betreff)" korrekt.
- **Sicherheit:** Die Phishing-Erkennung zeigt unter „Details" die **oberste**, vertrauenswürdige
  `Authentication-Results`-Zeile statt der vom Absender gefälschten. Die Link-Warnung nennt beide
  Hosts und löst beim harmlosen Link im selben Text **keine** falsch-positive Warnung aus.
- Aktionen jeweils mit `page.reload()`-Gegenprobe dauerhaft gespeichert: (un)gelesen, markieren,
  Label anwenden, archivieren, Papierkorb, verschieben (der Quellordner wird im Dialog korrekt
  ausgelassen), Rückgängig per Toast und per `Z` (der Toast sitzt in einem `aria-live="polite"`-
  Bereich), Ordner anlegen/umbenennen/löschen samt Rückfrage.
- Wischgesten auf dem Phone (echte Touch-Ereignisse über CDP): beide Richtungen führen die Aktion
  aus, die Beschriftung wird fortschreitend freigelegt, die Zuordnung entspricht der Einstellung.
- Schreiben: Neue Nachricht, Antworten, Allen antworten und Weiterleiten funktionieren; Antworten
  zitiert korrekt, Weiterleiten übernimmt Anhang **und** Weiterleitungskopf; An/Kopie/Blindkopie
  mit Empfänger-Chips und Autovervollständigung aus den Kontakten; Anhang hinzufügen und entfernen;
  Entwurf wird automatisch gespeichert und lässt sich mit allen Feldern wiederöffnen; „Entwurf
  verwerfen" mit Rückfrage; „Senden rückgängig" mit Minimierung und Versand nach rund 15 s;
  Zustellung im Zielkonto per `Email/query` bestätigt; Minimieren/Vollbild/Schließen funktionieren.
- Darstellung: hell und dunkel für Posteingang, Lesebereich, HTML-Nachricht, Phishing-Details,
  Verfassen-Fenster, Kürzelhilfe und Dateien-Fehlerseite durchgesehen — keine Kontrast- oder
  Farbfehler. Phone-Layout mit eigener Kopfzeile, Ordner-Schublade, Registerleiste und klarem
  Rückweg, ohne Überlappungen. Kein horizontales Scrollen in einem geprüften Viewport.

---

## Nicht reproduzierbar

Was ein Quellbericht ausdrücklich so gekennzeichnet hat — hier unverändert übernommen.

- **Gesendeter Entwurf bleibt gelegentlich im Ordner „Entwürfe" liegen** (Mail). Beobachtet in
  **2 von 9 Sendevorgängen**: Nach dem Senden lag die Kopie erwartungsgemäß in „Gesendet", der
  Entwurf war aber zusätzlich noch vorhanden — auch nach Neuladen und auch serverseitig, also keine
  Anzeigeverzögerung. Gezielte Wiederholungsversuche mit den vermuteten Auslösern blieben allesamt
  erfolglos (Senden direkt aus dem neuen Fenster 2×, wiedergeöffneter Entwurf 1×, nach Umschalten
  auf „Vollbild" und zurück 4×, Bearbeiten unmittelbar vor dem Senden 2×); in allen zehn
  Kontrollläufen wurde der Entwurf korrekt entfernt. Der Verdacht geht in Richtung eines Wettlaufs
  zwischen automatischem Zwischenspeichern und `onSuccessDestroyEmail`, ist aber **nicht belegt**.
  Beleg: `/tmp/waxwing-walkthrough/shots/mail-27-sent-folder.png`, `…/mail-30-drafts-after.png`.
- **Offline im Abschnitt Abwesenheitsnotiz: unbehandelter Fehler und verschwindender Editor**
  (Einstellungen). Mit getrennter Verbindung erscheint zweimal
  `PAGE-ERROR: TypeError: Failed to fetch dynamically imported module: …/src/compose/squire-adapter.ts`,
  und das Eingabefeld für den Antworttext fehlt danach ersatzlos. Ob das ein echter Befund ist,
  ließ sich **nicht entscheiden**: Der Vite-Dev-Server liefert die Chunks einzeln und ohne
  Service-Worker aus, im Produktionsbuild wären sie vorab im Cache; ein Produktionsbuild wurde
  nicht geprüft. (Dieselbe Mechanik wie bei T3.)
- **Anteil von React StrictMode an G4** (Einstellungen). Der Abbruch-Zweig lässt sich im Dev-Server
  zuverlässig auslösen; ohne Produktionsbuild lässt sich nicht belegen, wie oft er dort greift. Der
  zweite Teil des Befunds — der falsche Meldungstext für einen Ladefehler — ist davon unabhängig.
- **Ob T3 (weißer Bildschirm offline) im Produktions-Build ebenfalls auftritt** (Kalender): nicht
  geprüft, siehe Vorbehalt bei T3.
- **Sprache der Browser-Validierungsblase** (Kontakte, Kalender). Die Blase erschien englisch. Ob
  das mit deutschsprachigem Browser auch so ist, ließ sich nicht klären, weil Chromium diese Texte
  aus seiner UI-Sprache zieht und nicht aus dem Seiten-Locale. **Nicht als i18n-Befund gewertet**
  (siehe N9, T14).
- **Zustand „fremdes Sieve-Skript"** (Einstellungen): nicht herbeiführbar, ohne serverseitig ein
  Skript ohne Waxwing-Marke anzulegen — das hätte die gemeinsame Fixture verändert.
- **`persist()`-Erteilung in Offline & Speicher** (Einstellungen): Headless-Chromium verweigert
  `navigator.storage.persist()`; der erteilte Zustand konnte nicht geprüft werden. Die Oberfläche
  meldet den nicht erteilten Zustand korrekt.
- **Serientermin bearbeiten oder löschen** (Kalender): nicht prüfbar, weil die Oberfläche das
  bewusst verweigert — erwünschtes Verhalten, kein Befund. **Wiederholung anlegen**: nicht prüfbar,
  das Feld existiert nicht (T11). **Zweiter Kalender / Kalenderauswahl**: nur ein Kalender in der
  Fixture. **Konflikt- und Mehrbenutzerfälle**: nicht geprüft, um die parallel arbeitenden
  Durchläufe nicht zu stören.
- **Sortierung der Kontaktliste** (Kontakte): sortiert wird nach Anzeigename aufsteigend. Ob nach
  Nachname sortiert werden soll, ist eine Produktentscheidung; kein Fehler festgestellt.
  **Reihenfolge mehrerer E-Mail-Adressen ohne `pref`**: hängt an der Einfügereihenfolge der
  JSContact-Map; die Fixture erhält sie zuverlässig, ob ein anderer Server das ebenfalls tut, wurde
  nicht geprüft. **Foto-Upload**: nur bis zum Dateiauswahl-Dialog geprüft.

---

## Bewusst herbeigeführte Fehlerzustände

Damit die Liste nicht mehr behauptet, als beobachtet wurde: Die folgenden Zustände wurden per
`page.route` bzw. `addInitScript` **absichtlich erzeugt** und sind keine Serverfehler.

- Kalender: HTTP 500 auf alle `CalendarEvent/*`-Aufrufe (T5 und der Fehlerzustand unter „Geprüft
  und in Ordnung"), ein gefälschtes `notCreated: overQuota` für den Schreibfehler-Toast, eine
  gefälschte leere Ergebnisliste für die Gegenprobe zu T2, eine künstliche Verzögerung von 4 s für
  den Ladezustand.
- Einstellungen: HTTP 500 mit `urn:ietf:params:jmap:error:serverFail` auf `VacationResponse/set`,
  `SieveScript/set` und `Identity/set` — alle drei Meldungen erschienen korrekt. Zusätzlich wurde
  `window.Notification` auf `granted` gesetzt, weil headless-Chromium die Notification-API hart
  verweigert; die dort gefundenen Darstellungsprobleme (G3) sind reine CSS-Effekte und von dem
  Kunstgriff unabhängig.
- Kalender, Einstellungen: Offline-Zustände über `context.setOffline(true)`.

---

## Serverseitig

Fälle, in denen die Stalwart-Fixture Verursacher oder Mitverursacher ist — getrennt von den
Oberflächenfehlern, damit nicht das Falsche repariert wird. Die Einstufung „umgehbar" bezieht sich
ausschließlich auf das, was die Quellberichte belegen.

1. **Schreibzugriffe auf synthetische Ids werden abgewiesen** (T1). `CalendarEvent/set` antwortet
   mit `invalidProperties` und „Updating/Deleting synthetic ids is not yet supported." — die
   Funktion fehlt im Server erklärtermaßen noch.
   **Von Waxwing umgehbar: ja.** Dieselbe Abfrage ohne `expandRecurrences` liefert die echte Id,
   und damit gelingen Ändern und Löschen sofort (per `curl` nachgewiesen). Für einen Einzeltermin
   ohne Wiederholung braucht die Oberfläche die Expansion nicht.
2. **Expandierte Abfragen liefern `timeZone: "Etc/UTC"` für ganztägige Termine** (T12), während
   dasselbe Objekt per direktem `CalendarEvent/get` korrekt `timeZone: null` hat.
   **Von Waxwing umgehbar: ja.** Für ganztägige Termine (`showWithoutTime`) darf gar keine Zone
   angezeigt werden — die Prüfung in `CalendarPage.tsx` Zeile 489 klammert `placed.allDay` nur
   nicht aus.
3. **Stalwart nimmt über JMAP keine `recurrenceRules` an** — `CalendarEvent/set` antwortet in drei
   geprüften Schreibweisen mit `invalidProperties`; Serientermine mussten für den Test über CalDAV
   (`PUT` einer `.ics`) eingespielt werden.
   **Von Waxwing umgehbar: nein** — das ist eine fehlende Serverfunktion. Waxwing ist davon derzeit
   nicht betroffen, weil es ohnehin keine Wiederholungen schreibt (T11); der Punkt wird erst
   relevant, wenn T11 angegangen wird.
4. **`FileNode/query` mit `filter: { parentId: null }` wird abgewiesen** (M1):
   `invalidArguments: "invalid type: null, expected a borrowed string"` — und weil der Server
   daraufhin die **gesamte** Anfrage mit `notRequest` beantwortet, fällt auch das nachgelagerte
   `FileNode/get` weg. Stalwart akzeptiert `parentId` im Filter nur als String, gibt dasselbe Feld
   in der Antwort aber als `null` zurück.
   **Von Waxwing umgehbar: teilweise.** Die Wurzelabfrage gelingt per `curl` ohne Filter, ebenso
   mit `parentId: "a"` — die Oberfläche kann den `null`-Filter also vermeiden. Dass eine einzelne
   ungültige Methode die ganze Anfrage abräumt, kann Waxwing nicht ändern; es kann nur aufhören,
   sie auszulösen. Der **Zusatzbefund** — erfolgreiche Uploads bleiben unsichtbar und unquittiert —
   ist unabhängig davon rein clientseitig.
5. **Sortieren nach Betreff** (M5). Der Server sortiert nach dem RFC-5256-Basisbetreff und
   vergleicht case-sensitiv nach ASCII. Die App schickt eine korrekte Sortieranweisung ohne eigene
   Kollation.
   **Von Waxwing umgehbar: nach Belegen nein.** Auch eine ausdrücklich gesetzte Kollation
   (`i;unicode-casemap`, per `curl`) ändert am Ergebnis nichts; eine clientseitige Umsortierung
   wurde nicht geprüft und wird hier deshalb nicht behauptet.
6. **Kontakte, Nebenrollen der Fixture.** (a) Der Fixture vergibt **keine `uid`**, wenn der Client
   keine mitschickt — das ist die auslösende Bedingung für N5, **Absturz und stummes Scheitern des
   Exports sind aber App-seitig**. (b) Der Fixture **verwirft** das leere `Address`-Objekt aus N12,
   weshalb der Fehler hier folgenlos bleibt; auf einem Server, der es behält, entstünde eine leere
   Adresszeile. In beiden Fällen ist der Server nicht der Verursacher, sondern nur die Bedingung,
   unter der der Clientfehler sichtbar bzw. unsichtbar wird.
7. **Einstellungen: keine Serverbeteiligung.** Sämtliche JMAP-Aufrufe der Einstellungen
   (`VacationResponse/get|set`, `Identity/get|set`, `SieveScript/get|set`, `Quota/get`,
   `EmailSubmission/query`) antworteten im gesamten Durchlauf mit HTTP 200 und ohne
   `notCreated`/`notUpdated`/`notDestroyed`/`error`. Alle fünfzehn G-Befunde sind clientseitig.
8. **Kontakte: keine Serverbeteiligung bei den Schreibpfaden.** Der Fixture hat in keinem Testfall
   ein `notCreated`/`notUpdated`/`notDestroyed` oder einen Fehlertyp zurückgegeben; eine per `curl`
   angelegte Karte mit drei E-Mail-Adressen inklusive `contexts` und `pref` wird korrekt angelegt
   und unverändert zurückgeliefert.

**Vorbehalt für diesen ganzen Abschnitt:** Alle Serverantworten oben stammen aus der lokalen
Fixture (Stalwart v0.16 in Docker). Die Produktivinstanz läuft in derselben Hauptversion, ist aber
nicht dieselbe Installation — die Antworten sind übertragbar, nicht bewiesenermaßen identisch.
