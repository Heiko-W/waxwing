# HIG-Gegenprüfung — Viewport Desktop (macOS)

**Umgebung:** 1440×900 und breiter, Safari/Chrome auf einem Mac, `pointer: fine`, `hover: hover`.
Waxwing-Breakpoints: `>= 64em` (1024 px) dreispaltig — Navigationsschiene + Ordnerspalte (16 rem,
fix) + Liste + Leser; `>= 40em` (640 px) zweispaltig.

**Wie geprüft wurde:** Jeder Rohbefund wurde an vier Fragen gemessen — (1) stimmt der Ist-Zustand an
der genannten Datei:Zeile und greift die Regel im Desktop-Viewport, (2) steht die zitierte Regel
wirklich auf der genannten HIG-Seite und gilt sie für macOS (nachgelesen über `/tmp/hig.sh <slug>`:
`buttons`, `toolbars`, `sidebars`, `split-views`, `menus`, `context-menus`, `pointing-devices`,
`modality`, `alerts`, `progress-indicators`, `undo-and-redo`, `feedback`, `focus-and-selection`,
`color`, `accessibility`, `dark-mode`, `windows`, `designing-for-macos`), (3) ist die Abweichung in
`docs/` oder im Quellkommentar bereits begründet, (4) ist der Vorschlag für eine plattformneutrale
Web-App tragfähig.

**Zählung:** 25 Rohbefunde → **17 Befunde** (10 bestätigt, 7 korrigiert), **8 verworfen**
(5 davon als Doppelbefund in einen anderen eingerechnet, 3 inhaltlich).

Schwereverteilung der verbleibenden Befunde: 1 hoch · 11 mittel · 5 niedrig.

---

### D-01 — Sekundärklick öffnet nirgends ein Kontextmenü

- **Schwere:** hoch
- **Einordnung:** uebernehmen
- **HIG-Regel:** `pointing-devices`, macOS-Tabelle: „Secondary click | Reveal contextual menus. |
  ● | ●". Dazu `context-menus`: „Support context menus consistently throughout your app. If you
  provide context menus for items in some places but not in others, people won't know where they
  can use the feature and may think there's a problem." und, als wörtliches Beispiel, „the context
  menu for a Mail message in the Inbox includes commands for replying and moving the message".
  Ergänzend `context-menus`: „Hide unavailable menu items, don't dim them." sowie „Always make
  context menu items available in the main interface, too."
- **Ist:** `grep -rn "onContextMenu" apps/web/src` → 0 Treffer (auch in Tests). Rechtsklick auf
  Nachrichtenzeile, Ordnerzeile, Kontakt, Datei oder Anhang liefert nur das Browsermenü. Die
  Nachrichtenzeile hat auf dem Desktop überhaupt kein eigenes Menü: `MessageRow.tsx:160-172` ist ein
  `role="row"` mit `onClick`/`onDoubleClick`, `message-list.module.css` kennt unter
  `@media (hover: hover)` nur eine Hintergrundfarbe für `.row:hover`; das ⋯-Menü der Liste hängt an
  der Massenleiste (`MessageList.tsx:1448-1456`), also erst nach dem Setzen eines Häkchens. Die
  Ordnerzeile hat ein Zeilenmenü, aber nur bei Hover eingeblendet
  (`folder-tree.module.css:211-237`). Die Menüdaten liegen bereits als reine Listen vor:
  `FolderTreeView.tsx:359-470` (`folderMenuItems`, bis zu zehn Einträge),
  `MessageView.tsx:876` (`menuItems`).
