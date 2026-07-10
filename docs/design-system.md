# Waxwing Design System

> The look, tokens, and base components of the Waxwing UI. Created in work package M1.1.
> Spec anchors: FR-UI-01/02, FR-THEME-01, FR-A11Y-01. Decision **D5** (design-system
> sign-off) is taken against this document.

Source of truth for the values below:
- Tokens: `apps/web/src/ui/tokens.css` (restylable at runtime via `theme.css`, FR-THEME-01).
- Contrast: `apps/web/src/ui/tokens.contrast.test.ts` — a test, not a claim (see §3).
- Components: `apps/web/src/ui/` (public surface: `apps/web/src/ui/index.ts`).
- Living catalog: the dev-only gallery, `VITE_WAXWING_GALLERY=1 pnpm --filter @waxwing/web dev`.

---

## 1. Principles

1. **Content-first and calm (FR-UI-01).** Neutral surfaces, generous whitespace, one accent
   color. Chrome recedes; the mail is the interface. No gradients-as-decoration, no more than
   one saturated color on screen at rest.
2. **Apple-HIG-inspired, not Apple-cloned.** System font stack first (SF on Apple platforms,
   Segoe/Roboto elsewhere), an 8-pt spacing grid, subtle depth via soft shadows, restrained
   motion. Familiar, platform-native feel without shipping a font.
3. **Both themes are first-class (FR-UI-02).** Every token, component, and screen is designed
   for light and dark from the start — dark is never an afterthought tint.
4. **Accessible by construction (FR-A11Y-01).** WCAG 2.2 AA is the floor: full keyboard
   operability, visible focus, contrast-verified tokens, `prefers-reduced-motion` respected,
   44-px minimum touch targets. Accessibility lives in the base components so features inherit
   it rather than re-implement it.
5. **Restylable without a rebuild (FR-THEME-01/02).** Everything visual is a `--waxwing-*`
   custom property. A hoster ships one `theme.css` and a `config.json`; no build step.
6. **RTL-ready (FR-I18N-02).** Logical CSS properties (`inline`/`block`, `inset-inline-*`)
   throughout — never `left`/`right`/`width`.

---

## 2. Tokens

All tokens are CSS custom properties on `:root`. Theme-varying tokens (colors, elevation)
have a light set on `:root` and a dark set under `prefers-color-scheme: dark` and
`:root[data-theme="dark"]`; `:root[data-theme="light"]` re-asserts light so a manual override
wins over the OS. Theme-invariant tokens (spacing, radius, type, motion, tap target) are
declared once.

### 2.1 Color (semantic)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--waxwing-bg` | `#f5f5f7` | `#1c1c1e` | Page background |
| `--waxwing-surface` | `#ffffff` | `#2c2c2e` | Cards, panels, inputs |
| `--waxwing-surface-2` | `#ebebef` | `#3a3a3c` | Raised/hover/inset |
| `--waxwing-text` | `#1d1d1f` | `#f5f5f7` | Primary text |
| `--waxwing-text-muted` | `#636366` | `#a5a5ad` | Secondary text (AA as text) |
| `--waxwing-border` | `#d2d2d7` | `#48484a` | **Subtle divider/hairline only** (decorative, < 3:1 by design) |
| `--waxwing-border-strong` | `#86868b` | `#939398` | **Interactive control boundary** (≥ 3:1) |
| `--waxwing-focus-ring` | `#c0560a` | `#ff9f45` | Focus + selection ring (≥ 3:1) |
| `--waxwing-accent` | `#e8770e` | `#e8770e` | Brand fill — config-overridable, **never a sole indicator** |
| `--waxwing-accent-contrast` | `#1d1d1f` | `#1d1d1f` | Label on the default accent fill |
| `--waxwing-danger` | `#c10016` | `#ff6b60` | Error text/icon; destructive fill |
| `--waxwing-danger-contrast` | `#ffffff` | `#1d1d1f` | Label on a danger fill |
| `--waxwing-success` | `#1e7b34` | `#30d158` | Success text/icon; fill |
| `--waxwing-success-contrast` | `#ffffff` | `#1d1d1f` | Label on a success fill |
| `--waxwing-warning` | `#8a5d00` | `#ffd60a` | Warning text/icon; fill |
| `--waxwing-warning-contrast` | `#ffffff` | `#1d1d1f` | Label on a warning fill |

