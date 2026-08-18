# UI-Audit Waxwing — August 2026

> Vier unabhängige Begutachtungen der laufenden Anwendung, gegen das seedende Stalwart-Fixture,
> in drei Viewport-Stufen. Anlass war die Rückmeldung des Projektinhabers, die Oberfläche wirke
> „unaufgeräumt und teilweise überladen" im Vergleich zu [Bulwark](https://bulwarkmail.org/), und
> das Waxwing-Logo verbrauche auf dem Smartphone Platz, den es nicht verdient.
>
> **Dieses Dokument ändert nichts.** Es ist eine Arbeitsliste. Jeder Befund trägt einen Beleg —
> einen Messwert, eine Quellcodezeile oder einen Screenshot — damit er nachprüfbar ist, statt
> geglaubt werden zu müssen.

## Wie geprüft wurde

| | |
|---|---|
| Aufnahme | `e2e/playwright.audit.config.ts` + `e2e/audit/capture.spec.ts` (nicht committet) |
| Viewports | Telefon 390×844, Tablet 834×1112 (beide `isMobile` + `hasTouch`), Desktop 1440×900 |
| Sprache | Deutsch — die längeren Strings, unter denen Layouts brechen |
| Belege | 53 Screenshots und `messungen-{phone,tablet,desktop}.json` unter `e2e/audit/out/` |
| Gegenprobe | `docs/design-system.md` §1–§2, `docs/functional-specification.md` §7 |

Der Touch-Kontext ist nicht Kosmetik: ohne `hasTouch` meldet der Browser `pointer: fine`,
`tokens.css` lässt `--waxwing-control-min` bei 34 px stehen, und jede Messung fällt zu günstig
aus. Alle Zahlen hier sind mit `pointer: coarse` und 44-px-Bedienelementen erhoben.

## Überblick

**52 Befunde** — 22 hoch, 25 mittel, 5 niedrig.

| Gruppe | Thema | hoch | mittel | niedrig |
|---|---|---|---|---|
| **A** | Informationsdichte und Chrome | 5 | 4 | — |
| **B** | Navigation und Nutzerführung | 5 | 4 | 1 |
| **C** | Visuelle Gestaltung und Konsistenz | 5 | 9 | 3 |
| **D** | Texte, Zustände und Formulare | 6 | 7 | 1 |
| **E** | Testabdeckung | 1 | 1 | — |

Wenn nur fünf Dinge angefasst werden: **A1** (Ansichts-Leiste ins Menü) und **A2** (Ordner-Knopf in die
Kopfzeile) geben zusammen 226 px auf dem Telefon zurück, **B1** (Posteingang vorauswählen) macht den
ersten Bildschirm überhaupt erst nützlich, **D1** (falsche deutsche Datenschutzaussage) und **D2**
(Verweis auf ein nicht existierendes Bedienelement) sind Sachfehler, keine Geschmacksfragen.

## Die Kernzahl

Wie viel Bildschirm verbraucht die Anwendung, bevor die erste E-Mail erscheint:

| Zustand | Viewport | Chrome über der Liste | Anteil am Viewport |
|---|---|---|---|
| Posteingang | Telefon 390×844 | 390 px | **53 %** (mit Fußleiste) |
| Posteingang | Tablet 834×1112 | 442 px | 40 % |
| Posteingang | Desktop 1440×900 | 341 px | 38 % |
| **Suche aktiv** | **Telefon** | **492 px** | **65 %** |

Auf dem Telefon bleiben der Liste 395 px — rund fünf Zeilen. Im Suchzustand 293 px.

Die Bänder auf dem Telefon: Kopfzeile 61 px · eine ganze Zeile für **einen** Ordner-Knopf 61 px ·
Suche 103 px · vier Auswahlfelder à 44 px. Auf einem echten Gerät kommt die Browserleiste hinzu,
`100dvh` fällt also noch kleiner aus als die hier gemessenen 844 px.

## Was Bulwark anders macht

Der Vergleich des Projektinhabers ist belegt — hier die nachgeprüfte Fassung
(Quelle: `https://bulwarkmail.org/screenshots/light-viewer.png` und `light-composer.png`):

| | Bulwark | Waxwing |
|---|---|---|
| Globale Kopfzeile | **existiert nicht** — 0 px | 61 px (Telefon) / 68 px (Desktop) |
| Logo / Wortmarke | nirgends in der Anwendung | dauerhaft oben links |
| Kontoidentität | oben in der Ordnerspalte, zugleich Kontowechsler | eigener Satz in der Kopfzeile + Knopf |
| Über der Liste | Suchfeld + ein Filter-Trichter | Suchfeld + Bereichswahl + 3 Auswahlfelder + Kontrollkästchen |
| Lese-Werkzeuge | **eine** Zeile mit beschrifteten Knöpfen (Reply, Reply All, Forward \| Archive, Delete, Move \| Tag, ⋮) | 10 unbeschriftete Icons in zwei Gruppen, auf dem Telefon zweizeilig umbrechend |
| Antworten | Schnellantwort-Feld direkt unter der Nachricht | eigenes Fenster |
| Senden | großer Primärknopf „Send" unten rechts | unbeschriftetes Icon oben, direkt neben dem Papierkorb |

**Ihre Logo-Beobachtung ist richtig, aber die Begründung trägt weiter als gedacht.** Vertikal
kostet das Logo **0 px** — die Kopfzeilenhöhe wird von den 44-px-Bedienelementen bestimmt, nicht
vom 27 px hohen Logo. Der eigentliche Einwand steht im eigenen Design-System (§1, Prinzip 1):
*„no gradients-as-decoration, no more than one saturated color on screen at rest."* Das Logo ist
eine gesättigte Orange-Verlaufsfläche (`logo-icon.svg`: `#F5911E` → `#D96A0A`), während der
Akzent der Anwendung Blau ist (`tokens.css`). Im dunklen Theme ist es das farbstärkste Objekt
auf dem Bildschirm.

