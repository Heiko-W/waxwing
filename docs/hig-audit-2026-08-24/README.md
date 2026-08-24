# Waxwing gegen die Apple Human Interface Guidelines

**Erhebung vom 24.08.2026, nach v0.18.0.** Drei Befundlisten zum späteren Abarbeiten, im
Stil der UI-Begehung (`docs/ui-audit.md`) und der JMAP-Erhebung
(`docs/jmap-gap-2026-08-21/`).

**Dieses Dokument ändert nichts.** Es ist eine Arbeitsliste. Jeder Befund trägt einen Beleg —
eine Quellcodezeile oder eine Messung — und jede zitierte Regel trägt ihre HIG-Seite, damit
beides nachprüfbar ist statt geglaubt werden zu müssen.

| | |
|---|---|
| [**befunde-desktop.md**](./befunde-desktop.md) | 17 Befunde · macOS · 1440×900 und breiter |
| [**befunde-tablet.md**](./befunde-tablet.md) | 9 Befunde · iPadOS · 834×1112 hoch, 1112×834 quer |
| [**befunde-phone.md**](./befunde-phone.md) | 13 Befunde · iOS · 390×844, auch als Startbildschirm-App |

---

## Warum überhaupt, und wie weit

Waxwing ist eine **Web-App, kein natives Programm**, und läuft auch auf Windows, Linux und
Android. Volle HIG-Konformität ist deshalb weder erreichbar noch wünschenswert: ein Teil der
Richtlinien setzt Systemmenüleiste, Fensterampeln, Dock oder echte Vibrancy-Materialien voraus.
Wer das im Browser nachbaut, macht die App auf Apple-Geräten nicht besser und auf allen anderen
schlechter.

Das Projekt hat diese Frage bereits beantwortet — `docs/design-system.md` §1 Grundsatz 2:
**„Apple-HIG-inspired, not Apple-cloned."** Die Farbwerte in `ui/tokens.css` sind Apples
Systemgrautöne, das Abstandsraster ist Apples 8-pt-Raster. Diese Erhebung prüft also nicht eine
neue Richtung, sondern eine bereits erklärte — zum ersten Mal systematisch und gegen den
Wortlaut.

Deshalb trägt jeder Befund eine **Einordnung**:

| | |
|---|---|
| **übernehmen** | Die Regel gilt im Browser genauso. Waxwing erfüllt sie nicht — echte Lücke. |
| **anpassen** | Der Sinn der Regel gilt, die native Form nicht. Der Befund nennt die web-gerechte Form. |
| **bewusst abweichen** | Waxwing weicht ab und soll das auch; die Abweichung verdient aber eine schriftliche Begründung (ADR-Kandidat). |

**Ergebnis der Einordnung: 23-mal übernehmen, 16-mal anpassen, 0-mal bewusst abweichen.** Die
dritte Kategorie ist leer, und das ist ein Befund für sich: jede geprüfte Abweichung war
entweder eine echte Lücke oder bereits schriftlich begründet — die Gegenprüfung hat mehrere
Rohbefunde genau deshalb verworfen. Der Grundsatz „inspired, not cloned" wird also gelebt und
nicht nur behauptet.

## Wie geprüft wurde

**Die Quelle.** developer.apple.com/design/human-interface-guidelines ist eine
JavaScript-Anwendung; ein gewöhnlicher Seitenabruf liefert nur den Titel. Der Text steht
ausschliesslich im DocC-JSON dahinter. [`hig.sh`](./hig.sh) in diesem Ordner holt ihn:

```sh
./hig.sh sidebars
./hig.sh designing-for-ios
```

Ohne diesen Umweg lässt sich die HIG nicht zitierfähig lesen, sondern nur aus dem Gedächtnis
behaupten — und ein Audit aus dem Gedächtnis wäre wertlos. Jedes Zitat in den drei Listen
stammt aus diesem Abruf.

**Der Ablauf.** 15 Agenten in drei Stufen:

1. **HIG lesen** — sechs Agenten lesen 71 HIG-Seiten (Grundlagen, Plattformen, Navigation,
   Präsentation, Muster, Barrierefreiheit/Eingabe) und destillieren daraus **940 prüfbare
   Regeln**: je Regel der Wortlaut, die Seite, die Plattform und die Web-Einordnung.
2. **Prüfen** — sechs Agenten halten den Quellcode dagegen, je Viewport getrennt nach
   *Struktur/Navigation/Layout* und *Interaktion/Komponenten/Rückmeldung*. **61 Rohbefunde.**
3. **Gegenprüfen** — drei Agenten (einer je Viewport) versuchen, jeden Rohbefund zu
   **widerlegen**: Stimmt die Datei:Zeile? Greift die Media-Query in diesem Viewport
   überhaupt? Steht die Regel wirklich auf der genannten Seite, und im richtigen
   Plattformabschnitt? Ist die Abweichung in `docs/` oder im Quellkommentar bereits begründet?
   Würde der Vorschlag Waxwing auf Windows/Linux/Android beschädigen?

**61 Rohbefunde → 39 Befunde, 19 verworfen** (der Rest zusammengefasst). Die Verwerfungen stehen
am Ende jeder Liste, mit Grund und Fundstelle — sie sind der wertvollste Teil des Dokuments,
denn sie verhindern, dass dieselben Vorschläge beim nächsten Durchgang wieder auftauchen.

