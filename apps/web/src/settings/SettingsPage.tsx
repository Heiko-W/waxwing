import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandLinks } from '../app/BrandLinks'
import type { ThemeSetting } from '../app/config'
import {
  READING_PANE_MODES,
  type ReadingPaneMode,
  setReadingPaneMode,
  useReadingPaneMode,
} from '../app/shell/layout'
import { getTheme, setTheme } from '../app/theme'
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n'
import { Select } from '../ui'
import styles from './settings.module.css'

const THEME_OPTIONS: readonly ThemeSetting[] = ['auto', 'light', 'dark']

interface Option {
  readonly value: string
  readonly label: string
}

/** A labeled native <select> with an optional hint, wired for programmatic association. */
function SelectField(props: {
  id: string
  label: string
  hint?: string
  value: string
  options: readonly Option[]
  onChange: (value: string) => void
}) {
  const hintId = props.hint !== undefined ? `${props.id}-hint` : undefined
  return (
    <div className={styles.field}>
      <label htmlFor={props.id} className={styles.label}>
        {props.label}
      </label>
      <Select
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        {...(hintId ? { 'aria-describedby': hintId } : {})}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {props.hint !== undefined && hintId !== undefined && (
        <p id={hintId} className={styles.hint}>
          {props.hint}
        </p>
      )}
    </div>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={props.title}>
      <h2 className={styles.sectionTitle}>{props.title}</h2>
      <div className={styles.controls}>{props.children}</div>
    </section>
  )
}

/**
 * Settings route screen (lazy chunk). M1.4 ships the Appearance section — theme, language and
 * the reading-pane layout (FR-LST-07 layout half); the rest arrives with M3.7. Default export
 * so `React.lazy(() => import(...))` can load it.
 */
export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const [theme, setThemeState] = useState<ThemeSetting>(() => getTheme())
  const readingPane = useReadingPaneMode()
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language
  const ids = { theme: useId(), language: useId(), readingPane: useId() }

  function handleTheme(value: string): void {
    const next = value as ThemeSetting
    setTheme(next)
    setThemeState(next)
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('settings.title')}</h1>

      <Section title={t('settings.appearance.title')}>
        <SelectField
          id={ids.theme}
          label={t('theme.label')}
          value={theme}
          options={THEME_OPTIONS.map((value) => ({ value, label: t(`theme.${value}`) }))}
          onChange={handleTheme}
        />
        <SelectField
          id={ids.language}
          label={t('language.label')}
          value={activeLanguage}
          options={SUPPORTED_LANGUAGES.map((value: SupportedLanguage) => ({
            value,
            label: t(`language.${value}`),
          }))}
          onChange={(value) => {
            void changeLanguage(value as SupportedLanguage)
          }}
        />
        <SelectField
          id={ids.readingPane}
          label={t('settings.appearance.readingPane.label')}
          hint={t('settings.appearance.readingPane.hint')}
          value={readingPane}
          options={READING_PANE_MODES.map((value) => ({
            value,
            label: t(`settings.appearance.readingPane.${value}`),
          }))}
          onChange={(value) => setReadingPaneMode(value as ReadingPaneMode)}
        />
      </Section>

      <p className={styles.more}>{t('settings.more')}</p>
      <BrandLinks />
    </div>
  )
}