**FR-THEME-02 steht einer Entfernung nicht entgegen.** Die Vorgabe verlangt Konfigurierbarkeit
(„must not hardcode the name … anywhere user-visible"), keine Dauerpräsenz. Der Produktname
erscheint zusätzlich in `theme.ts:20` (Tab-Titel), auf dem Anmeldeschirm, im Kontomenü, in
Benachrichtigungen und in fünf weiteren Dialogen.

---

## A — Informationsdichte und Chrome

### A1 · Die Ansichts-Leiste belegt dauerhaft das wertvollste Band
- **Schwere:** hoch · **Wo:** Posteingang, alle Viewports · `MessageList.tsx:837–914`
- **Beleg:** Telefon 165 px, Desktop 192 px für Sortieren / Konversationen / Dichte / Ungelesene zuerst.
- **Warum:** Bei 76 px Zeilenhöhe sind das 2,2 von 5,2 sichtbaren Nachrichten — für vier Einstellungen, die man selten anfasst. „Dichte" steht zusätzlich in den Einstellungen (`SettingsPage.tsx:89–99`), beide schreiben denselben Schlüssel `list.density`.
- **Vorschlag:** In ein „Ansicht"-Menü zusammenfassen; „Dichte" ersatzlos streichen. Gewinn: 165 px Telefon, 192 px Desktop.

### A2 · Eine ganze Zeile für einen einzigen Ordner-Knopf
- **Schwere:** hoch · **Wo:** Telefon + Tablet · `MailScreen.tsx:148–158`, `shell.module.css:271–277`
- **Beleg:** 61 px hoch, ein 44-px-Knopf links, 320 px daneben leer. Gleichzeitig hat die Kopfzeile darüber ~89 px frei.
- **Vorschlag:** Ordner-Knopf in die Kopfzeile. Gewinn: 61 px ohne Funktionsverlust. Zusammen mit B4 wird daraus die Zeile, die den Ordnernamen trägt.

### A3 · Der Suchzustand ist der Tiefpunkt: 65 % Chrome für ein Ergebnis
- **Schwere:** hoch · **Wo:** Telefon, Suche aktiv · Screenshot `phone/11-suche.png`
- **Beleg:** 492 px gemessen. Darin: eine volle Zeile für einen einzelnen ✕-Knopf, zwei **ausgegraute** Auswahlfelder, die während einer Suche nichts tun, und ein Satz, der erklärt, dass sie nichts tun.
- **Vorschlag:** Während einer Suche die Ordner-Optionen ausblenden statt deaktivieren; ✕ in das Feld setzen.

### A4 · Primäraktion „Neue Nachricht" oben rechts — die Spec verlangt unten erreichbar
- **Schwere:** hoch · **Wo:** Telefon · `Header.tsx:59`
- **Beleg:** FR-UI-03 wörtlich: *„single-pane phone with native-feeling navigation (back gestures, **bottom-reachable actions**)"*. Die Fußleiste trägt nur Navigation.
- **Vorschlag:** Auf dem Telefon als vierten Slot oder FAB unten rechts.

### A5 · Desktop: 933 px leere Kopfzeile, während die Suche in die schmalste Spalte gequetscht wird
- **Schwere:** hoch · **Wo:** Desktop · `Header.tsx:39–64`, `MailScreen.tsx:190`
- **Beleg (gemessen):** Wortmarke endet bei x=125, erstes Bedienelement beginnt bei x=1058 — dazwischen 933 px ungenutzt. Das Suchfeld misst 312 px (x=364…676) in einer 360-px-Spalte und bricht dort in vier Zeilen um.
- **Vorschlag:** Suchfeld in die Kopfzeile — das ist zugleich das Bulwark-Muster. Gewinn: 98 px vertikal in der Listenspalte, ein 60 % breiteres Suchfeld, keine zusätzliche Kopfzeilenhöhe.

### A6 · Suchbereichs-Auswahl ist dauerhaft sichtbar, wirkt aber nur während einer Suche
- **Schwere:** mittel · **Wo:** alle Viewports · `SearchBox.tsx:86–94`
- **Beleg:** Bedingungslos gerendert; nur der Löschknopf ist mit `search.active` gekoppelt. 52 px Telefon.
- **Vorschlag:** Erst bei Fokus oder aktiver Suche einblenden — analog zum Löschknopf.

### A7 · Das Suchfeld ist auf Touch nur 34 px hoch
- **Schwere:** mittel · **Wo:** Telefon · `search/search.module.css` `.input`
- **Beleg:** Kein `min-block-size`, im Gegensatz zur hauseigenen `ui/TextInput.module.css`, die `var(--waxwing-control-min)` setzt. Gemessen 342×34 bei `pointerCoarse: true`.
- **Warum:** Design-System §1 Prinzip 4 sagt 44 px auf Touch zu. WCAG AA (24 px) ist erfüllt, das eigene Versprechen nicht. Ursache: SearchBox stylt das Feld selbst, statt `TextInput` zu verwenden.
- **Vorschlag:** `TextInput` verwenden.

### A8 · Lesebereich Telefon: die Mail beginnt bei ~48 % der Höhe
- **Schwere:** mittel · **Wo:** Telefon · `MailScreen.tsx:169–178`
- **Beleg:** Kopfzeile 61 + Zurück-Band 61 + Titel ~90 + Absenderkarte ~110 + zehn Aktionen in zwei Reihen ~105 → erste Textzeile bei y≈460. Mit Phishing-Warnung bei y≈550 (65 %).
- **Vorschlag:** Zurück-Knopf in die Kopfzeile; auf dem Telefon vier Primäraktionen zeigen, Rest ins Überlaufmenü.

### A9 · Ordner-Drawer: sechs gerahmte „…"-Knöpfe dominieren die Ordnernamen
- **Schwere:** mittel · **Wo:** Telefon · `folder-tree.module.css:119–141`, `ui/Menu.module.css`
- **Beleg:** Auf Touch werden die Zeilenmenüs dauerhaft eingeblendet (`pointer: coarse`-Regel), und `Menu` hat keine Ghost-Variante — jeder trägt Rahmen und Flächenfarbe.
- **Vorschlag:** Ghost-Variante für `Menu`, oder auf Touch Long-Press statt Dauerknopf.

---

## B — Navigation und Nutzerführung

### B1 · Der erste Bildschirm nach dem Login enthält keine einzige E-Mail
- **Schwere:** hoch · **Wo:** alle Viewports · `route.ts:33`, `MessageList.tsx:474`
- **Beleg:** `HOME_PATH = '/mail'` löst keinen Standardordner auf; gezeigt wird „Wählen Sie einen Ordner". Kein `lastMailbox`/`defaultMailbox` im Quellbaum.
- **Warum:** Das ist nicht nur der Start, sondern der **Zielpunkt jeder Rückkehr** — Logo, Fußleiste und Benachrichtigungs-Fallback führen alle dorthin. Der eigene Kontakte-Bereich macht es richtig und belegt „Alle Kontakte" vor.
- **Vorschlag:** Bei fehlender `mailboxId` auf den zuletzt benutzten Ordner bzw. den Posteingang umleiten, mit `replace`.

### B2 · Der Zurück-Knopf verwirft die Suche — die Tastaturvariante bewahrt sie
- **Schwere:** hoch · **Wo:** Lesen aus einem Suchergebnis · `MailScreen.tsx:171` gegen `shortcuts/registry.ts:64–68`
- **Beleg:** Der Knopf ruft `navigate(mailPath(mailboxId))` — ohne Query. Das Kürzel `u` ruft `mailHref()`, dessen Kommentar wörtlich erklärt, warum das Verwerfen schädlich ist: *„dropping them snaps the list back to the plain folder … resets the focus and the selection out from under the user mid-triage."*
- **Warum:** Auf dem Telefon ist der Knopf der einzige Weg zurück. Zwei Umsetzungen desselben Befehls, eine davon im eigenen Code als schädlich dokumentiert.
- **Vorschlag:** `mailHref` in ein geteiltes Modul heben und von beiden Stellen benutzen.

### B3 · `router.back()` existiert und hat null Aufrufer — die Rückgeste öffnet die Mail erneut
- **Schwere:** hoch · **Wo:** Lesen, Telefon · `RouterProvider.tsx:75–77`
- **Beleg:** Einziges `.back()` im Quellbaum ist `window.history.back()` in der Definition selbst. Der sichtbare Zurück-Knopf **pusht** stattdessen. Danach steht im Stack `[Liste, Nachricht, Liste]` — die Systemgeste öffnet die gerade verlassene Nachricht wieder.
- **Warum:** `MailScreen.tsx:9` verspricht ausdrücklich das Gegenteil. Im installierten PWA-Modus gibt es keinen Browser-Zurück-Knopf als Rettung.
- **Vorschlag:** `back()` benutzen, wenn der eigene Push-Eintrag noch oben liegt, sonst `replace`.

### B4 · Auf dem Telefon steht nirgends, in welchem Ordner man ist
- **Schwere:** hoch · **Wo:** Telefon · `MailScreen.tsx:136`, `MessageList.tsx:595`
- **Beleg:** Pane und Grid tragen beide nur `aria-label="Nachrichten"`. Kein `<h1>`/`<h2>`, kein Ordnername im Screenshot.
- **Warum:** Papierkorb, Archiv und Posteingang sehen identisch aus — aber Wischen-zum-Archivieren bedeutet dort jeweils etwas anderes.
- **Vorschlag:** Ordnername als Titel in die Toolbar-Zeile (siehe A2 — dieselbe Zeile).

### B5 · Der Drawer bleibt offen, wenn man den bereits geöffneten Ordner antippt
- **Schwere:** hoch · **Wo:** Telefon + Tablet · `MailScreen.tsx:106–113`
- **Beleg:** Die Schließ-Logik ist auf eine **Änderung** von `selectionKey` gekoppelt; derselbe Ordner erzeugt denselben Schlüssel, der Effekt kehrt sofort zurück. Der bestehende Test `narrow.spec.ts:133` wählt bewusst *Archiv*, also einen anderen Ordner — die Variante ist ungetestet.
- **Warum:** Es gibt dann keinen sichtbaren Ausweg: kein Schließen-Knopf, Escape braucht eine Tastatur, und der Backdrop ist ein 102 px schmaler grauer Streifen. Genau die Sackgasse, die der Kommentar darüber als behoben beschreibt.
- **Vorschlag:** Auf das Auswahl-**Ereignis** schließen statt auf die Zustandsänderung.

### B6 · Der Drawer ist modal gebaut, verhält sich aber nicht so
- **Schwere:** mittel · **Wo:** Telefon + Tablet · `MailScreen.tsx:75`, `:143`
- **Beleg:** Kein Fokuswechsel beim Öffnen, keine Fokusfalle, kein `aria-modal`, kein Schließen-Knopf — obwohl `ui/Dialog.tsx` all das bereits kann. Tab führt aus dem Drawer heraus **unter** den Scrim.
- **Vorschlag:** Fokus setzen und fangen, sichtbaren Schließen-Knopf ergänzen, Öffnen als History-Eintrag pushen, damit die Systemgeste schließt.

### B7 · Zwei Navigationsspalten mit 328 px für drei Ziele und sechs Ordner
- **Schwere:** mittel · **Wo:** Desktop · `shell.module.css` (Rail 4,5 rem + Ordnerspalte 16 rem)
- **Beleg:** 22,8 % der Fensterbreite. Die Ordnerspalte ist zwischen „Papierkorb" und „LABELS" rund 370 px leer.
- **Vorschlag:** Die drei Sektionsziele in Kopf/Fuß der Ordnerspalte einhängen und die 72-px-Leiste ab 64em entfallen lassen.

### B8 · `document.title` ist konstant „Waxwing"
- **Schwere:** mittel · **Wo:** überall · `theme.ts:20`
- **Beleg:** Einziger Schreibzugriff im Quellbaum. Die App pusht fleißig History-Einträge — im Zurück-Menü heißen alle gleich.
- **Vorschlag:** Titel aus der Route speisen: Betreff / Ordner (ungelesen) / Einstellungen / Kontakte, jeweils mit Produktname.

### B9 · `/settings/<abschnitt>` ist tote Infrastruktur
- **Schwere:** mittel · **Wo:** Einstellungen · `route.ts:27`, `:101`
- **Beleg:** `rest` wird berechnet und **nirgends** gelesen. `settingsPath(sub)` baut solche Pfade; die Seite ignoriert sie und rendert zehn Abschnitte am Stück ohne Navigation.
- **Vorschlag:** `rest` auswerten und zum Abschnitt springen; auf Desktop eine Abschnittsliste.

### B10 · Ein Tipp auf den aktiven Ordner erzeugt einen doppelten History-Eintrag
- **Schwere:** niedrig · **Wo:** alle Viewports · `FolderTree.tsx:167`
- **Vorschlag:** Bei gleicher Ziel-Mailbox nicht navigieren oder `replace` verwenden.

---

## C — Visuelle Gestaltung und Konsistenz

### C1 · Der Listenkopf hat kein gemeinsames Raster
- **Schwere:** hoch · **Wo:** alle Viewports · `message-list.module.css:9` (`.toolbar`), `:19` (`.control`)
- **Beleg (gemessen, Desktop):** Die drei Auswahlfelder sind **110 / 183 / 126 px** breit. Die Beschriftungen fluchten bei x=340, die rechten Kanten streuen über **114 px** — „Datum" und „Komfortabel" enden 1 px auseinander, was als Schlamperei liest, nicht als Absicht.
- **Warum:** Ursache ist `display: inline-flex` je Gruppe plus inhaltsabhängige Feldbreite. Bei „Datum" sind **60 von 110 px reine Polsterung** (`Select.module.css`: `padding-inline: 12px 48px`).
- **Vorschlag:** `.toolbar` auf `grid-template-columns: max-content 1fr` — dann haben Beschriftungs- und Feldspalte je *eine* Kante. Rechte Polsterung von 48 auf 32 px.

### C2 · Im dunklen Theme steht ein reinweißer Rahmen mitten in der Karte
- **Schwere:** hoch · **Wo:** Lesen, dunkel · `reading.module.css` (`.frame`), `packages/mail-html/src/frame.ts:77`
- **Beleg (nachgeprüft):** `frame.ts:77` pinnt `background:#ffffff;color:#111111` fest. Gemessen: ein Block aus `(255,255,255)`, 669×149 px, auf `#2c2c2e` — Kontrast ≈ 12,8:1, die härteste Kante der Oberfläche. Auf dem Telefon füllt er den halben sichtbaren Kartenbereich.
- **Warum:** Die Begründung (fremdes HTML mit eigener Textfarbe ohne Hintergrund) ist berechtigt, greift aber zu weit: die gezeigte Nachricht ist **Klartext ohne jede Farbangabe**. Für den Normalfall wird ein Problem gelöst, das nicht existiert — und dafür FR-UI-02 („both themes are first-class") an der wichtigsten Stelle gebrochen.
- **Vorschlag:** Wenn der Körper keine eigene `color`/`background` deklariert, mit `--waxwing-surface`/`--waxwing-text` und `color-scheme: dark` rendern. Wo Weiß bleiben muss, den Rahmen als *fremdes Blatt* kennzeichnen (Radius, Rahmenlinie, Innenabstand) statt randlos einzusetzen.

### C3 · `:hover` löscht die Aktivmarkierung der Navigationsschiene
- **Schwere:** hoch · **Wo:** Tablet + Desktop · `shell.module.css:190` und `:194`
- **Beleg (nachgeprüft):** `.primaryNavItem[aria-current="page"]` steht in Zeile 190, `.primaryNavItem:hover` in Zeile 194. Beide haben **dieselbe Spezifität** (0,2,0) — die spätere Regel gewinnt. Sobald die Maus auf dem aktiven Reiter steht, wechselt seine Farbe von Akzent auf normalen Text.
- **Warum:** Orientierungsverlust genau in dem Moment, in dem der Nutzer hinzeigt.
- **Vorschlag:** Aktiv-Regel auf `[aria-current="page"], [aria-current="page"]:hover` erweitern und Hover in `@media (hover: hover)` einschließen.

### C4 · Suchtreffer werden im Browser-Standardgelb hervorgehoben
- **Schwere:** hoch · **Wo:** Suche, beide Themes · `MessageRow.tsx:223, 231`
- **Beleg (nachgeprüft):** Es gibt **keine** `mark`-Regel in `message-list.module.css` — die einzige im Projekt steht in `shortcuts.module.css:82` und macht es richtig (transparent, Akzentfarbe, halbfett). In der Liste greift daher der UA-Standard `#ffff00`.
- **Warum:** Drei Vorgaben auf einmal — §1.1 („no more than one saturated color at rest"), FR-UI-02 (nicht themenbewusst, im Dunklen ein Scheinwerfer) und FR-THEME-01 (über `theme.css` nicht erreichbar, weil nirgends deklariert).
- **Vorschlag:** Die vorhandene Regel aus `shortcuts.module.css` nach `global.css` heben.

### C5 · Zehn unbeschriftete Bedienelemente ohne erkennbare Gruppierung
- **Schwere:** hoch · **Wo:** Lesen · `reading.module.css:240`, `MessageView.tsx:706–826`
- **Beleg:** Sechs Verben aus **vier** Bedeutungsfeldern in einem ununterbrochenen Lauf mit 4 px Abstand, ohne Trenner. Zwei davon sind fast identische Umschlag-Glyphen — `MailWarning` („Spam") und `MailMinus` („Ungelesen") — drei Icons auseinander. Auf dem Telefon bricht die Leiste so um, dass „Verschieben nach…" visuell in der Antwort-Gruppe landet.
- **Warum:** Bulwark beschriftet dieselben Aktionen (Reply · Reply All · Forward | Archive · Delete · Move | Tag · ⋮) und braucht dafür eine Zeile.
- **Vorschlag:** Drei Gruppen mit 16 px Abstand zwischen und 4 px innerhalb. Spam-Glyph vereinheitlichen — die Massenleiste benutzt dafür bereits `Ban`, die Leseansicht `MailWarning`.

### C6 · Der Listenkopf springt um ~100 px, sobald man auswählt oder sucht
- **Schwere:** mittel · **Wo:** Desktop · `message-list.module.css:9–10`
- **Beleg (gemessen):** Unterkante der Kopfzeile — Posteingang y=340, Auswahl y=241, Suche y=432. Ein Häkchen hebt die Liste um **99 px**, eine Suche senkt sie um **92 px**.
- **Warum:** Die Zeile, die man gerade angeklickt hat, wandert unter dem Cursor weg — die zweite Auswahl trifft die falsche Nachricht.
- **Vorschlag:** Feste Kopfzeilenhöhe; Massenleiste und Ansichtsoptionen darin tauschen. Mit A1 zusammen entfällt der Sprung ganz.

### C7 · Elf Icon-Größen, kein Icon-Token
- **Schwere:** mittel · **Wo:** app-weit · `tokens.css`
- **Beleg:** Elf verschiedene Werte in den Stylesheets (0,5 / 0,75 / 0,85 / 0,875 / 1 / 1,05 / 1,1 / 1,15 / 1,25 / 1,35 / 1,5 rem), dazu die 24 px, die `IconButton` ungeprüft von lucide durchreicht. `tokens.css` kennt **keinen** Icon-Token. Zwei Werte liegen 0,4 px auseinander.
- **Warum:** §2 verspricht „All tokens are CSS custom properties". Icons sind das häufigste visuelle Element und stehen als einzige Kategorie außerhalb des Systems.
- **Vorschlag:** `--waxwing-icon-sm/md/lg` einführen und die elf Vorkommen darauf abbilden.

### C8 · 358 px Leerraum zwischen Ordnern und Labels
- **Schwere:** mittel · **Wo:** Desktop · `folder-tree.module.css:5` (`.container { block-size: 100% }`)
- **Beleg (gemessen):** Genau eine Lücke, y=299,5 bis y=658 — **40 % der Viewporthöhe** zwischen „Papierkorb" und „LABELS". Der Ordnerbaum beansprucht die volle Höhe unabhängig vom Inhalt.
- **Vorschlag:** `flex: 0 1 auto; min-block-size: 0` statt `block-size: 100%`; nur die Speicheranzeige per `margin-block-start: auto` nach unten.

### C9 · Zwei Auswahlsprachen — im Ordnerbaum ist Auswahl von Hover nicht unterscheidbar
- **Schwere:** mittel · **Wo:** alle Viewports · `folder-tree.module.css:54` gegen `:58`
- **Beleg:** Der ausgewählte Ordner nutzt `--waxwing-surface-2` — **denselben Wert** wie `:hover` zwei Zeilen darüber. Die ausgewählte Nachricht nutzt dagegen `--waxwing-surface-selected`.
- **Warum:** §2.1 sagt, Auswahl werde von Fokusring **plus** Flächenänderung getragen. Hier ist die Flächenänderung nicht unterscheidbar; es bleibt der Akzenttext als einziges Signal.
- **Vorschlag:** App-weit auf `--waxwing-surface-selected` vereinheitlichen, Hover auf `--waxwing-surface-hover`. Beide Tokens existieren bereits.

### C10 · 29 `:hover`-Regeln, nur drei Dateien schützen sie
- **Schwere:** mittel · **Wo:** app-weit, Telefon · 29 Vorkommen gegen 3 Dateien mit `@media (hover: hover)`
- **Beleg:** Sichtbar in `phone/05-auswahl-massenleiste.png`: Zeile 2 trägt einen grauen Hover-Hintergrund, obwohl Zeile 1 angetippt wurde.
- **Warum:** Die Absicht ist bekannt und in `Button.module.css` sogar ausformuliert („so a tap on touch does not stick a hover style") — sie wurde nur nicht durchgezogen.
- **Vorschlag:** Alle `:hover`-Regeln einschließen, `:active` ergänzen, und einen statischen Check analog `focus-indicator.css.test.ts` (ADR-015) dazulegen.

### C11 · Einstellungen: Schalter franst aus, Inhalt klebt in 352 von 1440 px
- **Schwere:** mittel · **Wo:** Desktop · `settings.module.css:1`, `:60`, `ui/Switch.module.css:1`
- **Beleg (gemessen):** Zwei Schalter im selben Abschnitt beginnen bei x≈325 und x≈411 — **86 px Versatz**, weil `Switch .row` die Position aus der Beschriftungslänge ableitet. Rechts davon ~980 px leer.
- **Warum:** Die uneinheitliche Schalterposition macht das senkrechte Abscannen der Zustände unmöglich — genau das, wofür eine Einstellungsliste da ist.
- **Vorschlag:** Schalterzeilen als `justify-content: space-between` innerhalb der 22-rem-Feldbreite — das ist zugleich das iOS-Muster, an dem sich das Design orientiert.

### C12 · Empfängerfeld: 8 px Versatz durch einen doppelt hartkodierten Wert
- **Schwere:** mittel · **Wo:** Verfassen · `recipient-field.module.css:20`, `:153`, `:171`
- **Beleg:** `.label` belegt 40 px, dazu 12 px Außen- und 8 px Innenabstand → Eingabefeld beginnt bei 60 px. Die Cc/Bcc-Umschalter darunter benutzen den hartkodierten `padding-inline-start: 2.5rem` und beginnen bei 52 px — der Wert vergisst den Gap, an beiden Stellen.
- **Warum:** §2.3 verlangt „no arbitrary pixel spacing". Siehe auch **D5** (unsichtbares Feld).
- **Vorschlag:** Zeile auf `grid-template-columns: 2.5rem 1fr` umstellen — dann ist der Versatz strukturell unmöglich.

### C13 · Nachrichtenkörper mit 87 Zeichen Zeilenlänge
- **Schwere:** mittel · **Wo:** Desktop · `packages/mail-html/src/frame.ts:77`
- **Beleg (gemessen):** Textspalte 653 px bei 16 px Grundschrift → 87 Zeichen. Lesbar sind 45–75.
- **Warum:** Das Projekt kennt die Regel und wendet sie an anderer Stelle an (`shell.module.css`: `.screenLead { max-inline-size: 60ch }`) — nur nicht dort, wo tatsächlich gelesen wird.
- **Vorschlag:** Im Reset `body{max-width:68ch;margin-inline:auto}`, sofern die Nachricht kein eigenes Layout mitbringt.

### C14 · Die Massenleiste bricht um, die zweite Zeile hat keinen Bezug zur ersten
- **Schwere:** mittel · **Wo:** Auswahl · `message-list.module.css:9–10`
- **Beleg:** Desktop 5+2, Telefon 4+3; Zeile 2 beginnt jeweils ganz links, Zeile 1 erst bei x≈200. Der Umbruchpunkt ist zufällig.
- **Vorschlag:** Überzählige Aktionen ins ⋯-Menü auslagern statt umzubrechen — das Muster existiert in `MessageView` bereits.

### C15 · Ungelesen-Punkt und Label-Farbtupfer sind geometrisch identisch
- **Schwere:** niedrig · **Wo:** Nachrichtenliste · `message-list.module.css:269` gegen `labels.module.css:11`
- **Beleg:** Beide `0.5rem` rund. In derselben Zeile ~330 px auseinander; einziger Unterschied ist die Farbe.
- **Warum:** `tokens.css:29–31` legt ausdrücklich fest, dass Farbe nie das alleinige Signal sein darf. In Graustufen sind beide derselbe Punkt.
- **Vorschlag:** Der Ungelesen-Marke eine eigene Form geben — oder sie ganz durch die vorhandene Halbfett-Gewichtung plus einen Kantenstreifen ersetzen.

### C16 · Die Farbtabelle des Design-Systems ist veraltet — und der Mail-Rahmen konserviert den alten Akzent
- **Schwere:** niedrig · **Wo:** `docs/design-system.md` §2.1 · `tokens.css` · `packages/mail-html/src/frame.ts:79`
- **Beleg (nachgeprüft):** Doku sagt Akzent hell `#2f6fe0` / dunkel `#5e93f0`; der Code sagt `#2761c4` / `#82acf5`. Ebenso Fokusring und `danger` dunkel (`#ff6b60` gegen `#ff8078`). Und `frame.ts:79` setzt Links in E-Mails auf `a{color:#2f6fe0}` — den **alten** Akzent, der heute in keinem Theme mehr existiert.
- **Warum:** `design-system.md` ist laut eigenem Kopf das Dokument, gegen das Entscheidung **D5** abgenommen wurde. Zusätzlich schlägt eine Betreiber-`accentColor` überall durch, nur nicht bei Links in Nachrichten (FR-THEME-01).
- **Vorschlag:** Tabelle aus `tokens.css` erzeugen oder in `tokens.contrast.test.ts` mitprüfen — der Parser dafür existiert. Linkfarbe im `srcdoc` aus dem berechneten Token einsetzen.

### C17 · Zwei faktische Bedienelementhöhen, keine davon auf dem 8-pt-Raster
- **Schwere:** niedrig · **Wo:** Zeigergeräte · `tokens.css:135`, `Select.module.css` / `TextInput.module.css` gegen `Button.module.css`
- **Beleg:** Eingabefelder und Auswahlfelder setzen zusätzlich `padding-block`, kommen also auf **39 px**; Knöpfe und Menüs auf **34 px**. §2.6 beschreibt `--waxwing-control-min` als Mindesthöhe *jedes* Bedienelements — für Eingabefelder ist der Token faktisch nie wirksam. Beide Werte liegen zwischen den Rasterschritten 32 und 40.
- **Hinweis:** Auf Touch ist das folgenlos — `pointer: coarse` hebt beide auf 44 px.
- **Vorschlag:** Token auf 2,25 oder 2,5 rem setzen und die Höhe per `align-items: center` statt per Polsterung erzeugen.

---

## D — Texte, Zustände und Formulare

### D1 · Die deutsche Fassung eines Datenschutzhinweises sagt etwas anderes als die englische
- **Schwere:** hoch · **Wo:** Einstellungen → Benachrichtigungen · Schlüssel `notify.background.contentless`
- **Beleg (nachgeprüft):**
  - EN: „… never the sender or the subject — **and the folder setting above does not apply to them**."
  - DE: „… nie Absender oder Betreff –, **und der Server erfährt nichts über den Inhalt**."
- **Warum:** Die deutsche Fassung erfindet eine Aussage über den Server und lässt den einzigen operativen Vorbehalt weg. Ein deutscher Nutzer stellt „Für diese Ordner benachrichtigen" ein und wird trotzdem über andere Ordner benachrichtigt, ohne dass es ihm je gesagt wurde.
- **Vorschlag:** DE: „Diese Mitteilungen melden nur, dass Post eingegangen ist — nie Absender oder Betreff. Die Ordner-Auswahl oben gilt für sie nicht."

### D2 · Ein Leerzustand verweist auf eine Einstellung, die es nicht gibt
- **Schwere:** hoch · **Wo:** Nachrichtenliste, **beide Sprachen** · `list.emptyOutsideWindow`, `MessageList.tsx:165`
- **Beleg (nachgeprüft):** Beide Fassungen fordern auf, „den Offline-Zeitraum in den Einstellungen zu erweitern". `offline.cacheDays` stammt ausschließlich aus der Betreiber-Konfiguration (`config.ts:75`); `StorageSection.tsx:174` **zeigt** den Wert nur an. Es gibt keinen Setter.
- **Warum:** FR-UI-04 verlangt, einen gangbaren Weg zu nennen. Hier wird ein Weg genannt, den es nicht gibt — schlimmer als Schweigen.
- **Vorschlag:** Entweder ein Bedienelement nachrüsten oder den Text auf das reduzieren, was stimmt.

### D3 · Der Löschdialog verschweigt auf Deutsch die Entwarnung
- **Schwere:** hoch · **Wo:** Kontomenü → „Abmelden und Daten entfernen" · `account.confirmRemove.body`
- **Beleg (nachgeprüft):** EN endet mit „Mail on the server is not affected." — der deutsche Satz fehlt ersatzlos.
- **Warum:** Der destruktivste Dialog der Anwendung. Der weggelassene Satz ist genau der, der die Fehlentscheidung verhindert.
- **Vorschlag:** DE ergänzen: „Ihre Nachrichten auf dem Server bleiben unverändert."

### D4 · Der Hinweis zu externen Bildern verliert auf Deutsch seine Begründung
- **Schwere:** hoch · **Wo:** Einstellungen → Lesen · `settings.reading.remote.hint`
- **Beleg (nachgeprüft):** EN 110 Zeichen mit Grund („tell the sender that you opened the message, and reveal your IP address"), DE 35 Zeichen: „Ausgeschaltet ist die sichere Wahl."
- **Warum:** „Sicher" ohne „wovor" ist eine Behauptung, keine Entscheidungshilfe.
- **Vorschlag:** Die Begründung übersetzen. Dasselbe Muster in `settings.server.mailMissing` und `notify.background.renewal`.

### D5 · Das Empfängerfeld „An" hat keine sichtbare Umrandung
- **Schwere:** hoch · **Wo:** Verfassen, alle Viewports · Screenshot `phone/09-verfassen-neu.png`
- **Beleg (gemessen):** 318×32 px, `border: 0px none`, transparenter Hintergrund. Das Feld „Betreff" direkt darunter hat eine sichtbare Box.
- **Warum:** Auf dem Telefon sieht die wichtigste Zeile des Formulars aus wie leerer Raum. Bulwark zeigt an derselben Stelle einen Empfänger-Chip mit ×.
- **Vorschlag:** Dieselbe Feldoptik wie „Betreff".

### D6 · Der Anmeldebildschirm nennt den Host statt des Produkts — und hat zwei Anmeldeknöpfe ohne erklärten Unterschied
- **Schwere:** hoch · **Wo:** Anmeldung · `LoginForm.tsx:79`, `:113`
- **Beleg:** Überschrift „Bei localhost:4183 anmelden". Zwischen „Sicher anmelden" und „Anmelden" steht ein rein dekoratives `<div aria-hidden>` — kein Wort Erklärung. Die vorhandene Erklärung erscheint nur, wenn OAuth *nicht* verfügbar ist.
- **Warum:** Die implizite Botschaft ist, dass der zweite Knopf unsicher sei — ohne das je auszusprechen.
- **Vorschlag:** „Bei {{product}} anmelden", Host als Unterzeile, Trenner beschriften („oder mit Passwort:").

### D7 · „Alle auswählen" heißt auch dann so, wenn es abwählt
- **Schwere:** mittel · **Wo:** Massenauswahl · `MessageList.tsx:1087`
- **Beleg (nachgeprüft):** `aria-label={t('list.selectAll')}` ist statisch, während `onChange` bei gesetztem Haken `onClear()` ausführt. Der passende Schlüssel `list.clearSelection` existiert und wird nirgends verwendet.
- **Vorschlag:** `aria-label={allSelected ? t('list.clearSelection') : t('list.selectAll')}` — kein neuer String nötig.

### D8 · Tautologie-Muster: Sektionstitel als Feldbeschriftung, dreimal
- **Schwere:** mittel · **Wo:** Liste + Einstellungen · `MessageList.tsx:877`
- **Beleg:** Beschriftung und ausgewählter Wert sind derselbe `t('list.view.threaded')` — ein `list.view.label` existiert nicht. Ebenso „Darstellung/Darstellung" und „Server/Server".
- **Vorschlag:** Drei Schlüssel ergänzen: „Ansicht", „Farbschema", „Adresse". Nebeneffekt: ~110 px schmaler, was den Umbruch auf dem Desktop verhindert.

### D9 · Leerzustände sind durchweg Sackgassen
- **Schwere:** mittel · **Wo:** Kontakte, Suche, Ordner, Labels
- **Beleg:** „Keine Kontakte." / „Keine Gruppen." / „Noch keine Labels." / „Keine Nachrichten entsprechen Ihrer Suche." — keiner nennt den nächsten Schritt, obwohl die Aktion jeweils danebenliegt. Im Kontakte-Bildschirm steht zugleich rechts „Wählen Sie einen Kontakt aus" — in einer leeren Liste unausführbar.
- **Warum:** Die Anwendung kann es besser: `shortcuts.unavailable.hint` und `list.viewOptionsUnavailable` nennen Grund **und** Ausweg. Die Leerzustände wurden von diesem Standard ausgenommen.
- **Vorschlag:** Je einen Handlungssatz ergänzen; `contacts.detail.empty` bei leerer Liste unterdrücken.

### D10 · Die Anrede kippt in drei Strings von „Sie" auf „Du"
- **Schwere:** mittel · **Wo:** Aufräum-Dialoge + Liste · `cleanup.empty.retention`, `cleanup.older.retention`, `list.emptyOutsideWindow`
- **Beleg:** 69 Strings siezen, 2 duzen („Dein Anbieter…"), plus ein Du-Imperativ („erweitere…"). Auf Englisch unsichtbar („your").
- **Warum:** Der Bruch trifft ausgerechnet die Bestätigungsdialoge für unwiderrufliche Löschungen.
- **Vorschlag:** Vereinheitlichen und die Sie-Anrede in `CONTRIBUTING.md` festschreiben.

### D11 · Erklärtext wohnt dauerhaft in der Navigationsspalte
- **Schwere:** mittel · **Wo:** Ordnerspalte + Drawer · `labels/Labels.tsx:76–78`
- **Beleg:** Drei Zeilen Fließtext unter einem einzigen Label — mehr vertikaler Raum als das Label selbst. Bedingung ist nur, dass überhaupt ein Label gefunden wurde, also praktisch dauerhaft.
- **Vorschlag:** An die Labels selbst hängen oder auf einen Satz kürzen.

### D12 · Suchsyntax und Trefferzahl sind nur für Screenreader da
- **Schwere:** mittel · **Wo:** Suche · `SearchBox.tsx:80`, `MessageList.tsx:574–580`
- **Beleg:** Der Operator-Hinweis (`from:`, `subject:`, `has:attachment` …) steckt in `VisuallyHidden`; die Trefferzahl ebenso. Sehende Nutzer erfahren beides nie.
- **Vorschlag:** Trefferzahl sichtbar über die Liste, Operator-Hinweis als aufklappbare „Suchtipps".

### D13 · „Betreff" als Beschriftung *und* als Platzhalter
- **Schwere:** mittel · **Wo:** Verfassen · `compose.subjectLabel` / `compose.subjectPlaceholder`
- **Beleg:** Beide Schlüssel tragen denselben Wert, in beiden Sprachen. Die Anwendung macht es anderswo richtig (`settings.vacation.subject.placeholder` = „Nicht im Büro").
- **Vorschlag:** Platzhalter entfernen oder als Beispiel formulieren.

### D14 · Verwaiste Strings: übersetzt, gepflegt, nie angezeigt
- **Schwere:** niedrig · **Wo:** `shell.list.empty`, `list.clearSelection`, `status.sync.idle`, `status.sync.offline`, `status.online`
- **Warum:** Bei zweien ist es ausgerechnet der bessere Text, der brachliegt (siehe B1 und D7).

---

## E — Testabdeckung

### E1 · Das Tablet-Tier hat noch nie jemand geprüft
- **Schwere:** hoch · **Wo:** `e2e/playwright.*.config.ts`
- **Beleg:** Neun Konfigurationen. Jedes Projekt läuft auf `devices['Desktop Chrome']` (1280×720), außer `chromium-touch` und `chromium-phone` (beide 390×844). **Zwischen 40em und 64em läuft keine einzige Zusicherung.**
- **Warum:** Genau deshalb konnte E2 unentdeckt bleiben.
- **Vorschlag:** Die `noOverflow`-Prüfung aus `narrow.spec.ts` zusätzlich bei 834 px und 1440 px laufen lassen.

### E2 · „Einstellungen" wird am linken Bildschirmrand abgeschnitten
- **Schwere:** mittel · **Wo:** Tablet + Desktop · `shell.module.css` `.primaryNav` / `.primaryNavItem`
- **Beleg (gemessen):** Leiste 72 px, Textfeld 55 px, deutsche Beschriftung **72 px** — sie beginnt bei **x = −1**. „Kontakte" (47 px) und „E-Mail" (34 px) passen. Auf dem Telefon (Fußleiste, 88 px je Ziel) tritt es nicht auf.
- **Warum:** Die oberste Navigationsebene ist in der ausgelieferten deutschen Oberfläche unvollständig lesbar. Auf Englisch („Settings") fällt es nicht auf.
- **Vorschlag:** Leiste auf 5,5 rem, oder Kürzung mit Ellipse und vollem Namen im `title`.

---

## Was gut ist

Damit die Liste kalibriert bleibt — geprüft und in Ordnung:

- **Touch-Zielgrößen.** `tokens.css` hebt `--waxwing-control-min` unter `pointer: coarse` korrekt von 34 auf 44 px an. Die 18-px-Kontrollkästchen der Liste sind **kein** Befund: `Checkbox.tsx` wickelt sie in ein Label mit `min-inline-size: var(--waxwing-control-min)`, das reale Ziel ist 44×44.
- **Wisch-Beschriftungen.** Trotz gegenteiligen Anscheins im Snapshot-Werkzeug korrekt `aria-hidden="true"` (`MessageList.tsx:789`).
- **Kontoname auf dem Telefon.** Visuell versteckt statt `display: none`, damit er im Accessibility-Baum bleibt — mit Begründung im Code.
- **Massenauswahl-Leiste** ersetzt die Ansichts-Leiste, statt sie zu stapeln.
- **Befehlspalette** erreicht jede Aktion und jeden Ordner, hergeleitet statt handgepflegt, und ist auf Touch über einen sichtbaren Knopf erreichbar.
- **Fokusübergabe beim Pane-Wechsel** inklusive bewusster Ausnahme beim ersten Mount.
- **Skip-Link** umgeht die `<base href>`-Falle bewusst per Handler.
- **Übersetzungsabdeckung.** 834 zu 834 Schlüssel, keine Lücke in beiden Richtungen, Plurale durchgehend gepflegt, keine hartkodierten sichtbaren Strings.
- **Phishing-Erklärung** (`reading.linkWarning.*`) — der beste Text der Anwendung: erklärt Ziel-Täuschung ohne ein einziges Fachwort und endet mit einer Handlungsempfehlung.
- **Deaktivierte Steuerelemente in der Suche** sagen, warum sie deaktiviert sind — genau das, was FR-UI-04 verlangt.
- **Druckregeln** blenden die gesamte Chrome aus.
- **Datums- und Größenformate** durchgehend über `Intl` lokalisiert.
- **Keine hartkodierten Schriftgrößen.** `grep 'font-size:' *.module.css | grep -v 'var(--waxwing-text'` liefert **null** Treffer — die Typoskala wird ausnahmslos über Tokens bezogen.
- **Kaum hartkodierte Abstände.** Über alle Modul-Stylesheets 14 numerische Werte, fast alle optische Korrekturen mit Begründung. Einzige echte Verletzung ist C12.
- **Logische CSS-Eigenschaften.** Kein `left`/`right`/`margin-left` irgendwo; `--waxwing-flip` löst sauber das eine Problem, das logische Eigenschaften nicht abdecken.
- **Fokusindikator.** Globaler Ring, und jede Komponente, die ihn ersetzt, liefert einen Ersatz — maschinell erzwungen durch `focus-indicator.css.test.ts`.
- **Kontrastprüfung.** 42 Token-Assertions sind ein echter Test, kein Versprechen; die beiden Zusatzprüfungen aus ADR-015 decken genau die Lücken ab, an denen CSS sonst still versagt.
- **Dunkles Theme auf Token-Ebene.** Alle Theme-Blöcke tragen dieselben Schlüssel, die Flächenstaffelung ist im Dunklen sogar *deutlicher* als im Hellen (1,30:1 gegenüber 1,06:1). Es ist keine Einfärbung — es scheitert nur an den zwei hartkodierten Stellen C2 und C4.
- **Radien und Elevation** durchgehend konsistent nach Rolle vergeben, keine Ausreißer.

## Nicht verifiziert

- Das Verhalten der iOS-Wischgeste und der Android-Zurückgeste im installierten PWA-Modus. Die Aussagen zu B3/B6 stützen sich auf den Quellcode (`back()` ohne Aufrufer, Drawer ohne History-Eintrag), nicht auf ein Gerät.
- Ob reale Browserleisten die nutzbare Höhe zusätzlich reduzieren. `100dvh` deckt es konzeptionell ab; gemessen wurde bei vollen 844 px.
