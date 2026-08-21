import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type AccentId, availablePalettes, getAccent, isAccentId, setAccent } from '../app/accent'
import { BrandLinks } from '../app/BrandLinks'
import type { ThemeSetting } from '../app/config'
import { useConfig } from '../app/config-context'
import { Link, settingsPath, useNavigate, useRoute } from '../app/route'
import { useSessionOptional } from '../app/session/context'
import {
  READING_PANE_MODES,
  type ReadingPaneMode,
  setReadingPaneMode,
  useLayoutTier,
  useReadingPaneMode,
} from '../app/shell/layout'
import { getTheme, setTheme } from '../app/theme'
import { supportsScheduledSend } from '../compose/scheduled-send'
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n'
import { ScheduledSends } from '../outbox'
import { setPref, useLocalPref, useReplica, useReplicaOptional } from '../sync'
import { Select } from '../ui'
import { ComposeSection } from './ComposeSection'
import { IdentitiesSection, serverSupportsIdentities } from './IdentitiesSection'
import { NotificationsSection } from './NotificationsSection'
import { ReadingSection } from './ReadingSection'
import { ServerSection } from './ServerSection'
import { StorageSection } from './StorageSection'
import { SwipeSection } from './SwipeSection'
import styles from './settings.module.css'
import { FiltersSection, filtersAvailable } from './sieve/FiltersSection'
import { TemplatesSection } from './TemplatesSection'
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

/** One settings section: a slug the URL can name, a heading, and what it renders. */
interface SettingsSection {
  readonly slug: string
  readonly title: string
  /** False where the server or the session cannot support it — the section then does not exist. */
  readonly available: boolean
  readonly render: () => ReactNode
}

/** A named group of sections; `id` keys `settings.groups.<id>` in the locale files. */
interface SettingsGroup {
  readonly id: 'general' | 'appearance' | 'mail' | 'accounts' | 'system'
  readonly sections: readonly SettingsSection[]
}

/** The id a rail group's label carries, so its list can be named by it. */
function groupLabelId(scope: string, group: string): string {
  return `${scope}-settings-group-${group}`
}

/** The DOM id a `/settings/<slug>` deep link resolves to. */
export function settingsSectionDomId(slug: string): string {
  return `waxwing-settings-${slug}`
}

/** The DOM id of a rail row, so the page can put focus back on the one it left. */
function railItemDomId(scope: string, slug: string): string {
  return `${scope}-settings-rail-${slug}`
}