Zwei Beispiele dafür, dass die Gegenprüfung nicht nur Formsache war:

- Ein Rohbefund verlangte eine dauerhaft sichtbare Aktionsleiste im Lesebereich und berief sich
  auf einen Satz aus `toolbars` — der steht im **watchOS**-Abschnitt. Der Befund bleibt, seine
  Begründung wurde ersetzt.
- Ein Rohbefund verlangte den Anfangsfokus im Dialog auf dem Primärknopf statt auf dem
  Schliesskreuz und zitierte `focus-and-selection` — die Stelle beschreibt das
  **iPadOS/tvOS-Fokussystem** und gilt für macOS nicht. Verworfen (bleibt ein WCAG-Thema, kein
  HIG-Verstoss).

## Was die Prüfung nicht ist

**Eine Quellcode-Prüfung, kein Gerätetest.** Es wurde kein iPhone, kein iPad und kein Mac
bedient; gemessen wurde am Quelltext, die rem-Werte aus `ui/tokens.css` gegen Apples pt-Zahlen
gerechnet. **Zwölf Befunde** (vier je Liste) sind mit *„Nur am Gerät endgültig entscheidbar"*
markiert — überwiegend die Bildschirmtastatur, die sicheren Bereiche und das Verhalten der
installierten App. Diese Befunde sind Verdachtsmomente mit Beleg, keine Messwerte.

Nicht geprüft: App-Symbole, Widgets, Mitteilungen ausserhalb der Web-Push-Anbindung, Spiele,
visionOS, watchOS, tvOS.

## Was quer durch alle drei Listen geht

Fünf Ursachen erzeugen zwölf der 39 Befunde. Wer sie zuerst angeht, räumt am meisten ab:

| Ursache | Befunde | Aufwand |
|---|---|---|
| **`color-scheme` wird nirgends gesetzt** — die Tokens kennen den Dunkelmodus, die vom System gezeichneten Teile (Scrollbalken, Auswahllisten, Datumsfelder) nicht. | D-07, T-04 | S |
| **Der pauschale `prefers-reduced-motion`-Reset friert Ladeanzeigen ein** — `global.css:130-143` setzt `animation-iteration-count: 1` für *alles*; der Spinner dreht sich dann genau einmal 0,01 ms lang und steht danach still. „Bewegung reduzieren" heisst nicht „Zustandsanzeige abschalten". | D-09, T-09, P-08 | S |
| **Die Bildschirmtastatur wird nirgends ausgewertet** (`visualViewport`: 0 Treffer) — Senden, Verwerfen und Dialogfussleisten liegen darunter. | T-01, P-04, P-07 | M–L |
| **Sichere Bereiche nur unten, nur an zwei Stellen** — `env(safe-area-inset-top/left/right)` kommt im ganzen Quellbaum nicht vor, bei `viewport-fit=cover` und `display: standalone`. | P-01, P-02, T-05 | S |
| **Formulardialoge verwerfen Eingaben ohne Rückfrage** bei Escape und Klick daneben. | D-03, P-09 | S–M |

## Die schwersten Einzelbefunde

- **P-01 · Sichere Bereiche** — die Kopfzeile trägt auf dem Telefon die gesamte Bedienung und
  polstert mit 8 px gegen die Dynamic Island. Aufwand S.
- **P-02 · Toasts über der Navigationsleiste** — verschärft durch ADR-021: handlungstragende
  Toasts haben `duration: 0` und bleiben stehen, bis man sie antippt. Nach einem Archivieren ist
  die Hauptnavigation dauerhaft verdeckt. Aufwand S.
- **P-03 · Nachrichtenaktionen scrollen weg** — Antworten/Weiterleiten/Löschen sitzen im
  scrollenden Inhalt, beim Öffnen im oberen Drittel, nach dem Lesen aus dem Bild. Auf dem
  Telefon gibt es kein Tastenkürzel als Ausweg.
- **D-01 · Kein Kontextmenü** — `onContextMenu`: **0 Treffer** im gesamten Quellbaum. Die
  Menüdaten liegen als fertige Listen vor (`FolderTreeView.tsx:359-470`,
  `MessageView.tsx:876`); es fehlt nur der Aufhänger. Apple nennt in `context-menus`
  ausgerechnet das Kontextmenü einer Mail im Posteingang als Beispiel.

## Wie damit weitergearbeitet wird

Die Befunde sind **noch keine B-Nummern** in `docs/implementation-plan.md`. Der nächste Schritt
ist eine Auswahl: was in ein Release einfliesst, wird dort als Zeile aufgenommen und mit einem
Test belegt; was zurückgestellt wird, bleibt hier stehen und behält seinen Beleg.

Reihenfolge, wenn nichts dagegen spricht: erst die fünf Querschnitts-Ursachen oben (drei davon
Aufwand S), dann die schweren Telefon-Befunde, dann der Desktop. Der Desktop hat die meisten
Befunde, aber nur einen schweren — dort geht es um Verfeinerung, auf dem Telefon um
Bedienbarkeit.
