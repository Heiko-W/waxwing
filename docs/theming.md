# Theming and white-labelling Waxwing

> How a deployment restyles and rebrands Waxwing **without rebuilding it**. Spec anchors:
> FR-THEME-01 (restyle without a rebuild), FR-THEME-02 (branding completeness), FR-THEME-03
> (selectable accents). The token reference is [`docs/design-system.md`](design-system.md); this
> document is the operator-facing contract.

Waxwing ships as static files. Three of them are **yours** — they are read at runtime, never
precached by the service worker, and survive an app upgrade untouched:

| File | What it controls |
|---|---|
| `config.json` | Product name, logo, accent, default theme, hoster links, server and feature defaults |
| `theme.css` | Every visual token — colour, spacing, radius, typography, elevation, motion |
| `branding/` | Logo, favicon and the PWA icons |

Edit them in place and reload. There is no build step, no environment variable and no container.

---

## 1. The contract

`theme.css` is loaded **after** the app's own stylesheet, so any `--waxwing-*` custom property you
re-declare on `:root` wins on the cascade. That is the whole mechanism — there is no theme API to
learn and no class names to target.

Two rules make this safe to rely on across upgrades:

- **Only `--waxwing-*` custom properties are contract.** Class names (`._button_60b723`) are
  build-generated and change without notice. A theme that targets them will break silently on the
  next release.
- **Every token has a default.** Override what you want; anything you leave alone keeps the built-in
  value, including in dark mode.

## 2. An annotated example — "Acme Mail"

A complete rebrand. Drop this in `theme.css`:

```css
/* Acme Mail — a worked example. Every line is optional. */
:root {
  /* ── Brand ───────────────────────────────────────────────────────────────
     The accent is the one saturated colour on screen at rest. It is used for
     fills and the brand mark — never as the ONLY signal of a state, so
     changing it cannot make anything unreadable or ambiguous. */
  --waxwing-accent: #7a1f3d;
  /* The label ON an accent fill. Set it with the accent, and check it: this is
     the one pair Waxwing cannot verify for you (see §4). */
  --waxwing-accent-contrast: #ffffff;

  /* ── Surfaces ────────────────────────────────────────────────────────────
     Page background, cards/panels/inputs, and the raised/hover/inset step. */
  --waxwing-bg: #faf7f5;
  --waxwing-surface: #ffffff;
  --waxwing-surface-2: #f0e9e6;
  /* Row hover and row selection. Selection also carries a focus ring, so it
     stays visible for anyone who cannot distinguish your two surfaces. */
  --waxwing-surface-hover: #f0e9e6;
  --waxwing-surface-selected: #f6e3ea;

  /* ── Text ────────────────────────────────────────────────────────────────
     `text` must reach 4.5:1 on `bg` AND on `surface`; `text-muted` likewise. */
  --waxwing-text: #23191c;
  --waxwing-text-muted: #6b5a60;

  /* ── Lines ───────────────────────────────────────────────────────────────
     TWO borders on purpose. `border` is a decorative hairline (dividers, card
     edges) and is exempt from contrast. `border-strong` is the boundary of a
     CONTROL — inputs, secondary buttons — and must reach 3:1 (WCAG 1.4.11).
     Never use `border` as the only edge of something interactive. */
  --waxwing-border: #e3d7d2;
  --waxwing-border-strong: #8a7178;

  /* The focus and selection ring. Its job is to be unmissable: ≥ 3:1 against
     every surface it can land on. Do not tint it to match the brand unless it
     still clears that. */
  --waxwing-focus-ring: #7a1f3d;

  /* ── Signal colours ──────────────────────────────────────────────────────
     Keep these RECOGNISABLE. A warning that reads as brand decoration is not a
     warning. Each `-contrast` is the label on that fill. */
  --waxwing-danger: #b3001b;
  --waxwing-danger-contrast: #ffffff;
  --waxwing-success: #1e7b34;
  --waxwing-success-contrast: #ffffff;
  --waxwing-warning: #8a5d00;
  --waxwing-warning-contrast: #ffffff;

  /* ── Shape and type ──────────────────────────────────────────────────────
     Radii: sm (chips, inputs), md (cards, buttons), lg (dialogs), full (pills).
     Fonts: a stack, not a webfont — Waxwing ships none and loads none. If you
     want one, self-host it and add your own @font-face here. */
  --waxwing-radius-sm: 0.25rem;
  --waxwing-radius-md: 0.5rem;
  --waxwing-radius-lg: 0.75rem;
  --waxwing-font-sans: 'Acme Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Dark mode. The app sets `data-theme` for an explicit user choice and falls
   back to `prefers-color-scheme`, so override BOTH to cover either path.
   Dark is not a tint of light: pick real values, or leave it to the built-ins. */
:root[data-theme='dark'],
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --waxwing-accent: #e08aa6;
    --waxwing-accent-contrast: #23191c;
    --waxwing-bg: #1a1416;
    --waxwing-surface: #262023;
    --waxwing-surface-2: #332b2e;
    --waxwing-text: #f7f2f3;
    --waxwing-text-muted: #b3a2a7;
    --waxwing-border: #3d3336;
    --waxwing-border-strong: #94848a;
  }
}
```