function Section(props: {
  slug: string
  title: string
  /**
   * Where the panel IS the screen rather than sitting beside the rail — which decides the level of
   * its heading. On a phone the rail is replaced by this panel and the page's only `<h1>` goes with
   * it, so all fourteen sections began at level 2 with no level 1 anywhere on the screen. The
   * heading a screen opens with is the heading OF that screen; which screen this is depends on the
   * layout, so the level does too.
   */
  narrow: boolean
  ref: Ref<HTMLElement>
  children: ReactNode
}) {
  const Heading = props.narrow ? 'h1' : 'h2'
  return (
    // `tabIndex={-1}` so a deep link — or the rail — can put focus here, not merely scroll.
    <section
      ref={props.ref}
      id={settingsSectionDomId(props.slug)}
      className={styles.section}
      aria-label={props.title}
      tabIndex={-1}
    >
      <Heading className={styles.sectionTitle}>{props.title}</Heading>
      {/* `.controls` is the CARD, and this is the only place it is rendered. A section body hands
          it rows; a section body that renders a `.controls` of its own draws a second card inside
          this one (see the class comment in settings.module.css). */}
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
 * actions, Compose, Vacation responder, Notifications, Offline & storage, Server, About. M5.1 adds
 * Identities between Compose and the vacation responder.
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
  const id = useId()
  const ids = {
    theme: useId(),
    language: useId(),
    readingPane: useId(),
    density: useId(),
    accent: useId(),
  }
  const config = useConfig()

  /**
   * `/settings/<slug>` SELECTS that section — it no longer scrolls to it.
   *
   * The router has computed `rest` for this route since M1.4 and `settingsPath(sub)` has been able
   * to build such a path just as long, but nothing read it: `/settings/notifications` rendered the
   * top of a fourteen-section page. It was answered once with a scroll-and-focus effect, which was
   * the right fix for a long page and is the wrong one for this layout — the URL now names the
   * panel on screen, which is also what makes the rail's `aria-current` honest.
   */
  const route = useRoute()
  const navigate = useNavigate()
  const narrow = useLayoutTier() === 'phone'
  const sectionRef = useRef<HTMLElement>(null)

  const [accent, setAccentState] = useState<AccentId>(() => getAccent())
  const replica = useReplicaOptional()
  const connected = useSessionOptional()
  const vacationAvailable = serverSupportsVacation(
    connected?.jmapSession ?? null,
    connected?.accountId ?? null,
  )
  // Identities live under the submission capability, i.e. under "this account can send at all".
  // `connected.accountId` is the user's OWN account, never the delegated one the mail pane may be
  // acting in — ADR-020 is what makes that distinction load-bearing here.
  const identitiesAvailable = serverSupportsIdentities(
    connected?.jmapSession ?? null,
    connected?.accountId ?? null,
  )
  // Messages the server is holding for later delivery (M5.4, FR-CMP-11) — only where it can.
  const scheduleAvailable = supportsScheduledSend(
    connected?.jmapSession ?? null,
    connected?.accountId ?? null,
  )
  // Filters need BOTH the server capability and the hoster's switch (M5.2, FR-SIEVE-01).
  const sieveAvailable = filtersAvailable(
    connected?.jmapSession ?? null,
    connected?.accountId ?? null,
    config,
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

  /**
   * The sections, grouped — the information architecture, in one place.
   *
   * Fourteen sections in one scrolling column is what the owner met: everything present, nothing
   * findable, and on a phone several screen-heights of it with no jump anywhere. The groups are the
   * shape Bulwark and Apple Mail both settle on; the list on the left is the navigation those two
   * have and this had none of.
   *
   * `available` is exactly the condition each section carried before — capability-gated sections
   * still simply do not exist on a server that cannot do them, and an empty group disappears with
   * its last section rather than leaving a heading over nothing.
   */
  const groups: readonly SettingsGroup[] = [
    {
      id: 'general',
      sections: [
        {
          slug: 'general',
          title: t('settings.general.title'),
          available: true,
          render: () => (
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
          ),
        },
        {
          slug: 'notifications',
          title: t('notify.title'),
          available: replica !== null,
          render: () => <NotificationsSection />,
        },
      ],
    },
    {
      id: 'appearance',
      sections: [
        {
          slug: 'appearance',
          title: t('settings.appearance.title'),
          available: true,
          render: () => (
            <>
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
            </>
          ),
        },
        {
          // A device-input preference, not a mail one — which is why it sits with Appearance rather
          // than under Mail, where it would be the only setting that is about the finger.
          slug: 'swipe',
          title: t('settings.swipe.title'),
          available: replica !== null,
          render: () => <SwipeSection />,
        },
      ],
    },
    {
      id: 'mail',
      sections: [
        {
          slug: 'reading',
          title: t('settings.reading.title'),
          available: replica !== null,
          render: () => <ReadingSection />,
        },
        {
          slug: 'compose',
          title: t('settings.compose.title'),
          available: replica !== null,
          render: () => <ComposeSection />,
        },
        {
          slug: 'templates',
          title: t('settings.templates.title'),
          available: replica !== null,
          render: () => <TemplatesSection />,
        },
        {
          slug: 'scheduled',
          title: t('outbox.scheduled.title'),
          available: connected !== null && scheduleAvailable,
          render: () => (
            // One row: the sentence is the caption for the list under it, and a rule between the
            // two would present them as two unrelated settings.
            <div className={styles.group}>
              <p className={styles.hint}>{t('outbox.scheduled.description')}</p>
              <ScheduledSends />
            </div>
          ),
        },
      ],
    },
    {
      id: 'accounts',
      sections: [
        {
          slug: 'identities',
          title: t('settings.identities.title'),
          available: replica !== null && identitiesAvailable,
          render: () => <IdentitiesSection />,
        },
        {
          slug: 'vacation',
          title: t('settings.vacation.title'),
          available: replica !== null && vacationAvailable,
          render: () => <VacationSection />,
        },
        {
          slug: 'filters',
          title: t('settings.filters.title'),
          available: replica !== null && sieveAvailable,
          render: () => <FiltersSection />,
        },
      ],
    },
    {
      id: 'system',
      sections: [
        {
          slug: 'offline',
          title: t('settings.offline.title'),
          available: replica !== null,
          render: () => <StorageSection />,
        },
        {
          slug: 'server',
          title: t('settings.server.title'),
          available: connected !== null,
          render: () => <ServerSection />,
        },
        {
          slug: 'about',
          title: t('settings.about.title'),
          available: true,
          render: () => (
            <div className={styles.group}>
              {/* The version is not decoration: it is the first thing any support exchange needs,
                  and a static deployment has no other way to say which build it is running (M4.5). */}
              <p className={styles.aboutVersion}>
                {t('settings.about.version', { version: APP_VERSION })}
              </p>
              <BrandLinks />
            </div>
          ),
        },
      ],
    },
  ]

  const shown = groups
    .map((group) => ({ ...group, sections: group.sections.filter((s) => s.available) }))
    .filter((group) => group.sections.length > 0)
  const all = shown.flatMap((group) => group.sections)
  const active = all.find((section) => section.slug === route.rest)
  /**
   * With room for both columns, landing on `/settings` shows the first section rather than an empty
   * panel — the reader asked for settings, not for a menu. On a phone there IS no second column, so
   * the list is the screen and a section replaces it (the Master/Detail pattern Bulwark uses, and
   * the one the drawer and the reading pane already use here).
   */
  const detail = active ?? (narrow ? undefined : all[0])

  /**
   * A slug that names no section rewrites the address instead of quietly disagreeing with it.
   *
   * `/settings/gibtsnicht` rendered the first section and marked it `aria-current="page"` while the
   * address bar kept the name of a section that does not exist — so the URL and the only thing on
   * screen said different things, and a bookmark of it was wrong without ever saying so. `replace`,
   * not a push: a mistyped address is not a place the reader should be able to go Back to.
   *
   * Measured against EVERY slug, not against the available ones. A section that exists but is
   * capability-gated off on this server is not a typo, and treating it as one would mean racing the
   * session and the replica: a deep link to `/settings/server` would be thrown away in whatever
   * frames pass before the session arrives. "Not a section at all" is a fact about this build and
   * cannot change under us.
   */
  const known = groups.some((group) => group.sections.some((s) => s.slug === route.rest))
  useEffect(() => {
    if (route.rest !== '' && !known) navigate(settingsPath(), { replace: true })
  }, [route.rest, known, navigate])

  /**
   * Focus follows the navigation, in both directions.
   *
   * The `tabIndex={-1}` on the section has been there since M1.4 to make this possible and nothing
   * ever called `focus()`, so `document.activeElement` was `<body>` after every section change. On
   * a phone that is not a nicety: opening a section REMOVES the rail from the DOM, taking the
   * focused `<a>` with it, and the reader is dropped back at the top of the document to walk
   * through the header and the main navigation again — after every single section they open.
   *
   * Going back is the mirror image, and the mirror image is what makes it feel like a place rather
   * than a reload: focus returns to the row that was left, not to the top of the list.
   *
   * The first paint is deliberately exempt. Landing on `/settings` shows a section because there is
   * room for one, which is not the reader asking to be put inside it — a screen that seizes focus
   * as it loads takes it away from whatever the reader was doing to get there.
   */
  const shownSlug = detail?.slug
  const settled = useRef(false)
  const previousSlug = useRef<string | undefined>(undefined)
  useEffect(() => {
    const previous = previousSlug.current
    previousSlug.current = shownSlug
    if (!settled.current) {
      settled.current = true
      return
    }
    if (previous === shownSlug) return
    if (shownSlug !== undefined) {
      sectionRef.current?.focus()
    } else if (previous !== undefined) {
      document.getElementById(railItemDomId(id, previous))?.focus()
    }
  }, [shownSlug, id])

  return (
    <div className={styles.page}>
      {(!narrow || detail === undefined) && (
        // A <div> holding the title and a <nav> beside it, rather than a <nav> holding the title:
        // the landmark must not be named after a heading it contains (see `.railNav`).
        <div className={styles.rail}>
          <h1 className={styles.title}>{t('settings.title')}</h1>
          <nav className={styles.railNav} aria-label={t('settings.title')}>
            {shown.map((group) => (
              <div key={group.id} className={styles.railGroup}>
                {/* A LABEL for its list, not a heading: the only heading levels on this screen are
                    the page title and the open section's, and a rail full of h2s would put nine of
                    them between the two for anyone navigating by heading. `aria-labelledby` gives
                    the list the same name without the outline. */}
                <span id={groupLabelId(id, group.id)} className={styles.railGroupTitle}>
                  {t(`settings.groups.${group.id}`)}
                </span>
                <ul className={styles.railList} aria-labelledby={groupLabelId(id, group.id)}>
                  {group.sections.map((section) => (
                    <li key={section.slug}>
                      <Link
                        id={railItemDomId(id, section.slug)}
                        to={settingsPath(section.slug)}
                        className={styles.railItem}
                        aria-current={detail?.slug === section.slug ? 'page' : undefined}
                      >
                        <span className={styles.railItemLabel}>{section.title}</span>
                        {/* Only where the rail IS the screen. Where the panel sits beside it, the
                            selected row is marked by its own fill and a chevron pointing at content
                            that is already visible would be pointing at nothing. On a phone the
                            rail is a list of destinations with no other sign that it is one —
                            measured on 390px it was thirteen lines of plain text with neither rule
                            nor chevron between them. */}
                        {narrow && (
                          <ChevronRight aria-hidden="true" className={styles.railChevron} />
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      )}

      {detail !== undefined && (
        <div className={styles.detail}>
          {narrow && (
            // The phone's way back to the list. On the wide layout the rail is right there, so a
            // back link would point at something already on screen.
            <Link to={settingsPath()} className={styles.detailBack}>
              <ChevronLeft aria-hidden="true" />
              {t('settings.title')}
            </Link>
          )}
          <Section ref={sectionRef} slug={detail.slug} title={detail.title} narrow={narrow}>
            {detail.render()}
          </Section>
        </div>
      )}
    </div>
  )
}
