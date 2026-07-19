import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandLinks } from '../app/BrandLinks'
import type { ThemeSetting } from '../app/config'
import { useSessionOptional } from '../app/session/context'
import {
  READING_PANE_MODES,
  type ReadingPaneMode,
  setReadingPaneMode,
  useReadingPaneMode,
} from '../app/shell/layout'
import { getTheme, setTheme } from '../app/theme'
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n'
import { setPref, useLocalPref, useReplica, useReplicaOptional } from '../sync'
import { Select } from '../ui'
import { ComposeSection } from './ComposeSection'
import { NotificationsSection } from './NotificationsSection'
import { ReadingSection } from './ReadingSection'
import { ServerSection } from './ServerSection'
import { StorageSection } from './StorageSection'
import { SwipeSection } from './SwipeSection'
import styles from './settings.module.css'
import { VacationSection } from './VacationSection'
import { serverSupportsVacation } from './vacation-client'

const THEME_OPTIONS: readonly ThemeSetting[] = ['auto', 'light', 'dark']
const DENSITY_OPTIONS = ['comfortable', 'compact'] as const
type Density = (typeof DENSITY_OPTIONS)[number]

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

/** The density control needs a replica to write to; the rest of Appearance does not. */
function DensityField({ id }: { readonly id: string }) {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const density = useLocalPref<Density>('list.density') ?? 'comfortable'
  return (
    <SelectField
      id={id}
      label={t('settings.appearance.density.label')}
      value={density}
      options={DENSITY_OPTIONS.map((value) => ({
        value,
        label: t(`settings.appearance.density.${value}`),
      }))}
      onChange={(value) => void setPref(db, accountId, 'list.density', value)}
    />
  )
}

/**
 * Settings route screen (lazy chunk). M3.7 completes it: General, Appearance, Reading, Swipe
 * actions, Compose, Vacation responder, Notifications, Offline & storage, Server, About.
 *
 * **Theme, language and the reading-pane mode stay in `localStorage`, not `localPrefs`** — they are
 * applied on the ONBOARDING screen, where there is no account and no replica to scope them to. The
 * account-scoped preferences are the ones that only mean anything once you are signed in.
 *
 * Sections that need a replica or a session are simply absent without one, rather than rendering a
 * broken control (FR-SRV-02: an absent capability is hidden, never broken). Vacation additionally
 * requires the server to advertise it.
 */
export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const [theme, setThemeState] = useState<ThemeSetting>(() => getTheme())
  const readingPane = useReadingPaneMode()
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language
  const ids = { theme: useId(), language: useId(), readingPane: useId(), density: useId() }
  const replica = useReplicaOptional()
  const connected = useSessionOptional()
  const vacationAvailable = serverSupportsVacation(
    connected?.jmapSession ?? null,
    connected?.accountId ?? null,
  )

  function handleTheme(value: string): void {
    const next = value as ThemeSetting
    setTheme(next)
    setThemeState(next)
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('settings.title')}</h1>

      <Section title={t('settings.general.title')}>
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
      </Section>

      <Section title={t('settings.appearance.title')}>
        <SelectField
          id={ids.theme}
          label={t('theme.label')}
          value={theme}
          options={THEME_OPTIONS.map((value) => ({ value, label: t(`theme.${value}`) }))}
          onChange={handleTheme}
        />
        {replica !== null && <DensityField id={ids.density} />}
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

      {replica !== null && (
        <Section title={t('settings.reading.title')}>
          <ReadingSection />
        </Section>
      )}

      {replica !== null && (
        <Section title={t('settings.swipe.title')}>
          <SwipeSection />
        </Section>
      )}

      {replica !== null && (
        <Section title={t('settings.compose.title')}>
          <ComposeSection />
        </Section>
      )}

      {replica !== null && vacationAvailable && (
        <Section title={t('settings.vacation.title')}>
          <VacationSection />
        </Section>
      )}

      {replica !== null && (
        <Section title={t('notify.title')}>
          <NotificationsSection />
        </Section>
      )}

      {replica !== null && (
        <Section title={t('settings.offline.title')}>
          <StorageSection />
        </Section>
      )}

      {connected !== null && (
        <Section title={t('settings.server.title')}>
          <ServerSection />
        </Section>
      )}

      <Section title={t('settings.about.title')}>
        <BrandLinks />
      </Section>
    </div>
  )
}
