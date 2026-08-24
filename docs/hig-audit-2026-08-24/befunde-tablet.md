# HIG-Befunde — Viewport **Tablet (iPadOS)**

**Umgebung.** 834×1112 (iPad hochkant) und 1112×834 (quer), Safari auf iPadOS sowie als
Startbildschirm-App (`display: standalone`, `viewport-fit=cover`). `hasTouch`,
`pointer: coarse`, `hover: none`, optional Magic Keyboard/Trackpad.
In Waxwing liegt 834 px zwischen 40em (640) und 64em (1024) ⇒ Tier `tablet` (zweispaltig,
Ordner als Schublade); 1112 px ⇒ Tier `desktop` (dreispaltig, Ordnerleiste dauerhaft).

**Prüfverfahren (Gegenprüfung).** Jeder Rohbefund wurde gegen den Quellcode unter
`/home/heiko/repositories/waxwing/apps/web/src` geöffnet (Datei:Zeile nachgeschlagen,
Media-Query auf Greifen im Viewport geprüft), gegen die Originalseite der HIG
(`/tmp/hig.sh <slug>`, Wortlaut **und** Plattformabschnitt) und gegen die bereits getroffenen
Entscheidungen in `docs/design-system.md`, `docs/ui-audit.md`, `docs/adr/` sowie den
Quellcode-Kommentaren. Zusätzlich wurde geprüft, ob der Vorschlag Waxwing auf
Windows/Linux/Android beschädigen würde.

**Zählung.** 17 Rohbefunde → 3 Doppelungen zusammengefasst → **14 eigenständige Punkte**:
**2 bestätigt · 7 korrigiert · 5 verworfen** (davon 2 als Doppelung).

---

### T-01 — Verfassen-Fenster und Dialoge weichen der Bildschirmtastatur nicht aus
*(vormals T2-01, bestätigt)*

- **Stand (2026-08-24):** Behoben. `ui/viewport-metrics.ts` misst das sichtbare Band aus `visualViewport` und veröffentlicht Höhe UND Versatz; Shell, Dialog und Composer lesen es.
- **Schwere:** hoch
- **Einordnung:** anpassen
- **HIG-Regel:** „Use the keyboard layout guide to make the keyboard feel like an integrated part
  of your interface. Using the layout guide also helps you keep important parts of your interface
  visible while the virtual keyboard is onscreen." — `virtual-keyboards`, Abschnitt „iOS, iPadOS"
  (Wortlaut am 2026-08-24 auf der Seite verifiziert).
- **Ist:** Die App wertet die eingeblendete Tastatur nirgends aus — `grep -rn
  "visualViewport\|interactive-widget" apps/web/src apps/web/index.html` → **0 Treffer**;
  `apps/web/index.html:16` trägt `width=device-width, initial-scale=1, viewport-fit=cover`.
  Die Shell ist auf die Layout-Viewporthöhe genagelt und scrollt nicht
  (`apps/web/src/app/shell/shell.module.css:29-34`, `block-size: 100vh; block-size: 100dvh;
  overflow: hidden`) — `dvh` folgt den Browserleisten, nicht der Tastatur. Alle drei Tippflächen
  sind unten oder mittig verankert: die Composer-Ebene ist `position: fixed; inset-block-end: 0`
  (`apps/web/src/compose/composer.module.css:7-10`), das Fenster bis `max-block-size: 80vh`
  (`:70`) mit der Fussleiste (Senden/Verwerfen) als `flex-shrink: 0` am unteren Ende
  (`:330-338`), und ein Dialog ist mittig mit
  `max-block-size: calc(100vh - 2 * var(--waxwing-space-4))` (`apps/web/src/ui/Dialog.module.css:42`).
  Bei ~300–400 px iPad-Tastatur liegen Senden, Verwerfen und die Dialog-Fussleiste darunter;
  `position: fixed` wird auf iOS nicht mit der sichtbaren Höhe mitgeführt.
- **Soll:** `window.visualViewport` abonnieren (`resize` + `scroll`), die sichtbare Höhe in ein
  Token schreiben (z. B. `--waxwing-viewport-block`) und dieses statt `100dvh`/`100vh` verwenden:
  für `.app`, für `Dialog.module.css .panel { max-block-size }` und als `inset-block-end`-Offset
  der Composer-`.layer`. Zusätzlich `interactive-widget=resizes-content` ins Viewport-Meta (wirkt
  in Chromium, schadet in Safari nicht). Prüfkriterium: mit offener Tastatur müssen das fokussierte
  Feld **und** die Primäraktion sichtbar bleiben.