**Two borders on purpose.** `--waxwing-border` is a hairline for dividers and card edges
(WCAG 1.4.11 exempts pure decoration), so it is intentionally below 3:1. Anything that is the
*boundary of a control* (inputs, secondary buttons, the menu trigger) uses
`--waxwing-border-strong`, which meets non-text contrast. Never use `--waxwing-border` as the
only edge of an interactive element.

**The accent is not contrast-guaranteed.** It is overridable per deployment
(`config.json` → `--waxwing-accent`), so the design never makes accent color the *only* signal
of a state. Selection/focus is carried by `--waxwing-focus-ring` (guaranteed ≥ 3:1) plus a
surface change; "unread" is carried by weight/`--waxwing-text` as well as an accent dot; and so
on. `--waxwing-accent-contrast` is only asserted legible against the *default* accent.

### 2.2 Elevation

| Token | Use |
| --- | --- |
| `--waxwing-overlay` | Modal scrim (Dialog backdrop) |
| `--waxwing-shadow-1` | Resting lift (switch thumb, small raises) |
| `--waxwing-shadow-2` | Overlays: Menu, Tooltip, Toast, Dialog |

### 2.3 Spacing — 8-pt grid

`--waxwing-space-1..8` = 4, 8, 12, 16, 24, 32, 48, 64 px. All layout gaps and padding come
from this scale; no arbitrary pixel spacing.

### 2.4 Radius

`--waxwing-radius-sm` 6px · `-md` 10px · `-lg` 16px · `-full` pill.

### 2.5 Typography

- Sans stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, …`.
  Mono stack: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, …`.
- Size scale: `--waxwing-text-xs` .75 · `-sm` .875 · `-base` 1 · `-lg` 1.125 · `-xl` 1.375 ·
  `-2xl` 1.75 (rem). Line-heights: `tight` 1.2 · `normal` 1.5 · `relaxed` 1.7. Weights:
  regular 400 · medium 500 · semibold 600 · bold 700.

### 2.6 Interaction & motion

- `--waxwing-tap-target: 44px` — the minimum block size of every interactive base component
  (FR-A11Y-01). Density below 44 px is a *list-level* concern (M1.6, FR-LST-07 + the WCAG 2.5.8
  spacing exception), not something base controls do. **One documented exception:** the
  SplitPane resize separator uses a 24 px hit band (meeting WCAG 2.5.8 AA) rather than 44 px —
  a 44 px divider would be a wide dead zone between panes, and keyboard resize (arrows/Home/End)
  is the separator's primary operable path.
- Durations: `fast` 120ms · `base` 200ms · `slow` 320ms. Easing: `--waxwing-ease-standard`
  `cubic-bezier(0.2, 0, 0, 1)`.
- **Reduced motion:** `global.css` collapses all animation/transition/scroll for
  `prefers-reduced-motion: reduce`. Components must not encode meaning in motion alone.

---

## 3. Contrast (WCAG 2.2 AA — machine-verified)

`tokens.contrast.test.ts` parses the shipped `tokens.css`, rebuilds the effective light and
dark palettes, and asserts every pair the app relies on: **21 pairs × 2 themes = 42
assertions**. Text pairs must meet 4.5:1 (WCAG 1.4.3); control-boundary and focus pairs meet
3:1 (WCAG 1.4.11). The numbers below are from that test; it is what keeps this table honest as
tokens change. A representative slice (ratios in `x:1`):

| Pair | Threshold | Light | Dark |
| --- | --- | --- | --- |
| text on bg | 4.5 | 15.46 | 15.63 |
| text on surface | 4.5 | 16.83 | 12.80 |
| text-muted on surface | 4.5 | 5.99 | 5.70 |
| text-muted on surface-2 | 4.5 | 5.04 | 4.64 |
| accent-contrast on accent | 4.5 | 5.67 | 5.67 |
| danger on surface | 4.5 | 6.40 | 4.99 |
| danger-contrast on danger | 4.5 | 6.40 | 6.03 |
| success-contrast on success | 4.5 | 5.33 | 8.32 |
| warning-contrast on warning | 4.5 | 5.76 | 11.92 |
| border-strong on surface | 3.0 | 3.62 | 4.56 |
| border-strong on surface-2 | 3.0 | 3.05 | 3.71 |
| focus-ring on surface | 3.0 | 4.59 | 6.83 |

Rendered contrast (which token math cannot see — real fonts, opacity, layering) is verified
separately by a **browser axe scan over the gallery in both themes**, including the
`color-contrast` rule: zero violations (M1.1 "Done when").

Deliberately *not* asserted: `--waxwing-border` (decorative hairline) and the accent as a
background/graphic (config-overridable, never a sole indicator — see §2.1).

