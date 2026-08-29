# Translating Waxwing

Waxwing ships **fourteen languages**. Two of them were written by a person:

| | |
|---|---|
| **Read by a native speaker** | `en` English · `de` Deutsch |
| **Machine-generated, unreviewed** | `cs` Čeština · `es` Español · `fr` Français · `it` Italiano · `ja` 日本語 · `nl` Nederlands · `pl` Polski · `pt` Português · `ru` Русский · `tr` Türkçe · `uk` Українська · `zh` 中文 |

Until v0.21.0 this document opened by ruling machine translation out, on the grounds that this is a
mail client and a reader who confuses *Discard* with *Archive* loses a message. **That reasoning was
right and its conclusion was wrong**, and it is worth being explicit about why, because it decides
what this document is now for.

The pipeline that sentence pointed at — Weblate, a review queue, volunteers — produced no language
in the whole time it existed. The first person to ask for one asked whether they should fork the
project to get it. So the choice was never between a machine translation and a reviewed one; it was
between a machine translation and English.

The risk did not go away, it moved. It is now carried by a **gate** that removes every failure a
reviewer cannot see anyway, so that what is left in the twelve bundles is only ever a question of
*wording* — and a question of wording can be answered by one person, in one line, in one pull
request. That is what this document is for.
[ADR-036](adr/036-machine-translation-with-a-mechanical-gate.md) has the full argument.

## Fixing a string — the common case

You read Waxwing in Polish, a button says the wrong thing.

1. Find it in `apps/web/src/i18n/locales/pl/common.json`. The keys are hierarchical and named after
   where they appear (`settings.filters.form.name`, `reading.unsubscribe.oneClick`), so searching
   for the English wording in `en/common.json` and then opening the same path in your language is
   usually the fastest route.
2. Change the value. Leave the key alone.
3. Check it: `node scripts/check-locales.mjs pl` — about a second, no build.
4. Open a pull request. One string is a perfectly good pull request.

If you would rather not open one, an issue that says "the *Delete forever* button in Polish reads
like *Archive*" is genuinely useful. Somebody else can make the edit; nobody else can notice it.

## What a translator works with

One file per language, `apps/web/src/i18n/locales/<lang>/common.json`, with about **1 600 keys** in
29 sections. `en` is the source; everything else is a translation of it.

### Placeholders

`{{name}}` is interpolated at run time and **must survive verbatim** — including the braces. A few
strings carry more than one.

```json
"willSend": "Sends {{when}}",
"unsupportedExtensions": "This server did not list support for: {{list}}."
```

You may **drop** a placeholder where the sentence does not need it — a singular form rarely has to
repeat the number. You may never **invent** one: there is nothing to interpolate, so i18next renders
the braces and the reader sees `{{count}}` on screen.

`{{product}}` is the exception that may not be dropped, and its expansion may never be written out.
A hoster can rebrand Waxwing from `config.json` without a rebuild, and a translation with the name
baked in defeats that for every reader of that language.

### Plurals

i18next resolves plurals through `Intl.PluralRules`, by key suffix. **A language needs exactly the
forms it selects — no fewer, and no more.** English selects two; Russian, Ukrainian, Polish and
Czech select four; Chinese and Japanese select one.

```json
"count_one":   "{{count}} повідомлення",
"count_few":   "{{count}} повідомлення",
"count_many":  "{{count}} повідомлень",
"count_other": "{{count}} повідомлення"
```

A missing form does not render as a missing string. It falls back to **English, mid-sentence**, for
exactly the counts that select it — which for `_few` in Ukrainian is 2, 3 and 4, and is therefore
the single easiest defect in this repository to ship and the hardest to notice.

The suffixes come from the platform, not from a table: `new Intl.PluralRules('uk').resolvedOptions()`
is the authority, and `scripts/check-locales.mjs` asks it for you.

### The one list

`compose.attachMentionKeywords` is an array, not a string: the words that make *"you mentioned an
attachment"* fire. It is **not** a five-item list to be translated five times — give your language
the words it actually uses, however many that is. German needs both *anbei* and *beigefügt* where
English has one *attached*.