- **Beleg:** `apps/web/index.html:16`; `shell.module.css:29-34`; `Dialog.module.css:42`;
  `composer.module.css:7-10`, `:68-70`, `:330-338`.
- **Aufwand:** L
- **Nur am Gerät endgültig entscheidbar** (Umfang der Verdeckung; mit Magic Keyboard entfällt der
  Fall ganz, die iPad-Tastatur hat zudem eine Ausblendtaste als Notausgang).

---

### T-02 — Sektionsnavigation auf dem Tablet ohne sichtbare Beschriftung
*(vormals T-03 und T2-03, zusammengefasst, korrigiert)*

- **Stand (2026-08-24):** Behoben. Das Ausblenden der Beschriftung hängt jetzt an `(hover: hover)` statt an der Breite — also daran, ob es die Kompensation überhaupt gibt.
- **Schwere:** mittel
- **Einordnung:** anpassen
- **HIG-Regel:** „Include tab labels to help with navigation. A tab label appears beneath or beside
  a tab bar icon, and can aid navigation by clearly describing the type of content or functionality
  the tab contains. Use single words whenever possible." und „Tab bar icons appear above tab labels
  in compact views, whereas in regular views, the icons and labels appear side by side."
  — `tab-bars`, Best practices (plattformübergreifend, kein macOS-Import).