---

## 4. Component inventory

Public API: `apps/web/src/ui/index.ts`. Every component ships keyboard support, ARIA per its
WAI-ARIA APG pattern, both themes, a 44-px target where interactive, and a co-located test with
a jsdom axe scan.

### 4.1 Primitives (internal — `src/ui/internal/`)

Not exported; the shared kernel the overlays build on.

- **Portal** — renders into a `document.body` host so overlays escape ancestor overflow/stacking.
- **useFocusTrap** — Tab/Shift+Tab wrap within a container, focus restored to the opener on close.
- **useDismiss** — Escape + outside-pointer dismissal, capture-phase so it survives inner
  `stopPropagation`.
- **getFocusableElements** — jsdom-safe focusable discovery (no `offsetParent`).
- **cx** — class-name join.

### 4.2 Components

| Component | Pattern / notes |
| --- | --- |
| **Button** | Variants primary/secondary/ghost/destructive; `loading` (aria-busy, blocks activation); defaults `type="button"`. |
| **IconButton** | Square 44×44; `label` required (accessible name); icon auto-hidden from AT. |
| **TextInput** | Styled input; `invalid` → `aria-invalid` + danger boundary. Labelling is the caller's job (composable). |
| **Select** | **Styled *native* `<select>`** — see §5. `invalid` supported. |
| **Checkbox** | Native + `accent-color`; `indeterminate`; optional visible `label`, else `aria-label`. |
| **Switch** | APG switch: `role="switch"` + `aria-checked`; Space/Enter; state via aria + thumb position, not color. |
| **Spinner** | `role="status"` + localized visually-hidden label; ring is decorative. |
| **Skeleton** | Decorative placeholder (`aria-hidden`); loading is announced by a nearby status, not the boxes. |
| **Badge** | Five contrast-verified solid tones; decorative styling around meaningful text. |
| **Avatar** | Initials only — **never remote images** (FR-LST-03); name is the accessible label. |
| **VisuallyHidden** | Screen-reader-only text kept in the a11y tree. |
| **Tooltip** | Hover + focus, Escape dismiss, `aria-describedby`; supplementary hint only (not an accessible name). |
| **Menu** | APG menu button: roving focus, Up/Down/Home/End, type-ahead, Enter/Space activate, Escape/outside close, focus returns to trigger. |
| **Dialog** | APG modal: focus trap + restore, Escape, scroll lock, `aria-modal` + `aria-labelledby`. |
| **Toast** | `ToastProvider`/`useToast`; per-toast `status`/`alert` live region; auto-dismiss pauses on hover/focus (WCAG 2.2.1). |
| **SplitPane** | APG window splitter: pointer + keyboard resize (arrows/Home/End), `aria-valuenow/min/max`. |

---

## 5. Notable decisions

- **Select is a styled native control, not a custom listbox.** The native `<select>` earns
  correct keyboard handling, screen-reader support, and mobile pickers for free — the exact
  things a hand-rolled listbox re-implements and routinely gets wrong. A custom
  combobox/listbox is deferred to the single place that genuinely needs one (e.g. a rich
  account switcher), where the cost buys something.
- **Dialog uses a manual focus trap, not the native `<dialog>`.** Portability and testability:
  `<dialog>.showModal()` has uneven jsdom support, and the manual trap (`useFocusTrap`) gives
  precise, verifiable control of initial focus and restoration.
- **The gallery is dev-only.** It mounts only under `VITE_WAXWING_GALLERY=1` and is
  dead-code-eliminated from production, so base components add nothing to the shipped bundle
  until feature code imports them.

---

## 6. Component contract (conventions for adding to `src/ui/`)

1. One component per file: `Name.tsx` + `Name.module.css` + `Name.test.tsx`. Export from
   `index.ts`. Keep shared logic in `internal/`.
2. **Tokens only** in CSS — no raw colors or ad-hoc pixels; **logical properties** for RTL.
3. Compose class names with `cx`; forward `className`. Controls extend the intrinsic element's
   props and forward `ref` (React 19 ref-as-prop).
4. **No hardcoded user-visible strings.** Intrinsic labels default to `ui.*` i18n keys
   (en + de), overridable via props; other copy is the caller's.
5. Interactive → 44-px minimum target, ARIA per the APG pattern, visible focus via the global
   `:focus-visible` ring (don't override it).
6. Every component gets a test that includes an axe scan (assert portalled components against
   `document.body`). Contrast/theme rendering is covered by the browser gallery scan.