## Checking your work

```
node scripts/check-locales.mjs          # every bundle
node scripts/check-locales.mjs ru pl    # just these — one language, no noise from the others
```

It exits non-zero on the first thing it can prove is wrong:

- a key that is missing, or one `en` does not have;
- a plural form the language selects and the file lacks — or one it never selects;
- an invented `{{placeholder}}`, a dropped `{{product}}`, a hardcoded "Waxwing";
- an empty value (the one "translation" that renders as a blank button);
- `'` where `’` belongs, `...` where `…` belongs, `Loading …` where `Loading…` belongs;
- more than half the file byte-identical to English, which is not a translation but a copy.

The same rules run inside `pnpm test` (`apps/web/src/i18n/locales.test.ts`), from the same module —
`scripts/locale-rules.mjs`. There is one implementation on purpose: a rule only the CLI knew would
not block a release, and a rule only the gate knew would ambush you at the end.

**What it cannot check is whether the translation is any good.** That still needs a person, which is
the whole reason the table at the top of this file names which twelve have not had one.

## Setting up Weblate

[Weblate](https://weblate.org) is the recommended host: it speaks the i18next JSON format natively,
opens pull requests rather than pushing to `main`, and gives translators a review queue.

`.weblate` in the repository root configures the component. After adding the repository to a
Weblate instance:

1. **Component** → *Add new translation component*, pointing at this repository.
2. **File format**: *i18next JSON file v4*.
3. **File mask**: `apps/web/src/i18n/locales/*/common.json`
4. **Monolingual base language file**: `apps/web/src/i18n/locales/en/common.json`
5. **Source language**: English.
6. **Push on commit**: off. Waxwing's gate (`pnpm verify`) has to run before anything lands, so
   Weblate opens a pull request instead.

## Adding a language to the app

A translated file is not yet a shipped language. Two edits:

1. The bundle: `apps/web/src/i18n/locales/<tag>/common.json`.
2. The tag in `SUPPORTED_LANGUAGES`, `apps/web/src/i18n/index.ts`.

Nothing else. The picker names the language from `Intl.DisplayNames`, so there is no list of names
to extend, and `RTL_LANGUAGES` already carries the right-to-left scripts — an Arabic or Hebrew
bundle flips the document direction the moment its tag is added. (Nothing has exercised that path
yet. The first person to add one should look at the result before trusting it.)

Then run `pnpm verify`. Three gates will have an opinion:

- **`i18n/locales.test.ts`** runs every rule above against every bundle, and additionally checks that
  each supported tag has a file and each file has a tag — a bundle nobody can reach is how a language
  gets translated twice.
- **`app/guards.test.ts`** checks that every literal `t()` key in the source resolves. A key that
  exists in no bundle renders as its own dotted path on screen.
- **`size-limit`** counts the initial JS. Locale bundles are lazy (one per language, fetched on
  demand), so a new language does not enter the 300 KB budget — but the check is what proves that
  stayed true. It does enter the service-worker precache, which every reader downloads once; see
  ADR-036 for why that was accepted rather than engineered around.

## What to watch for

- **The product name is interpolated**, not written out: `{{product}}`. A hoster can rebrand, and
  a translation with "Waxwing" baked in would defeat that.
- **Destructive wording may never soften.** *Delete forever*, *Permanently delete*, *Empty trash*,
  *This can’t be undone* — a reader who mistakes one of these for *Archive* loses mail. If your
  language has a gentler and a blunter way to say it, this is the place for the blunter one.
- **Filenames are not translated.** `attachment` and `message.eml` are deliberately English in the
  source: they become files on disk, and a filename that changes with the UI language is a file
  the reader cannot find again.
- **Keyboard shortcuts are not translated.** The chords are physical keys; only their descriptions
  are text.
- **Length is a constraint.** These are buttons, menu items and toasts. A label that grows into a
  clause is a layout that wraps.