- **Ist:** Ab 40em — also im gesamten Tablet-Bereich, hochkant wie quer — wird die Beschriftung der
  fünf Bereiche visuell entfernt: `apps/web/src/app/shell/shell.module.css:539`
  (`@media (min-width: 40em)`) und `:580-590` (`.primaryNavLabel { position: absolute;
  inline-size: 1px; block-size: 1px; … clip-path: inset(50%) }`). Als Ersatz nennt der Kommentar
  `:553-556` ausdrücklich den Zeiger („its `title` shows it to a pointer"), und
  `apps/web/src/app/shell/PrimaryNav.tsx:57` setzt `title={t(labelKey)}`. Auf iPadOS gilt
  `hover: none`: der Tooltip erscheint im Fingerbetrieb nie. `docs/design-system.md:146` formuliert
  genau diese Regel selbst („`title` is a poor affordance (no keyboard, nothing on touch)").
  Die Telefonleiste unter 40em druckt die Beschriftung dagegen.
- **Korrektur gegenüber den Rohbefunden:** (a) Die Abweichung ist **begründet dokumentiert**
  (`shell.module.css:544-562`: 6rem Railbreite für „Einstellungen", Label bleibt im
  Barrierefreiheitsbaum) — der Befund bleibt nur deshalb stehen, weil die dort genannte Kompensation
  („`title` zeigt es dem Zeiger") für genau diesen Viewport nachweislich nicht greift. (b) Die
  Behauptung „oberste Navigationsebene ohne jede Information" ist zu stark: die Icons sind sichtbar,
  der Name steht im Accessibility-Baum, ein Screenreader liest ihn.
- **Soll:** Entweder das Ausblenden auf `@media (hover: hover)` beschränken (Zeigergeräte behalten
  die schmale Icon-Schiene, Touch-Geräte bekommen das Wort) oder die Beschriftung erst ab 64em
  drucken, wo im iPad-Querformat 1112 px vorhanden sind. Zwei Zeilen bei `--waxwing-text-xs`
  entschärfen das im Kommentar genannte deutsche „Einstellungen".
- **Beleg:** `shell.module.css:539`, `:544-562`, `:580-590`; `PrimaryNav.tsx:57`;
  `docs/design-system.md:146`.
- **Aufwand:** S

---

### T-03 — Empfänger-, Benutzer- und Serverfeld ohne Eingabesemantik
*(vormals T2-02, korrigiert)*

- **Stand (2026-08-24):** Behoben. `TextInput` leitet `autoCapitalize`/`autoCorrect`/`spellCheck` aus dem ab, was die Fundstelle bereits über das Feld sagt; das Empfängerfeld trägt sie ausgeschrieben.
- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** „Choose a keyboard that matches the type of content people are editing. … When you
  specify a semantic meaning for a text input area, the system can automatically provide a keyboard
  that matches the type of input you expect, potentially using this information to refine the
  keyboard corrections it offers." — `virtual-keyboards`, Best practices.
- **Ist:** `grep -rn "enterKeyHint\|autoCapitalize\|autoCorrect" apps/web/src` → **0 Treffer**.
  Das Empfängerfeld des Composers ist ein nacktes Textfeld:
  `apps/web/src/compose/RecipientField.tsx:384-393` — `type="text"`, `role="combobox"`, ARIA, aber
  weder `inputMode` noch `autoCapitalize`/`autoCorrect`/`spellCheck`. Auf iPadOS heisst das: kein
  `@` auf der ersten Tastaturebene, Grossbuchstabe am Adressanfang, Autokorrektur in Domainnamen.
  Ebenso der Anmeldename (`apps/web/src/app/onboarding/LoginForm.tsx:197-201`: nur `type="text"`,
  `autoComplete="username"`, `spellCheck={false}` — `spellcheck` schaltet auf iOS weder
  Grossschreibung noch Autokorrektur ab) und die Serveradresse
  (`apps/web/src/app/onboarding/ConnectForm.tsx:58-63`: `inputMode="email"` + `autoComplete="email"`,
  ohne `autoCapitalize`/`autoCorrect`).
- **Korrektur gegenüber dem Rohbefund:** Der Satz „also trägt die Return-Taste auch im Suchfeld die
  Standardbeschriftung" ist falsch — `apps/web/src/mail/search/SearchBox.tsx:103-105` verwendet
  `type="search"`, und WebKit leitet daraus bereits die Such-/Los-Return-Taste ab. `enterKeyHint`
  im Suchfeld ist damit redundant; die Empfehlung reduziert sich auf die drei genannten Felder
  (dort ist `enterKeyHint` optional, die Abschalter sind der Gewinn).
- **Soll:** Am Empfängerfeld `inputMode="email" autoCapitalize="none" autoCorrect="off"
  spellCheck={false}` ergänzen; dieselben Abschalter an Benutzername und Serveradresse. `TextInput`
  reicht die Intrinsics des `<input>` durch — Attribut-Patch, kein Umbau, und auf
  Desktop-Browsern folgenlos.
- **Beleg:** `RecipientField.tsx:384-393`; `LoginForm.tsx:197-201`; `ConnectForm.tsx:58-63`;
  `SearchBox.tsx:103-105`.
- **Aufwand:** S
- **Nur am Gerät endgültig entscheidbar** (welche Heuristik WebKit aus `autoComplete` allein
  bereits ableitet).

---

### T-04 — Kein `color-scheme`: systemgezeichnete Teile bleiben im Dunkelmodus hell
*(vormals T-06, bestätigt)*

- **Stand (2026-08-24):** Behoben — siehe D-07.
- **Schwere:** mittel
- **Einordnung:** anpassen
- **HIG-Regel:** „Ensure that your app looks good in both appearance modes." und „Embrace colors
  that adapt to the current appearance. … Avoid using hard-coded color values or colors that don't
  adapt." — `dark-mode`, Best practices / Dark Mode colors.
- **Ist:** `grep -rn "color-scheme" apps/web/src` (ohne Tests) liefert genau **einen** Treffer:
  `apps/web/src/mail/reading.module.css:384` `color-scheme: light;` auf dem Mail-iframe, dort
  bewusst festgenagelt (`:374-377`). Weder `:root` noch `html`/`body` deklarieren es
  (`apps/web/src/ui/tokens.css`, `:root`-Block; `apps/web/src/ui/global.css`). Waxwing schaltet das
  dunkle Thema über `prefers-color-scheme` **und** über `data-theme="dark"`
  (`tokens.css:258-259`, `app/theme.ts`), also auch gegen die Systemeinstellung. Ohne
  `color-scheme` zeichnet WebKit alle systemgerenderten Teile weiter hell: die aufgeklappte
  Auswahl jedes `<select>` (auf dem iPad ein grosses Systempopover — Sortierung/Ansicht in der
  Nachrichtenliste, Auswahlfelder der Einstellungen), Bildlaufleisten und die
  Textauswahl-Hervorhebung. `docs/design-system.md:285` begründet die nativen `<select>`
  ausdrücklich mit „mobile pickers for free" — dann muss der Picker auch das Thema kennen.
- **Soll:** `color-scheme: light dark` auf `:root` und je `color-scheme: light` / `dark` in den
  beiden `:root[data-theme=…]`-Blöcken von `tokens.css`, damit eine erzwungene Themenwahl die
  Systemteile mitnimmt. Der Mail-iframe behält seine eigene, begründete `light`-Deklaration.
- **Beleg:** `reading.module.css:374-384`; `tokens.css` (`:root` ohne Deklaration, dunkle Blöcke ab
  `:258`); `global.css`; `docs/design-system.md:285`.
- **Aufwand:** S
- **Nur am Gerät endgültig entscheidbar** (wie stark WebKit das Popover ohne Deklaration hell
  zeichnet).

---

### T-05 — Untere Safe Area wird oberhalb von 40em nirgends berücksichtigt
*(vormals T-02, korrigiert)*

- **Stand (2026-08-24):** Behoben. Vier Safe-Area-Token, RTL-sicher, und `safe-area.css.test.ts` verbietet `env()` ausserhalb von `tokens.css`.
- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** „A safe area defines the area within a view that isn't covered by a toolbar, tab
  bar, or other views a window might provide. Safe areas are essential for avoiding a device's
  interactive and display features" und „Respect key display and system features in each platform."
  — `layout`, Abschnitt „Guides and safe areas".
- **Ist:** `grep -rn safe-area-inset apps/web/src` liefert exakt zwei Treffer, beide nur für das
  Telefon-Layout: `apps/web/src/app/shell/shell.module.css:170` (untere Leiste) und
  `apps/web/src/compose/new-message-button.module.css:23` (FAB, in `@media (max-width: 39.999em)`).
  Ab 40em berücksichtigt keine Regel den Home-Indikator, während `.app` auf
  `block-size: 100dvh; overflow: hidden` steht (`shell.module.css:29-34`), das Dokument mit
  `viewport-fit=cover` ausgeliefert wird (`apps/web/index.html:16`) und das Manifest
  `"display": "standalone"` setzt (`apps/web/public/manifest.json:8`). Unten am Rand liegen in
  **beiden** Orientierungen: die fest angeheftete Speicheranzeige (`QuotaBar`,
  `MailScreen.tsx:433`, bewusst ausserhalb des Scrollbereichs), das Ende der Nachrichtenliste und
  der Fuss der Leseansicht.
- **Korrektur gegenüber dem Rohbefund:** Der behauptete Kernpunkt „`shell.module.css:567` löscht
  mit der Kurzform `padding` das Safe-Area-Polster aus Zeile 170" trifft zwar kaskadentechnisch zu,
  ist aber **wirkungslos** — ab 40em ist `.primaryNav` eine linke Schiene
  (`flex-direction: column`, `border-inline-end`, `shell.module.css:563-570`), ihre Einträge stehen
  oben (`justify-content: flex-start`), unten steht dort nichts. Ebenso greift der Befund **nur in
  der installierten Startbildschirm-App**: in Safari selbst füllt die Browserleiste den unteren
  Inset, `env(safe-area-inset-bottom)` ist dann 0. Auf dem iPad beträgt der Inset ~20 px — ein
  echter, aber kleiner Überlappungsbereich.
- **Soll:** `padding-block-end: env(safe-area-inset-bottom, 0px)` auf die scrollenden Flächen
  (`.folderScroll`, `.paneBody`, den Scrollcontainer der Nachrichtenliste) bzw. als Innenabstand
  unter der `QuotaBar` legen — nicht auf `.app`, sonst schrumpft das gesamte Raster. Die Safe Area
  wird so zu Scroll-Polster statt zu verdecktem Inhalt; auf Geräten ohne Inset ist der Wert 0 und
  nichts ändert sich.
- **Beleg:** `shell.module.css:170` gegen die Blöcke ab `:539`/`:594`; `shell.module.css:29-34`;
  `apps/web/index.html:16`; `apps/web/public/manifest.json:8`; `MailScreen.tsx:433`.
- **Aufwand:** S
- **Nur am Gerät endgültig entscheidbar** (Ist-Wert des Insets im Standalone-Modus je Orientierung).

---

### T-06 — Split-Breite: Tier-Konstante, einmal beim Mounten gelesen, nie gespeichert
*(vormals T-01, T-09 und T2-08, zusammengefasst, korrigiert)*

- **Stand (2026-08-24):** Behoben — siehe D-06. 37 % ergibt bei 1440 px wieder die gemessenen 420 und gibt dem iPad quer rund 300 statt 420.
- **Schwere:** niedrig
- **Einordnung:** anpassen
- **HIG-Regel:** „Account for narrow, compact, and intermediate window widths. Since iPad windows
  are fluidly resizable, it's important to consider the design of a split view layout at multiple
  widths." — `split-views`, Abschnitt **iPadOS**; dazu „Restore the previous state when your app
  restarts so people can continue where they left off. … Restore granular details of the previous
  state as much as possible." — `launching`.
- **Ist:** Die Primärbreite kommt aus einer zweistufigen Tier-Konstante statt aus der verfügbaren
  Breite: `apps/web/src/app/shell/MailScreen.tsx:365`
  `defaultPrimarySize={tier === 'tablet' ? 340 : 420}`, und `layout.ts:15` kennt nur die Schwellen
  40em/64em. Zwei Folgen derselben Ursache:
  1. **Der 420er-Wert trägt am unteren Rand des `desktop`-Tiers nicht.** Frisch im iPad-Querformat
     geladen: 1112 px − Nav-Schiene (60 px: 44 px Ziel + 2×8 px Polster unter `pointer: coarse`,
     `shell.module.css:563-575`) − Ordnerleiste 16rem = 256 px (`shell.module.css:594-602`)
     = 796 px Panelfläche, minus 420 Liste minus 24 px Trenner
     (`SplitPane.module.css:42-45`) ⇒ **Leseansicht 352 px** — schmaler als die 410 px, die
     hochkant (834 − 60 − 340 − 24) herauskommen, obwohl 278 px mehr Bildschirm da ist. Der
     Kommentar `MailScreen.tsx:352-364` begründet die 420 ausdrücklich mit einem breiten Desktop
     („~930 px Header sassen leer daneben"); den Bereich 1024–1280 px deckt er nicht ab.
  2. **Der Wert wird einmal gelesen und nie gespeichert.** `apps/web/src/ui/SplitPane.tsx:44`
     `useState(() => clamp(defaultPrimarySize, …))` — eine spätere Änderung von
     `defaultPrimarySize` wirkt nicht, und `grep -rn "localStorage.setItem" apps/web/src` findet
     nur Theme, Akzent, Reading-Pane-Modus und den Ephemeral-Index. Jeder Neustart (iPadOS entlädt
     Hintergrund-Tabs und installierte PWAs regelmässig) und jedes Ab-/Anschalten der Leseansicht
     (`MailScreen.tsx:347-376` baut die SplitPane ab) setzt die gezogene Breite zurück.
- **Korrektur gegenüber den Rohbefunden:** Die Erzählung „das Gerät zu drehen macht die Nachricht
  schmaler" ist **falsch** und widerspricht dem jeweils anderen Rohbefund: weil der
  `useState`-Initialisierer nur beim Mounten läuft und die SplitPane beim Tierwechsel montiert
  bleibt, greift die 420 beim Drehen gerade **nicht** — die Liste bleibt bei 340. Der 352-px-Fall
  tritt beim frischen Laden/Neustart im Querformat auf. Ebenfalls entfallen: das Argument, 352 px
  unterschritten die 30rem-Container-Query in `reading.module.css:344-353` — das tun 410 px
  genauso, und der Kommentar dort hält ausdrücklich fest, dass diese Regel **für den schmalen
  Tablet-Lesebereich** gebaut wurde („as a viewport rule this fired on a phone and NOT on a tablet,
  whose reading pane is just as narrow"). Das ist also bereits entschieden und kein Schaden.
- **Soll:** Die Primärbreite als Anteil der gemessenen `paneArea`-Breite ableiten (z. B.
  `clamp(300px, 34%, 460px)`) statt aus der Tier-Konstante; mindestens den 420er-Wert erst ab
  ~1280 px anwenden und zwischen 1024 und 1280 px beim Tablet-Wert bleiben. Die gezogene Breite mit
  demselben leichten Muster persistieren wie `waxwing.readingPane` (`layout.ts:91-120`), als
  Anteil statt in Pixeln, und den Vorgabewert bei einem Tierwechsel neu anwenden, solange der
  Nutzer nie selbst gezogen hat. Prüfkriterium: die Leseansicht darf beim Drehen ins Querformat nie
  schmaler werden.
- **Beleg:** `MailScreen.tsx:352-368`; `SplitPane.tsx:44`; `shell.module.css:594-602`,
  `:563-575`; `SplitPane.module.css:42-45`; `layout.ts:15`, `:91-120`.
- **Aufwand:** M

---

### T-07 — Ordnerleiste lässt sich im Querformat nicht ausblenden
*(vormals T-04, korrigiert)*

- **Stand (2026-08-24):** Behoben — siehe D-05.
- **Schwere:** niedrig
- **Einordnung:** anpassen
- **HIG-Regel:** „Consider letting people hide the sidebar. People sometimes want to hide the
  sidebar to create more room for content details or to reduce distraction. When possible, let
  people hide and show the sidebar using the platform-specific interactions they already know."
  — `sidebars`, Best practices (plattformübergreifend, mit ausdrücklicher iPadOS-Nennung).
- **Ist:** `apps/web/src/app/shell/MailScreen.tsx:160`
  `const drawerCapable = tier !== 'desktop' && !fullScreen` bindet die Umschaltbarkeit an die
  Breite. Der `PanelLeft`-Umschalter (`MailScreen.tsx:272-283`) und der Schliessknopf der Schublade
  (`:410-417`) existieren deshalb nur unterhalb von 64em. Im iPad-Querformat (1112 px ⇒ Tier
  `desktop`) belegt die Ordnerleiste dauerhaft 16rem = 256 px (`shell.module.css:594-602`), und es
  gibt keinen Weg, sie fürs Lesen zurückzuziehen; der einzige Ausweg ist der Vollbildmodus
  `?full=1`, der die Liste gleich mit entfernt.
- **Korrektur gegenüber dem Rohbefund:** Die zitierten Regeln NAV-53/NAV-54 („Consider letting
  people hide a pane" / „Provide multiple ways to reveal hidden panes … including a keyboard
  shortcut") stehen auf `split-views` **im macOS-Abschnitt** und gelten für diesen Viewport nicht.
  Damit entfällt die daraus abgeleitete Pflicht zu einem Tastenkürzel; auf iPadOS nennt die HIG als
  erwartete Interaktion die Kante-Wisch-Geste, die eine Web-App nicht anbieten kann (sie gehört dem
  Browser). Der sichtbare Knopf ist die ehrliche Web-Entsprechung; ein Kürzel in
  `shortcuts/registry.ts` (heute 22 Aktionen, keine für die Ordnerleiste) ist Kür, nicht Pflicht.
  Zu beachten ist ausserdem die zweite Hälfte derselben HIG-Regel — „Avoid hiding the sidebar by
  default to ensure that it remains discoverable" —, die für das Tablet-Hochformat (Schublade zu)
  eher gegen eine Ausweitung des Verstecken-Verhaltens spricht.
- **Soll:** Den vorhandenen `PanelLeft`-Umschalter auch ≥64em anbieten und den Zustand als lokale
  Einstellung merken (Muster: `READING_PANE_KEY`, `layout.ts:91-120`). Standard bleibt „sichtbar".
- **Beleg:** `MailScreen.tsx:160`, `:272-283`; `shell.module.css:594-602`;
  `shortcuts/registry.ts:204-514`.
- **Aufwand:** M

---

### T-08 — Anordnung der Leseansicht nur in den Einstellungen änderbar
*(vormals T2-06, korrigiert)*

- **Stand (2026-08-24):** Behoben. Die Anordnung steht zusätzlich im Ansichtsoptionen-Panel, aus demselben Store; auf dem Telefon nicht angeboten, weil sie dort nichts ändert.
- **Schwere:** niedrig
- **Einordnung:** uebernehmen
- **HIG-Regel:** „When possible, prefer letting people modify task-specific options without going
  to your settings area. For example, if people can adjust things like showing or hiding parts of
  the current view … make these options available in the screens they affect, where they're
  discoverable and convenient. Putting this type of option in a separate settings area disconnects
  it from its context, requiring people to suspend their task to make adjustments, and often hiding
  the results until people resume the task." — `settings`, Abschnitt „Task-specific options".
- **Ist:** Das Ansichtsoptionen-Panel der Nachrichtenliste (`MessageList.tsx`, `Toolbar`) trägt
  Sortierung, Konversationen und „Ungelesene zuerst". Die Anordnung der Leseansicht
  (rechts/unten/aus) — auf einem iPad die häufigste Anpassung, weil hochkant (834 px, 340/410) oft
  „unten" oder „aus" und quer „rechts" die richtige Antwort ist — steht ausschliesslich in
  `apps/web/src/settings/SettingsPage.tsx:332-342` (`onChange={(value) =>
  setReadingPaneMode(value as ReadingPaneMode)}`). Der Wert lebt bereits in einem globalen Store
  (`layout.ts:91-131`), eine zweite Bedienstelle wäre also keine zweite Wahrheitsquelle.
- **Korrektur gegenüber dem Rohbefund:** Die zweite Hälfte — „Dichte gehört zurück ins
  Toolbar-Panel" — wird **verworfen**: das ist eine bereits getroffene und begründete Entscheidung
  (`docs/ui-audit.md:166-168` „Dichte ersatzlos streichen", umgesetzt und im Code festgehalten in
  `MessageList.tsx:961-964`). Sie hier erneut aufzumachen hiesse, eine Auditentscheidung
  zurückzudrehen; die HIG verlangt den Ort im Kontext, nicht diese eine Option.
- **Soll:** Die Anordnung der Leseansicht zusätzlich in das bestehende Ansichtsoptionen-Panel
  aufnehmen (derselbe Store, `setReadingPaneMode`). In den Einstellungen darf sie stehen bleiben.
- **Beleg:** `SettingsPage.tsx:331-342`; `layout.ts:91-131`; `MessageList.tsx:939-1000`
  (Toolbar-Inhalt).
- **Aufwand:** M

---

### T-09 — Ladeindikator steht bei aktivem „Bewegung reduzieren" still
*(vormals T2-05, korrigiert)*

- **Stand (2026-08-24):** Behoben — siehe D-09.
- **Schwere:** niedrig
- **Einordnung:** anpassen
- **HIG-Regel:** „Keep progress indicators moving so people know something is continuing to happen.
  People tend to associate a stationary indicator with a stalled process or a frozen app."
  — `progress-indicators`, Best practices.
- **Ist:** `Spinner` ist der Ladeindikator der ganzen App (Suspense-Fallback jeder Lazy-Route,
  Ladezustand jedes Knopfes). Sein Ring dreht sich per CSS-Animation
  (`apps/web/src/ui/Spinner.module.css:7-14`, `animation: spin var(--waxwing-duration-spin) linear
  infinite`), und der globale Reduced-Motion-Reset stoppt sie ausnahmslos:
  `apps/web/src/ui/global.css:130-143` setzt für `*, *::before, *::after`
  `animation-duration: 0.01ms !important` **und** `animation-iteration-count: 1 !important`. Unter
  „Bewegung reduzieren" — auf iPadOS eine häufig gesetzte Systemeinstellung — bleibt ein statischer
  Ring stehen. `Spinner.tsx:19` hält das als gewolltes Verhalten fest, begründet aber nicht, warum
  ein stehender Indikator besser sein soll als ein reduzierter.
- **Korrektur gegenüber dem Rohbefund:** Der Verweis auf `shell.module.css:139-143` als „dasselbe
  Muster, ausdrücklich so gebaut" trägt nicht als Beleg für Absicht — dort wird eine
  Statusanzeige *zusätzlich* stillgestellt, was denselben Einwand hat. Ausserdem ist der Punkt
  nicht tablet-spezifisch; er gilt in jedem Viewport und sollte dort einmal entschieden werden.
- **Soll:** Den Spinner aus dem pauschalen Reset ausnehmen und unter `reduce` eine ruhige,
  nicht-vestibuläre Bewegung behalten (z. B. Deckkraft-Pulsation mit ~2 s Periode) oder auf eine
  sichtbar veränderliche, nicht-animierte Form umschalten. Wo die Dauer schätzbar ist
  (Anhang-Upload, Import, Erst-Sync), gehört ohnehin ein determinierter Balken hin
  („When possible, use a determinate progress indicator"). Die `waxwing-motion-exempt`-Mechanik in
  `ui/reduced-motion.css.test.ts:50-56` ist der vorgesehene Ort, die Ausnahme mit Begründung
  einzutragen.
- **Beleg:** `Spinner.module.css:7-14`; `global.css:130-143`; `Spinner.tsx:19`;
  `reduced-motion.css.test.ts:50-56`.
- **Aufwand:** S

---

## Verworfen

- **T-05 · „Schriftskala folgt nicht der Eingabeart"** — Die zitierte Zahl (iOS/iPadOS Standard
  17 pt) steht in `accessibility` bzw. `typography` als **Standard- und Mindestgrösse für
  Textstile** (Minimum 11 pt), nicht als Vorgabe für Listenzeilen; Apples eigene Mail-App verwendet
  in der Nachrichtenliste kleinere Stile als Body. Waxwing liegt mit 14 px (Absender/Betreff) und
  12 px (Vorschau/Zeit) deutlich über dem Minimum, die Skala ist in `rem` gebaut und folgt damit der
  Browser-Schriftgrösse (`tokens.css:140-145`), und der zitierte Satz aus `designing-for-ipados`
  („Use viewing distance and input mode to help you determine the size and density") ist eine
  Gestaltungsleitlinie ohne Zahl. Der Vorschlag — eine zweite, an `pointer: coarse` gekoppelte
  Typoskala samt Änderung von `ROW_HEIGHT` — wäre zudem ein tiefer Eingriff in ein dokumentiert
  vermessenes Zeilenmodell (`message-list.module.css:539-552`, 76 px, `leading-snug`) und träfe
  Android-Telefone und Touch-Notebooks mit.
- **T-07 · „Jede geöffnete Nachricht schiebt einen Historieneintrag"** — Die HIG-Belege tragen
  nicht: „Swipe between pages" steht in `pointing-devices` in der Tabelle der **Maus-/Trackpad-Gesten**
  und beschreibt „navigate forward or backward between individually displayed pages" — genau das
  tut Waxwing. `gestures` verlangt, Standardgesten nicht umzudeuten; die Zurück-Geste behält hier
  ihre Standardbedeutung (ein Schritt im Verlauf). Eine HIG-Regel zur *Tiefe* des Verlaufs gibt es
  nicht. Der Push ist ausserdem bewusst gestaltet und markiert (`MessageList.tsx:441-449` mit
  `READING_HISTORY_MARK`, `MailScreen.tsx:200-227` beschreibt ausführlich den Fehler, den das
  Poppen behebt); ein Wechsel auf `replace` im Split-Layout würde die Browser-Erwartung „Zurück
  führt zur zuletzt gelesenen Nachricht" auf Desktop-Browsern brechen.
- **T-08 und T2-04 · „Trennergriff ist nur 24 px" (Doppelung, beide verworfen)** — Bereits
  entschieden und begründet: `docs/design-system.md:159-161` führt genau diese eine dokumentierte
  Ausnahme („the SplitPane resize separator uses a 24 px hit band (meeting SC 2.5.8) rather than the
  control minimum — a wide divider is dead space between panes"), gespiegelt im Code
  (`SplitPane.module.css:39-45`). Die Berufung auf Apples „Minimum 28×28 pt" (`accessibility`,
  Mobility) trägt nicht: die Zahl beschreibt kompakte **Bedienelemente**; die Trefferfläche hier ist
  24 px breit und panelhoch (mehrere hundert px), ihre Fläche übertrifft 28×28 pt um Grössenordnungen.
  Der Splitter ist zudem keine notwendige Aktion — beide Panes sind ohne Verstellen benutzbar.
- **T2-07 · „Kein Kontextmenü in der App"** — `context-menus` verlangt Konsistenz („Support context
  menus consistently throughout your app") und dass jeder Eintrag auch in der Hauptoberfläche
  vorhanden ist; beides ist erfüllt, weil Waxwing gar keine Kontextmenüs führt und jede
  Zeilenaktion über Wischgesten, Auswahl + Massenaktionsleiste und die Leseansicht erreichbar ist.
  Eine Pflicht zum Kontextmenü formuliert die Seite nicht („hidden by default, so people might not
  know it's there"). Die Kollision von Tippen-und-Halten mit dem HTML5-Drag ist bereits entschieden
  und begründet (ADR-012, Korrektur vom 2026-07-19; `MessageList.tsx:771-780`). Was bleibt — ein
  Sekundärklick per Trackpad, der auf einer Nachrichtenzeile nichts tut, während Ordnerzeilen ein
  „⋯"-Menü haben (`FolderTreeView.tsx:305-317`) — ist eine Verbesserungsidee, kein HIG-Verstoss.
- **Teilverwerfungen innerhalb bestätigter Befunde** (Begründung jeweils oben im Abschnitt):
  Dichte zurück ins Toolbar-Panel (aus T2-06; `docs/ui-audit.md:166-168`, `MessageList.tsx:961-964`);
  `enterKeyHint` im Suchfeld (aus T2-02; `SearchBox.tsx:103-105` nutzt `type="search"`);
  „Drehen macht die Leseansicht schmaler" und „352 px unterschreiten die Container-Query" (aus T-01;
  `SplitPane.tsx:44`, `reading.module.css:344-353`); Pflicht zu einem Tastenkürzel für die
  Ordnerleiste (aus T-04; NAV-53/54 sind macOS); „`padding`-Kurzform löscht das Safe-Area-Polster"
  (aus T-02; die Schiene steht ab 40em seitlich).