And in `config.json`:

```json
{
  "branding": {
    "productName": "Acme Mail",
    "logo": "branding/acme-logo.svg",
    "accentColor": null,
    "defaultTheme": "auto",
    "links": {
      "imprint": "https://acme.example/imprint",
      "support": "https://acme.example/support",
      "privacy": "https://acme.example/privacy"
    }
  }
}
```

`productName` replaces the name everywhere it is shown — the document title, the sign-in screen, the
install prompt, the about section and every system notification. `accentColor` is a **shortcut** for
setting `--waxwing-accent` from JSON when you do not want to touch CSS at all; leave it `null` if you
set the token in `theme.css` (the CSS wins either way, so setting both is only confusing).

## 3. Replacing the artwork

Under `branding/`, keeping the filenames or updating the references in `config.json` and
`manifest.json`:

| File | Where it appears |
|---|---|
| `logo.svg` | Sign-in screen, app header |
| `favicon.svg` | Browser tab |
| `icon-192.png`, `icon-512.png` | PWA install, app switcher |
| `icon-maskable-512.png` | Android adaptive icon (keep the safe zone) |
| `apple-touch-icon-180.png` | iOS home screen |

**`manifest.json` is part of the rebrand and is not covered by `config.json`.** Its `name`,
`short_name`, `description` and `theme_color` are read by the operating system at install time, not
by the app, so they cannot be themed at runtime. Edit them alongside the icons — it is the same
deployment directory and the same "no rebuild" promise, but it is a separate file and it is the one
people forget.

## 4. Check your theme before you ship it

Waxwing verifies its OWN tokens for WCAG 2.2 AA contrast (21 pairs × 2 themes, as a test — see
`docs/design-system.md` §3). It cannot verify yours: your file is read at runtime, on a machine the
test never sees.

So check these pairs yourself, with any contrast tool:

| Pair | Minimum | Why |
|---|---|---|
| `text` on `bg`, `text` on `surface` | 4.5:1 | Body text (1.4.3) |
| `text-muted` on `surface`, on `surface-2` | 4.5:1 | It is text, not decoration |
| `accent-contrast` on `accent` | 4.5:1 | The label on your brand fill |
| `danger/success/warning-contrast` on their fill | 4.5:1 | Same, for signal colours |
| `border-strong` on `surface`, on `surface-2` | 3:1 | Control boundaries (1.4.11) |
| `focus-ring` on `surface` | 3:1 | The one thing a keyboard user needs |

`--waxwing-border` is deliberately exempt: it is a decorative hairline, and WCAG 1.4.11 exempts pure
decoration. That exemption is why it must never be the only edge of an interactive control.

## 5. What you cannot change without a rebuild

Honest limits, so you do not go looking:

- **Layout and structure.** Pane arrangement, list density options and component internals are not
  tokenised. `theme.css` restyles; it does not rearrange.
- **Class names.** Build-generated; see §1.
- **The service worker's cached shell.** Your three files are deliberately network-first, so they
  update on the next load. The app's own JS/CSS updates only with a new release.
- **`index.html`.** One line matters if you host under a subdirectory rather than at the root:
  `<base href="/">` must become `<base href="/your-prefix/">`. Stalwart's *Applications* feature
  rewrites that token for you; a plain web server does not.
