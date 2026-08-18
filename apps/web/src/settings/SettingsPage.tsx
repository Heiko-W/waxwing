import { type ReactNode, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type AccentId, availablePalettes, getAccent, isAccentId, setAccent } from '../app/accent'
import { BrandLinks } from '../app/BrandLinks'
import type { ThemeSetting } from '../app/config'
import { useConfig } from '../app/config-context'
import { useRoute } from '../app/route'
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

/** Injected by vite from apps/web/package.json — see its `define` block. */
const APP_VERSION = __WAXWING_VERSION__

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

/** The DOM id a `/settings/<slug>` deep link resolves to. */
export function settingsSectionDomId(slug: string): string {
  return `waxwing-settings-${slug}`
}

function Section(props: { slug: string; title: string; children: ReactNode }) {
  return (
    // `tabIndex={-1}` so a deep link can put focus here, not merely scroll — otherwise a keyboard
    // user lands at the top of the page and has to travel back down to what they asked for.
    <section
      id={settingsSectionDomId(props.slug)}
      className={styles.section}
      aria-label={props.title}
      tabIndex={-1}
    >
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
  const ids = {
    theme: useId(),
    language: useId(),
    readingPane: useId(),
    density: useId(),
    accent: useId(),
  }
  const config = useConfig()

  /**
   * `/settings/<slug>` jumps to that section.
   *
   * The router has computed `rest` for this route since M1.4 and `settingsPath(sub)` has been able
   * to BUILD such a path just as long — but nothing ever read it, so `/settings/notifications`
   * silently rendered the top of a ten-section page. Dead infrastructure that looks like a feature:
   * a link, a help reference or a notification could point at a section and appear to work.
   *
   * Focus as well as scroll, or a keyboard user arrives at the top of the page and has to travel
   * back down to the thing they asked for.
   */
  const route = useRoute()
  useEffect(() => {
    if (route.rest === '') return
    const target = document.getElementById(settingsSectionDomId(route.rest))
    if (target === null) return
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
  }, [route.rest])

  const [accent, setAccentState] = useState<AccentId>(() => getAccent())
  const replica = useReplicaOptional()
  const connected = useSessionOptional()
  const vacationAvailable = serverSupportsVacation(
    connected?.jmapSession ?? null,
    connected?.accountId ?? null,
  )

  function handleAccent(value: string): void {
    if (!isAccentId(value)) return
    setAccent(value)
    setAccentState(value)
  }

  function handleTheme(value: string): void {
    const next = value as ThemeSetting
    setTheme(next)
    setThemeState(next)
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('settings.title')}</h1>

      <Section slug="general" title={t('settings.general.title')}>
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

      <Section slug="appearance" title={t('settings.appearance.title')}>
        <SelectField
          id={ids.theme}
          label={t('theme.label')}
          value={theme}
          options={THEME_OPTIONS.map((value) => ({ value, label: t(`theme.${value}`) }))}
          onChange={handleTheme}
        />
        {!config.branding.accentLocked && (
          <SelectField
            id={ids.accent}
            label={t('settings.appearance.accent.label')}
            value={accent}
            options={availablePalettes(config.branding.accentPalettes).map((palette) => ({
              value: palette.id,
              label: t(`settings.appearance.accent.${palette.id}`),
            }))}
            onChange={handleAccent}
          />
        )}
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
        <Section slug="reading" title={t('settings.reading.title')}>
          <ReadingSection />
        </Section>
      )}

      {replica !== null && (
        <Section slug="swipe" title={t('settings.swipe.title')}>
          <SwipeSection />
        </Section>
      )}

      {replica !== null && (
        <Section slug="compose" title={t('settings.compose.title')}>
          <ComposeSection />
        </Section>
      )}

      {replica !== null && vacationAvailable && (
        <Section slug="vacation" title={t('settings.vacation.title')}>
          <VacationSection />
        </Section>
      )}

      {replica !== null && (
        <Section slug="notifications" title={t('notify.title')}>
          <NotificationsSection />
        </Section>
      )}

      {replica !== null && (
        <Section slug="offline" title={t('settings.offline.title')}>
          <StorageSection />
        </Section>
      )}

      {connected !== null && (
        <Section slug="server" title={t('settings.server.title')}>
          <ServerSection />
        </Section>
      )}

      <Section slug="about" title={t('settings.about.title')}>
        {/* The version is not decoration: it is the first thing any support exchange needs, and a
            static deployment has no other way to say which build it is running (M4.5). */}
        <p className={styles.aboutVersion}>
          {t('settings.about.version', { version: APP_VERSION })}
        </p>
        <BrandLinks />
      </Section>
    </div>
  )
}
