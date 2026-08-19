# Translating Waxwing

Waxwing ships **English and German**. Everything else needs a person who speaks the language.

This document is the pipeline for getting there. It deliberately does not describe a way to
generate translations automatically: this is a mail client, and a reader who confuses *Discard*
with *Archive* loses a message. A string nobody has read is not a translation.

## What a translator works with

One file per language, `apps/web/src/i18n/locales/<lang>/common.json`, with **882 keys** in 26
sections. `en` is the source; everything else is a translation of it.

The keys are hierarchical and named after where they appear (`settings.filters.form.name`,
`reading.unsubscribe.oneClick`), so the path is usually enough context to translate from. Where it
is not, the English string is.

### Placeholders

`{{name}}` is interpolated at run time and **must survive verbatim** — including the braces. A few
strings carry more than one.

```json
"willSend": "Sends {{when}}",
"unsupportedExtensions": "This server did not list support for: {{list}}."
```

### Plurals

i18next resolves plurals by key suffix (`_one`, `_other`, and for some languages `_few`, `_many`,
`_zero`). A language with more plural forms than English needs **more keys than the source has** —
that is expected, not an error.

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

A translated file is not yet a shipped language. Two edits, both in
`apps/web/src/i18n/index.ts`:

1. Add the tag to `SUPPORTED_LANGUAGES`.
2. Nothing else — `RTL_LANGUAGES` already lists the right-to-left scripts, so an Arabic or Hebrew
   bundle flips the document direction the moment it is supported.

Then run `pnpm verify`. Two gates will have an opinion:

- **`guards.test.ts`** checks that every literal `t()` key in the source resolves in *every*
  locale. A missing key fails the build rather than rendering the key itself on screen.
- **`size-limit`** counts the initial JS. Locale bundles are lazy (one per language, fetched on
  demand), so a new language does not enter the 300 KB budget — but the check is what proves that
  stayed true.

## What to watch for

- **The product name is interpolated**, not written out: `{{product}}`. A hoster can rebrand, and
  a translation with "Waxwing" baked in would defeat that.
- **Filenames are not translated.** `attachment` and `message.eml` are deliberately English in the
  source: they become files on disk, and a filename that changes with the UI language is a file
  the reader cannot find again.
- **Keyboard shortcuts are not translated.** The chords are physical keys; only their descriptions
  are text.