- **Soll:** `onContextMenu` auf Nachrichtenzeile, Ordnerzeile, Kontakt- und Dateizeile und Anhang,
  gespeist aus den vorhandenen Aktionslisten; zusätzlich Shift+F10 / Kontextmenü-Taste. Nicht
  anwendbare Einträge ausblenden statt dimmen. Das Browsermenü nicht ersatzlos unterdrücken:
  „Link kopieren" und „In neuem Tab öffnen" gehören in das eigene Menü (das ist zugleich die
  `windows`-Regel „Consider letting people view content in a new window using a command in a
  context menu"), und Umschalt-Rechtsklick sollte durchgereicht werden.
- **Beleg:** `apps/web/src/mail/MessageRow.tsx:160-172`;
  `apps/web/src/mail/message-list.module.css:363-366`;
  `apps/web/src/mail/folder-tree.module.css:211-237`;
  `apps/web/src/mail/FolderTreeView.tsx:359-470`; `apps/web/src/mail/MessageView.tsx:876`.
- **Aufwand:** M
- *(Zusammengefasst aus D1-02 und D2-02 — dieselbe Ursache. Die Behauptung aus D1-02, die
  Nachrichtenliste habe „gar kein" Menü, ist auf die Zeilenebene zu präzisieren: ein Überlaufmenü
  existiert, aber nur in der Massenleiste.)*

---

### D-02 — Nur-Symbol-Bedienelemente haben auf dem Mac keinen Tooltip; die Tooltip-Komponente ist ungenutzt

- **Schwere:** mittel *(korrigiert von „hoch" — jedes Element trägt ein `aria-label`, es fehlt der
  sichtbare Hinweis, nicht der zugängliche Name)*
- **Einordnung:** uebernehmen
- **HIG-Regel:** `buttons`: „In macOS and visionOS, the system displays a tooltip after people hover
  over a button for a moment. A tooltip displays a brief phrase that explains what a button does."
  und „In general, buttons that contain text don't need to display a tooltip because the button's
  descriptive label communicates what it does." (im Umkehrschluss: Nur-Symbol-Knöpfe brauchen ihn).
  `toolbars`: „Make sure the meaning of each control is clear. Don't make people guess or experiment
  to figure out what a toolbar item does."
- **Ist:** `IconButton.tsx:25-38` setzt ausschliesslich `aria-label`, kein `title`; der eigene
  Kommentar verweist auf „Wrap in a Tooltip when a visible hint is wanted". Die Tooltip-Komponente
  existiert vollständig (`ui/Tooltip.tsx`, mit Hover+Fokus und 1.4.13-Karenz) und wird im
  Produktivcode **nirgends** benutzt — der einzige Aufrufer ist die Dev-Galerie
  (`ui/gallery/Gallery.tsx:135`). Betroffen sind **62** `<IconButton>`-Stellen (nicht 163, wie D1-06
  behauptet — nachgezählt ohne Tests), darunter die Leseleiste (`MessageView.tsx:1046-1065`), die
  Kopfzeile (`Header.tsx:68-74`), die Ansichtsoptionen (`MailScreen.tsx:281-291`) und das
  Ordner-Zeilenmenü. Einzige Ausnahme in der App: die Navigationsschiene, die `title` korrekt setzt
  (`PrimaryNav.tsx:57`).
- **Soll:** Den Hinweis in die Primitive ziehen — `IconButton` gibt `label` zusätzlich als `title`
  aus bzw. umschliesst sich unter `@media (hover: hover)` selbst mit `Tooltip`, sodass alle 62
  Stellen ihn erben. Der Tooltip bleibt Zusatz, nie der zugängliche Name. Wo ein Tastenkürzel
  existiert, gehört es in denselben Text (die Kopfzeile macht das im Label bereits vor:
  `t('palette.open', { keys: paletteKeys })`).
- **Beleg:** `apps/web/src/ui/IconButton.tsx:25-38`; `grep -rn "<IconButton" apps/web/src
  --include=*.tsx | grep -v test` → 62; `grep -rn "<Tooltip" apps/web/src --include=*.tsx | grep -v
  test` → 1 (`ui/gallery/Gallery.tsx:135`); `apps/web/src/app/shell/PrimaryNav.tsx:57`.
- **Aufwand:** S
- *(Zusammengefasst aus D1-06 und D2-01. `docs/ui-review-2026-08-20.md` Z13 behandelt Tooltips für
  abgeschnittenen Text — ein anderer Fall, keine Vorentscheidung zu Nur-Symbol-Knöpfen.)*

---

### D-03 — Formulardialoge verwerfen Eingaben bei Escape oder Klick daneben ohne Rückfrage

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `modality`: „When necessary, help people avoid data loss by getting confirmation
  before closing a modal view. Regardless of whether people use a dismiss gesture or a button, if
  closing the view could result in the loss of user-generated content, be sure to explain the
  situation and give people ways to resolve it." Dazu `alerts`: „Use an action sheet — not an alert
  — to offer choices related to an intentional action. For example, when people cancel the Mail
  message they're editing, an action sheet provides three choices: delete the edits …, save the
  draft, or return to editing."
- **Ist:** `ui/Dialog.tsx:42` `dismissOnBackdrop = true` und `:52`
  `useDismiss(open, panelRef, onClose, { escape: true, … })` sind die Vorgabe; genau zwei Aufrufer
  weichen ab (`ReauthDialog.tsx:36`, `AppPasswordDialog.tsx:123`). Kein Dirty-Tracking irgendwo
  (`grep -rn "dirty\|unsaved\|confirmClose"` im Dialog-Umfeld → 0). `EventDialog.tsx:269` reicht
  `props.onCancel` an `onClose` durch, `CalendarPage.tsx:1160` setzt darauf `() => setEditing(null)`
  — ein Klick neben den Dialog verwirft einen halb ausgefüllten Termin samt Teilnehmern und
  Wiederholungsregel. Dasselbe Muster in `settings/sieve/RuleForm.tsx` (706 Zeilen Regel-Editor),
  `ContactForm`, `GroupForm`, `LabelFormDialog`. Auf dem Desktop ist genau das der wahrscheinliche
  Fehlgriff: Escape und der Klick daneben sind hier Alltag.
- **Soll:** `Dialog` bekommt einen optionalen `confirmClose`-Haken (oder der Aufrufer setzt
  `dismissOnBackdrop={false}` plus Dirty-Prüfung auf Escape). Bei geänderten Feldern eine Abfrage
  mit drei Auswahlmöglichkeiten (weiter bearbeiten / verwerfen / sichern). Die Form existiert im
  Composer bereits (`ComposerWindow.tsx:604-629`) — dort ist der Verlust ausserdem durch den
  Draft-Autosave abgefedert, in den Formulardialogen nicht.
- **Beleg:** `apps/web/src/ui/Dialog.tsx:42,52,64-66`; `apps/web/src/calendar/EventDialog.tsx:269`;
  `apps/web/src/calendar/CalendarPage.tsx:1160`; `apps/web/src/compose/ComposerWindow.tsx:604-629`.
- **Aufwand:** M

---

### D-04 — Der bestätigende Knopf ist in mehreren Dialogen nicht als Vorzugswahl erkennbar

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `buttons`: „Assign the primary role to the button people are most likely to choose.
  When a primary button responds to the Return key, it makes it easy for people to quickly confirm
  their choice." und „Use style — not size — to visually distinguish the preferred choice among
  multiple options. … use a more prominent button style for that option and a less prominent style
  for the remaining ones."
- **Ist:** `ui/Button.tsx:40` setzt `variant = 'secondary'` als Vorgabe. Im Termin-Editor sind damit
  „Abbrechen" (`EventDialog.tsx:477`, explizit `secondary`) und „Sichern" (`EventDialog.tsx:480`,
  ohne `variant`, also ebenfalls `secondary`) optisch identisch — beide weisse Fläche mit
  `--waxwing-border-strong` (`Button.module.css:112-116`). Gleiches Muster in
  `settings/sieve/RuleForm.tsx:252-255`, `calendar/CalendarDialog.tsx:165-169`,
  `settings/TemplatesSection.tsx`, `settings/AppPasswordDialog.tsx`. 27 andere Stellen der App
  setzen `variant="primary"` für die Bestätigung — die Uneinheitlichkeit ist hausgemacht.
- **Soll:** Jeder bestätigende bzw. absendende Knopf bekommt `variant="primary"`.
- **Beleg:** `apps/web/src/ui/Button.tsx:40`; `apps/web/src/calendar/EventDialog.tsx:476-481`;
  `apps/web/src/ui/Button.module.css:100-116`; `grep -rn 'variant="primary"' apps/web/src
  --include=*.tsx | grep -v test` → 27.
- **Aufwand:** S
- *(Korrigiert gegenüber D2-04: Die zweite Hälfte — „der destruktive Knopf muss die Bestätigungszeile
  verlassen" — fällt weg. Erstens ist sie an Ort und Stelle begründet: `EventDialog.tsx:459-465`
  erklärt, dass „Löschen" bewusst ans andere Ende der Zeile gerückt wurde, weg von „Abbrechen" (T13).
  Zweitens verlangt die HIG nur, dem destruktiven Knopf nicht die **primary**-Rolle zu geben — er
  trägt hier `variant="destructive"`, also genau die von der HIG vorgesehene eigene Rolle
  („a destructive button uses the system red color"). Dass er auffällt, ist die Absicht der Regel,
  nicht ihr Bruch.)*

---

### D-05 — Die Ordnerspalte lässt sich auf Desktop-Breite weder ausblenden noch sonst verstellen

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `sidebars`: „Consider letting people hide the sidebar. People sometimes want to hide
  the sidebar to create more room for content details or to reduce distraction. … in macOS, you can
  include a show/hide button or add Show Sidebar and Hide Sidebar commands to your app's View menu."
  `split-views` (macOS): „Consider letting people hide a pane when it makes sense." und „Provide
  multiple ways to reveal hidden panes. For example, you might provide a toolbar button or a menu
  command — including a keyboard shortcut." `toolbars`: „Elements that let people return to the
  previous document and show or hide a sidebar appear at the far leading edge."
- **Ist:** `MailScreen.tsx:160` `const drawerCapable = tier !== 'desktop' && !fullScreen`; der
  Umschaltknopf steht unter `{drawerCapable && …}` (`MailScreen.tsx:272-283`) und wird auf dem
  Desktop deshalb nie gerendert. `shell.module.css:592-602` macht die Region ab 64em unbedingt
  sichtbar und 16 rem breit. Ersatzwege fehlen: `shortcuts/registry.ts` enthält genau 22 Aktionen
  (nachgezählt), keine betrifft die Seitenleiste; die Befehlspalette speist sich aus denselben
  Aktionen plus Ordner- und Label-Sprüngen. Weil eine Web-App keine Menüleiste als Rückfallebene
  hat, ist der fehlende Knopf zugleich der fehlende zweite Weg.
- **Soll:** Umschalter auch auf Desktop rendern, an der führenden Kante der Pane-Toolbar (dort, wo
  er auf Tablet schon sitzt), plus eine Aktion in `shortcuts/registry.ts` mit Tastenkürzel — das
  sind die von `split-views` verlangten zwei Wege. Beschriftung und `aria-expanded` dem Zustand
  folgen lassen (`shell.folders.show` / `.hide`). Zustand zusammen mit D-06 persistieren.
- **Beleg:** `apps/web/src/app/shell/MailScreen.tsx:160,272-283`;
  `apps/web/src/app/shell/shell.module.css:592-602`; `apps/web/src/shortcuts/registry.ts` (22 Aktionen,
  keine Seitenleistenaktion).
- **Aufwand:** S–M
- *(Zusammengefasst aus D1-01 und D2-07, mit zwei Streichungen: (a) Der von D2-07 als „Nebenbefund"
  genannte konstante Titel `t('shell.folders.show')` bei umschaltendem `aria-expanded` ist im
  Desktop-Viewport gegenstandslos — der Knopf existiert dort gar nicht; er gehört in die
  Telefon-/Tablet-Prüfung und ist hier nur als Folgeauftrag genannt. (b) D1-01s Forderung nach einem
  ziehbaren Trenner zwischen Schiene und Ordnerspalte hat keine HIG-Deckung: `split-views` sagt nur
  „A split view includes dividers … that can support dragging" — beschreibend — und „Set reasonable
  defaults for minimum and maximum pane sizes" ausdrücklich nur „If people can resize the panes".)*

---

### D-06 — Die Spaltenbreite des Split-Views überlebt kein Neuladen und folgt keinem Tier-Wechsel

- **Schwere:** mittel
- **Einordnung:** anpassen
- **HIG-Regel:** `designing-for-macos`: „Let people resize, hide, show, and move your windows to fit
  their work style and device configuration" und „Support personalization, letting people customize
  toolbars, configure windows to display the views they use most". `windows`: „The system remembers
  window size and placement even when an app is closed." — im Web ist die Entsprechung die innere
  Spaltenbreite, weil es keine Fensterverwaltung gibt, die das für die App erledigt.
- **Ist:** `ui/SplitPane.tsx:44` hält die Breite in reinem Komponentenzustand:
  `const [size, setSize] = useState(() => clamp(defaultPrimarySize, minPrimarySize, maxPrimarySize))`;
  im ganzen Modul steht kein `localStorage` und kein `setPref`. Jeder Neuladevorgang und jeder
  Chunk-Fehler setzt die Liste auf 420 px zurück (`MailScreen.tsx:365`), dasselbe in
  `ContactsScreen.tsx`. Waxwing persistiert sonst konsequent über `useLocalPref` (Sortierung,
  Dichte, unreadFirst, eingeklappte Ordner, angeheftete Ordner, gespeicherte Suchen) — die
  Spaltenbreite ist die Ausnahme. Zweiter, desktop-typischer Teil: `defaultPrimarySize` wechselt
  zwischen 340 (Tablet) und 420 (Desktop), der `useState`-Initialisierer läuft aber nur beim ersten
  Mount und die Komponente bleibt über den Breakpoint hinweg montiert (`layout.split` ist auf beiden
  Tiers wahr) — ein von Tablet- auf Desktopbreite gezogenes Fenster bleibt bei 340 px.
- **Soll:** Die Breite als lokale Präferenz führen (dieselbe `useLocalPref`-Mechanik wie
  `list.sort`/`list.density`), getrennt je Bildschirm (mail, contacts) und je Tier; beim
  Tier-Wechsel auf den Standard des neuen Tiers wechseln, solange der Nutzer den Wert dort nicht
  angefasst hat. Min/Max bleiben, wie sie sind.
- **Beleg:** `apps/web/src/ui/SplitPane.tsx:44` (und das ganze Modul ohne Persistenz);
  `apps/web/src/app/shell/MailScreen.tsx:365`; Gegenbeispiel `apps/web/src/mail/MessageList.tsx`
  (`useLocalPref<MessageSort>('list.sort')` u. a.).
- **Aufwand:** S
- *(Zusammengefasst aus D1-04 und D2-08.)*

---

### D-07 — Kein `color-scheme` gesetzt: Scrollbalken, Auswahllisten und Datumsfelder bleiben im Dunkelmodus hell

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `dark-mode`: „Ensure that your app looks good in both appearance modes. In addition
  to using one mode or the other, people can choose the Auto appearance setting, which switches
  between the light and dark appearances as conditions change throughout the day, potentially while
  your app is running." `accessibility`: „Prefer system-defined colors. These colors have their own
  accessible variants that automatically adapt when people adjust their color preferences."
- **Ist:** Weder `ui/global.css` noch `ui/tokens.css` noch `apps/web/index.html` deklarieren
  `color-scheme`. Der einzige Treffer im ganzen Baum ist `mail/reading.module.css:384`, wo der
  Mail-iframe bewusst auf `light` festgenagelt wird (dort ausführlich begründet, also kein Befund).
  Ohne `color-scheme` zeichnet der Browser alle vom User-Agent gerenderten Teile hell, auch wenn
  Waxwings Token dunkel sind: die Scrollbalken der Ordnerspalte (`.folderScroll`, `scrollbar-gutter:
  stable`) und der Liste, die aufgeklappte Liste jedes `<select>` (Ansichtsoptionen, Suchbereich,
  Einstellungen — `ui/Select.module.css` stylt nur den geschlossenen Zustand) und die nativen
  Datums-/Zeitfelder (ScheduleSendDialog, VacationSection, EventDialog, ContactForm). Eigene
  Scrollbalkenfarben gibt es nicht (kein `scrollbar-color`, kein `::-webkit-scrollbar`). Auf dem Mac
  ist genau das sichtbar, weil dort mit Zeigegerät gearbeitet wird und `<select>`-Listen und
  Datumsfelder Alltag sind.
- **Soll:** `color-scheme: light dark` auf `:root` in `global.css`/`tokens.css`, dazu je erzwungenem
  Theme ein Override (`:root[data-theme="light"]` / `[data-theme="dark"]`), sonst greift die
  Umschaltung im manuellen Modus nicht. Zusätzlich `<meta name="color-scheme" content="light dark">`
  in `index.html`, damit schon der erste Frame stimmt.
- **Beleg:** `grep -rn "color-scheme" apps/web/src apps/web/index.html` → nur
  `apps/web/src/mail/reading.module.css:376,384`; `apps/web/index.html:15-22` (viewport +
  zwei `theme-color`, kein `color-scheme`); `apps/web/src/ui/Select.module.css:6-19`.
- **Aufwand:** S
- **Nur am Gerät endgültig entscheidbar** (welche UA-Teile im Dunkelmodus tatsächlich hell
  aufschlagen, hängt von macOS-Scrollbalkeneinstellung und Browser ab).

---

### D-08 — Keine Farbvariante für die Systemeinstellung „Kontrast erhöhen"

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `color`: „If you define a custom color, make sure to supply light and dark variants,
  and an increased contrast option for each variant that provides a significantly higher amount of
  visual differentiation." `accessibility`: „If your app doesn't provide this minimum contrast by
  default, ensure it at least provides a higher contrast color scheme when the system setting
  Increase Contrast is turned on."
- **Ist:** `ui/tokens.css` definiert je Rolle genau zwei Varianten (hell auf `:root`, dunkel unter
  `@media (prefers-color-scheme: dark)` bzw. `[data-theme]`) — die dritte und vierte fehlen. In
  ganz `apps/web/src` gibt es keine einzige `@media (prefers-contrast: …)`- und keine
  `forced-colors`-Regel. Betroffen sind genau die Rollen im Grenzbereich: `--waxwing-border`
  (laut eigenem Kommentar bewusst < 3:1), `--waxwing-text-muted`, `--waxwing-surface-hover` und
  `--waxwing-surface-selected-idle`; dazu `Button.module.css:70-80`, wo deaktivierte und
  „unavailable" Elemente bei `opacity: 0.5` bleiben. `docs/accessibility.md:38-98` listet sechs
  bekannte Lücken auf — erhöhter Kontrast ist keine davon, die Abweichung ist also nicht
  entschieden, sondern übersehen.
- **Soll:** Ein `@media (prefers-contrast: more)`-Block je Theme in `tokens.css`: `--waxwing-border`
  auf mindestens 3:1 (naheliegend: auf den Wert von `--waxwing-border-strong`), `text-muted`
  Richtung 7:1, Zeilenzustände mit grösserem Abstand zu `surface`, Fokusring dicker, deaktivierte
  Elemente über Rahmen/Text statt über Opazität kennzeichnen. `tokens.contrast.test.ts` kann die
  neuen Blöcke mit derselben Matrix und höheren Schwellen prüfen; bis dahin gehört die Lücke in
  `docs/accessibility.md`.
- **Beleg:** `grep -rn "prefers-contrast\|forced-colors" apps/web/src` → 0 Treffer;
  `apps/web/src/ui/tokens.css:26-27,75-76,258`; `apps/web/src/ui/Button.module.css:70-80`;
  `docs/accessibility.md:38-98`.
- **Aufwand:** M
- **Nur am Gerät endgültig entscheidbar** (Wirkung nur mit aktivem „Kontrast erhöhen" in den
  macOS-Bedienungshilfen zu beurteilen).
- *(Zusammengefasst aus D1-08 und D2-15.)*

---

### D-09 — Der Spinner friert bei „Bewegung reduzieren" ein

- **Schwere:** mittel
- **Einordnung:** anpassen
- **HIG-Regel:** `progress-indicators`: „Keep progress indicators moving so people know something is
  continuing to happen. People tend to associate a stationary indicator with a stalled process or a
  frozen app." Gegenstück `accessibility`/WCAG 2.3.3 verlangt Reduktion, nicht Abschaltung.
- **Ist:** `ui/global.css:130-143` setzt für `*, *::before, *::after` unter
  `prefers-reduced-motion: reduce` `animation-duration: 0.01ms !important` und
  `animation-iteration-count: 1 !important`. `ui/Spinner.module.css:13` ist
  `animation: spin var(--waxwing-duration-spin) linear infinite` — unter `reduce` läuft eine
  Umdrehung in 0,01 ms und der Ring steht danach still. Der Sync-Indikator der Kopfzeile schaltet
  die Drehung sogar ausdrücklich ab (`shell.module.css:139-143` `animation: none`), ohne Ersatz.
  Für Sehende bleibt als Ladehinweis ein statischer Kreis; nur der `VisuallyHidden`-Text in
  `Spinner.tsx` bleibt wirksam.
- **Soll:** Unter `prefers-reduced-motion: reduce` die Bewegung nicht entfernen, sondern ersetzen:
  eine deutlich langsamere, gleichmässige Rotation (z. B. 3 s) oder ein erkennbar aktiver Zustand
  mit sichtbarem Text. Der Skeleton-Schimmer darf still stehen, er ist dekorativ.
- **Beleg:** `apps/web/src/ui/global.css:130-143`; `apps/web/src/ui/Spinner.module.css:13`;
  `apps/web/src/app/shell/shell.module.css:139-143`.
- **Aufwand:** S
- **Nur am Gerät endgültig entscheidbar** (mit aktivem „Bewegung reduzieren" in den
  macOS-Bedienungshilfen).
- *(Hinweis für die Umsetzung: Der universelle Reset ist eine bewusste Entscheidung und durch
  `apps/web/src/ui/reduced-motion.css.test.ts` festgeschrieben — „one universal CSS reset … That is
  the right design". Die Ausnahme muss also als gezielter Override **nach** dem Reset entstehen,
  ohne dessen `!important`-Zusicherung anzutasten, sonst bricht der statische Test.)*

---

### D-10 — Rückgängig hat kein Cmd-Z

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `undo-and-redo`, macOS: „Place undo and redo commands in the Edit menu and support
  the standard keyboard shortcuts. Mac users expect to find undo and redo at the top of the Edit
  menu; they also expect to use Command–Z and Shift–Command–Z to perform undo and redo,
  respectively."
- **Ist:** `shortcuts/registry.ts:384-386` bindet ausschliesslich `keys: ['z']`. In der
  Kürzelübersicht steht deshalb nur ein blankes Z. `docs/adr/021-undo-is-a-chord-and-a-toast-that-waits.md`
  begründet die Wahl von `z` und den nicht ablaufenden Toast, erwähnt Cmd-Z an keiner Stelle
  (`grep -i "cmd\|command-z\|⌘"` → 0 Treffer) — die Abweichung ist unbegründet, nicht entschieden.
- **Soll:** `keys: ['z', 'Mod+z']`. Wichtig: der Dispatcher lässt Mod-Chords bewusst auch beim Tippen
  durch (`ShortcutProvider.tsx:86-107` filtert im Tippfall auf `parseChord(chord).mod`), deshalb muss
  `Mod+z` zusätzlich über `isTextEntryTarget(target)` ausgeschlossen werden, damit das Rückgängig des
  Browsers in Eingabefeldern unangetastet bleibt. `formatChord` zeigt danach von selbst ⌘ auf
  Apple-Geräten und Strg sonst — der Vorschlag bricht also auf Windows/Linux nichts.
- **Beleg:** `apps/web/src/shortcuts/registry.ts:384-386`;
  `apps/web/src/shortcuts/ShortcutProvider.tsx:86-107`;
  `docs/adr/021-undo-is-a-chord-and-a-toast-that-waits.md`.
- **Aufwand:** S

---

### D-11 — Menüs kennen keine Gruppen und keine Trenner; das längste Menü ist ein Block aus zehn Einträgen

- **Schwere:** mittel
- **Einordnung:** uebernehmen
- **HIG-Regel:** `menus`: „Consider grouping logically related items. … To help people visually
  distinguish such groups, use a separator." und „Prefer keeping all logically related commands in
  the same group". `context-menus`: „In general, you don't want more than about three groups in a
  context menu."
- **Ist:** `ui/Menu.tsx:16-23` kennt in `MenuItemSpec` nur `id`, `label`, `icon`, `onSelect`,
  `disabled`, `destructive` — kein Gruppen- und kein Trennerfeld; in `Menu.tsx`/`Menu.module.css`
  gibt es kein `separator`/`divider` (`grep` → 0). `mail/FolderTreeView.tsx:359-470` schiebt daraus
  bis zu zehn Einträge in eine flache Liste: Neuer Unterordner, Umbenennen, Verschieben nach,
  Offline behalten, EML importieren, Freigeben, Papierkorb/Spam leeren, Älter als … löschen,
  Ordnerinformationen, Löschen — Anlegen, Ablegen, Offline, Freigabe und zwei destruktive Befehle
  ohne jede Trennung untereinander. Die Leseleiste hat die Gruppen bereits als Daten
  (`MessageView.tsx`: `group`, gezeichnet über `data-group-start` in der Toolbar,
  `MessageView.tsx:1046-1052`) und verliert sie genau beim Übergang ins Überlaufmenü.
- **Soll:** `MenuItemSpec` um `group?: string` erweitern, `Menu` zwischen zwei Gruppen eine
  Trennlinie zeichnen lassen, die vorhandenen `group`-Werte aus `MessageView` durchreichen und die
  destruktiven Einträge in die letzte Gruppe legen.
- **Beleg:** `apps/web/src/ui/Menu.tsx:16-23`; `apps/web/src/mail/FolderTreeView.tsx:359-470`;
  `apps/web/src/mail/MessageView.tsx:1046-1052`.
- **Aufwand:** S

---

### D-12 — Kein determinierter Fortschritt, obwohl die Gesamtmenge bekannt ist

- **Schwere:** mittel
- **Einordnung:** anpassen *(korrigiert von „uebernehmen")*
- **HIG-Regel:** `progress-indicators`: „When possible, use a determinate progress indicator. …
  A determinate progress indicator can help people decide whether to do something else while waiting
  for the task to complete, restart the task at a different time, or abandon the task." und „When
  it's feasible, let people halt processing. If people can interrupt a process without causing
  negative side effects, include a Cancel button."
- **Ist:** `role="progressbar"` kommt in der App zweimal vor, beide Male als Füllstand und nicht als
  Fortschritt (`quota/QuotaBar.tsx:64`, `settings/StorageSection.tsx:116`, beide natives
  `<progress>`). Der vCard-Import läuft als sequentielle Schleife über eine bekannte Kartenmenge
  (`contacts/ContactImportExportDialog.tsx:166-182`: `for (const card of cards) await createCard(…)`)
  und meldet erst hinterher eine Ergebniszahl (`:328-330`); ein Abbrechen gibt es nicht. Der
  ICS-Import meldet ebenfalls erst das Ergebnis (`calendar/IcsImportDialog.tsx:80-95`).
- **Soll:** Für die Datensatz-Importe ein natives `<progress>` mit `n von m` an fester Stelle, dazu
  ein Abbrechen, das die Schleife nach der laufenden Karte verlässt (die bereits angelegten bleiben
  — das ist der von der HIG gemeinte „negative side effect", der benannt werden muss).
- **Beleg:** `grep -rn "progressbar\|<progress" apps/web/src --include=*.tsx | grep -v test` → nur
  `quota/QuotaBar.tsx:64-66` und `settings/StorageSection.tsx:116-118`;
  `apps/web/src/contacts/ContactImportExportDialog.tsx:166-182,328-330`.
- **Aufwand:** M
- *(Korrigiert gegenüber D2-10: Der **Anhang-Upload** fällt heraus. Er läuft über `fetch`
  (`packages/jmap/src/blob.ts:93-114`), und `fetch` kennt keine Upload-Fortschrittsereignisse —
  `uploadBlob` meldet folgerichtig genau zweimal, `{loaded: 0}` vor und `{loaded: total}` nach dem
  Request. Ein determinierter Balken dafür verlangte einen Rückbau auf `XMLHttpRequest`; das ist
  keine HIG-Frage, sondern ein Architekturtausch, und gehört nicht in diesen Befund. Die von D2-10
  zitierte Zeile `de/common.json:1291` ist ein Spinner-Label, kein Fortschrittstext.)*

---

### D-13 — Fenstertitel fällt in Kalender und Dateien auf den blossen App-Namen zurück

- **Schwere:** niedrig
- **Einordnung:** uebernehmen
- **HIG-Regel:** `toolbars`: „Provide a useful title for each window. A title helps people confirm
  their location as they navigate your app, and differentiates between the content of multiple open
  windows." und „Don't title windows with your app name. Your app's name doesn't provide useful
  information about your content hierarchy."
- **Ist:** `use-document-title.ts:34-49` behandelt `contacts`, `settings`, `notFound` und den
  Mail-Fall; die Route-Ids `calendar` und `files` (`app/route/route.ts:107,112`) fallen in den
  `default`-Zweig, dort ist `mailbox` undefined und der Titel wird zum reinen Produktnamen. Genau den
  Fall beschreibt der Dateikopf selbst als Fehler: die App schiebt bewusst History-Einträge, und das
  Zurück-Menü des Browsers listet sie nach Titel — auf dem Desktop ist dieses Menü, zusammen mit
  zweitem Tab, Lesezeichen und Task-Switcher der installierten PWA, der Ort, an dem der Titel
  gelesen wird.
- **Soll:** Zwei `case`-Zweige ergänzen (`shell.menu.calendar`, `shell.menu.files`) analog zu
  `contacts`/`settings`.
- **Beleg:** `apps/web/src/app/shell/use-document-title.ts:34-49`;
  `apps/web/src/app/route/route.ts:107,112`.
- **Aufwand:** S

---

### D-14 — Der Split-Trenner ist eine 24 px breite eingefärbte Rinne statt einer Haarlinie mit grosser Trefferfläche

- **Schwere:** niedrig
- **Einordnung:** anpassen
- **HIG-Regel:** `split-views` (macOS): „Prefer the thin divider style. The thin divider measures one
  point in width, giving you maximum space for content while remaining easy for people to use. Avoid
  using thicker divider styles unless you have a specific need."
- **Ist:** `ui/SplitPane.module.css:29-45`: `.separator { … background-color: var(--waxwing-bg); }`
  und `.horizontal > .separator { inline-size: 1.5rem; }` — 24 px, vollflächig in der
  Seitenhintergrundfarbe, die sich von beiden Panes (`.pane { background-color:
  var(--waxwing-surface) }`, `shell.module.css:451`) sichtbar absetzt: hell `#f5f5f7` gegen
  `#ffffff`, dunkel `#1c1c1e` gegen `#2c2c2e` (`tokens.css:44-45,262-263`). Zwischen Liste und
  Leseansicht steht damit auf jeder Desktopbreite ein 24 px breiter andersfarbiger Streifen mit
  einem 2 × 32 px Griff in der Mitte. `docs/design-system.md:152-160` begründet die 24 px als
  Trefferband (WCAG 2.5.8) — nicht als gemalte Fläche.
- **Soll:** Trefferband bei 24 px belassen, aber in der Panefarbe bzw. transparent zeichnen und die
  sichtbare Trennung auf eine 1 px Haarlinie (`--waxwing-border`) in der Mitte reduzieren; den Griff
  bei Hover/Fokus hervorheben (die Hover-Regel existiert schon, `:66-70`). Das erfüllt HIG-Regel und
  Zielgrösse zugleich.
- **Beleg:** `apps/web/src/ui/SplitPane.module.css:29-45,52-63`;
  `apps/web/src/app/shell/shell.module.css:444-452`; `apps/web/src/ui/tokens.css:44-45,262-263`;
  `docs/design-system.md:152-160`.
- **Aufwand:** S
- **Nur am Gerät endgültig entscheidbar** (wie stark die Rinne bei echter Displaykalibrierung
  auffällt).

---

### D-15 — Der Zeitpunkt der letzten Aktualisierung wird nie angezeigt, obwohl der Wert vorliegt

- **Schwere:** niedrig
- **Einordnung:** uebernehmen
- **HIG-Regel:** `feedback`: „Consider integrating status feedback into your interface. When status
  feedback is available near the items it describes, people get important information without having
  to take action or leave their current context. For example, Mail in iOS and iPadOS describes the
  most recent update and displays the number of unread messages in the toolbar of the mailbox
  screen, making the information unobtrusive but easy for people to check."
- **Ist:** `sync/engine/types.ts:568` führt `readonly lastSyncedAt: number | null`, gesetzt in
  `engine.ts:1497` und über den Tab-Bus verteilt; gelesen wird der Wert an zwei Stellen, beide Male
  nur als Auslöser (`sharing/use-incoming-shares.ts:73`, `quota/use-quota.ts:96`). Keine Oberfläche
  zeigt ihn. `app/shell/StatusRegion.tsx:22-76` rendert ausschliesslich „Wird synchronisiert …",
  offline, Fehler und „stuck"; im Ruhezustand steht dort nichts.
- **Soll:** Im Ruhezustand (`phase === 'idle'`) eine leise Angabe „Aktualisiert vor x Min." in der
  Statuszone oder der Listen-Toolbar, formatiert über die vorhandenen Intl-Formatter in
  `i18n/formatters.ts`. Kein neuer Zustand nötig, nur ein Leser.
- **Beleg:** `apps/web/src/sync/engine/types.ts:568`; `apps/web/src/sync/engine/engine.ts:1497`;
  `apps/web/src/app/shell/StatusRegion.tsx:22-76`.
- **Aufwand:** S
- *(Korrigiert gegenüber D2-12: Die Fundstelle „StatusRegion.tsx:186-212" gibt es nicht — die Datei
  hat 76 Zeilen. Die zitierte HIG-Stelle beschreibt ausserdem iOS/iPadOS-Mail; für macOS gibt es
  keine wörtliche Entsprechung, weshalb der Befund auf „niedrig" bleibt und als Übertragung
  gekennzeichnet ist.)*

---

### D-16 — Auslassungspunkte innerhalb desselben Menüs uneinheitlich

- **Schwere:** niedrig
- **Einordnung:** uebernehmen
- **HIG-Regel:** `menus`: „Append an ellipsis to a menu item's label when the action requires more
  information before it can complete. The ellipsis character (…) signals that people need to input
  information or make additional choices, typically within another view."
- **Ist:** Im selben Ordner-Menü tragen „Verschieben nach…", „EML-Dateien importieren…" und
  „Ordnerinformationen…" die Auslassungspunkte, „Neuer Unterordner" und „Umbenennen" nicht — obwohl
  beide einen Namensdialog mit Eingabefeld öffnen (`mail/FolderTree.tsx:611`, `NameDialog` mit
  `initialFocusRef={inputRef}`). Zusätzlich uneinheitlicher Abstand vor dem Zeichen im Katalog:
  „Wird synchronisiert …" (`de/common.json:120`) gegen „Wird geladen…" (`:1560`).
- **Soll:** Auslassungspunkte auf jeden Befehl, der vor der Ausführung weitere Eingaben verlangt
  (Neuer Ordner, Neuer Unterordner, Umbenennen, Passwort ändern, Freigeben); reine
  Bestätigungsabfragen wie Löschen bleiben ohne. Eine Schreibweise für den Abstand im ganzen Katalog
  festlegen (und in `locales.test.ts` festschreiben, wie es Z14 für die Apostrophe vorschlägt).
- **Beleg:** `apps/web/src/i18n/locales/de/common.json:946-956`
  (`newSubfolder`/`rename` ohne, `move`/`import`/`info` mit …); `apps/web/src/mail/FolderTree.tsx:611`.
- **Aufwand:** S

---

### D-17 — Icons nur auf zwei von zehn Einträgen desselben Menüs

- **Schwere:** niedrig
- **Einordnung:** uebernehmen
- **HIG-Regel:** `menus`: „Apply a uniform visual treatment across menu items in the same group. For
  visual consistency and balance, provide icons for all menu items in a group, or none of them."
  und „Don't display an icon if you can't find one that clearly represents the menu item."
- **Ist:** Im Ordner-Menü tragen genau zwei Einträge ein Symbol: `keepOffline`
  (`mail/FolderTreeView.tsx:394`, `icon: Pin`) und `share` (`:422`, `icon: UserPlus`); die übrigen
  acht `items.push(…)` zwischen `:361` und `:470` setzen keines. `ui/Menu.tsx` reserviert die
  Symbolspalte, sobald irgendein Eintrag ein Icon hat — die Ausrichtung stimmt damit, die
  Alle-oder-keiner-Regel nicht.
- **Soll:** Pro Menügruppe entscheiden. Für das Ordner-Menü ist „keines" die einfachere Antwort, weil
  es für Umbenennen, Ordnerinformationen und „Älter als … löschen" kein eindeutiges Symbol gibt.
- **Beleg:** `apps/web/src/mail/FolderTreeView.tsx:394,422` gegen `:361-470`.
- **Aufwand:** S

---

## Verworfen

- **D1-03 — „Nachrichten- und Ordnerzeilen sind div+onClick statt Links".** Der Ist-Zustand stimmt
  (`MessageRow.tsx:160-172`, `FolderTreeView.tsx:210-268`), die Schlussfolgerung nicht.
  ⌘-Klick ist auf der Nachrichtenzeile bereits belegt — und zwar mit der macOS-Konvention für
  Listen: `MessageRow.tsx:141-149` schaltet bei `metaKey/ctrlKey` die Auswahl um und bei `shiftKey`
  den Bereich; die Zeile ist ausserdem Drag-Quelle (ADR-012) und Doppelklick öffnet Vollbild. Ein
  `<a href>` an dieser Stelle nähme dem Mac-Nutzer die Mehrfachauswahl, um ihm einen zweiten Tab zu
  geben. Die einzige HIG-Deckung des Vorschlags (`windows`: „Consider letting people view content in
  a new window using a command in a **context menu** or in the menu bar") verweist ausdrücklich auf
  das Kontextmenü — dort ist der Wunsch in **D-01** aufgenommen („In neuem Tab öffnen"/„Link
  kopieren"), womit der Befund als eigener entfällt.
- **D1-05 — „Drei gestapelte Bänder über der ersten Nachricht, Suchfeld in die Kopfzeile".**
  Bereits entschieden, und zwar gegen den Vorschlag: `docs/ui-audit.md:74-77` — „**A5** wollte das
  Suchfeld in die Kopfzeile. Dort würde es den Nutzer auf die Kontakte- und Einstellungsseite
  begleiten, wo es nichts zu suchen gibt. Stattdessen wurde die Listenspalte von 360 auf 420 px
  verbreitert". Dieselbe Begründung steht als Kommentar an der Fundstelle
  (`MailScreen.tsx:345-362`). Die Kopfzeile ist bildschirmübergreifend (`Header.tsx:58-62`), ein
  mail-spezifisches Suchfeld darin ist genau die Verletzung, die A2/A5 vermieden haben. Der
  Messwert selbst (~150 px Chrome auf 900 px Höhe = 17 %) ist zudem unauffällig; die Kernzahl-Tabelle
  desselben Audits hält den Desktop bereits für gelöst.
- **D2-11 — „Dialoge öffnen mit dem Fokus auf dem Schliessen-Kreuz".** Ist-Zustand stimmt
  (`useFocusTrap.ts:34`, `Dialog.tsx:85-95`: der Schliessen-IconButton steht vor `.body`), die
  zitierte Regel gilt aber nicht für macOS: „When a group receives focus, its primary item
  automatically receives focus too" steht in `focus-and-selection` im Abschnitt über das
  **iPadOS/tvOS-Fokussystem** (Fokusgruppen, Halo-Effekt, `focusable priority`); die Seite hat
  keinen macOS-Abschnitt dazu, und `modality`, `sheets` und `alerts` sagen zum Anfangsfokus nichts.
  Damit ist es eine aus einer anderen Plattform importierte Regel. Sachlich bleibt es ein
  APG-/WCAG-Thema (Anfangsfokus im Dialog) und gehört in eine Accessibility-Prüfung, nicht in die
  HIG-Prüfung; die Auswirkung ist zudem gering, weil der Schliessknopf ein sicheres Ziel ist und
  fünf besonders heikle Dialoge bereits `initialFocusRef` setzen.
- **D2-01 — „Icon-only-Knöpfe haben keinen Tooltip".** Doppelt zu D1-06; zusammengefasst in
  **D-02**. Dort korrigiert: 62 statt der von D1-06 genannten 163 Vorkommen, Schwere mittel statt
  hoch.
- **D2-02 — „Sekundärklick öffnet nirgends ein Kontextmenü".** Doppelt zu D1-02; zusammengefasst in
  **D-01**.
- **D2-07 — „Die Ordnerspalte lässt sich auf Desktop-Breite nicht ausblenden".** Doppelt zu D1-01;
  zusammengefasst in **D-05**. Der dort genannte Nebenbefund (konstanter Titel bei umschaltendem
  `aria-expanded`) betrifft einen Knopf, den es im Desktop-Viewport nicht gibt, und ist hier
  gestrichen.
- **D2-08 — „Die eingestellte Spaltenbreite des Split-View wird nicht gemerkt".** Doppelt zu D1-04;
  zusammengefasst in **D-06**.
- **D2-15 — „Keine Anpassung an die macOS-Einstellung Kontrast erhöhen".** Doppelt zu D1-08;
  zusammengefasst in **D-08**.
