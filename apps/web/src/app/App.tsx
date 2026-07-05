import { Languages, type LucideIcon, Mail, Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n'
import styles from './App.module.css'
import type { ThemeSetting, WaxwingConfig } from './config'
import { getTheme, setTheme } from './theme'

interface AppProps {
  config: WaxwingConfig
}

const THEME_OPTIONS: { value: ThemeSetting; Icon: LucideIcon }[] = [
  { value: 'auto', Icon: Monitor },
  { value: 'light', Icon: Sun },
  { value: 'dark', Icon: Moon },
]

export function App({ config }: AppProps) {
  const { t, i18n } = useTranslation()
  const [theme, setThemeState] = useState<ThemeSetting>(() => getTheme())
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language

  function handleThemeChange(next: ThemeSetting): void {
    setTheme(next)
    setThemeState(next)
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <Mail aria-hidden="true" className={styles.brandIcon} />
          <span className={styles.brandName}>{config.branding.productName}</span>
        </div>

        <div className={styles.controls}>
          <fieldset className={styles.switch} aria-label={t('theme.label')}>
            {THEME_OPTIONS.map(({ value, Icon }) => (
              <button
                key={value}
                type="button"
                className={styles.switchButton}
                aria-label={t(`theme.${value}`)}
                aria-pressed={theme === value}
                onClick={() => handleThemeChange(value)}
              >
                <Icon aria-hidden="true" className={styles.switchIcon} />
              </button>
            ))}
          </fieldset>

          <fieldset className={styles.switch} aria-label={t('language.label')}>
            <Languages aria-hidden="true" className={styles.switchIcon} />
            {SUPPORTED_LANGUAGES.map((lng: SupportedLanguage) => (
              <button
                key={lng}
                type="button"
                className={styles.switchButton}
                aria-label={t(`language.${lng}`)}
                aria-pressed={activeLanguage === lng}
                onClick={() => {
                  void changeLanguage(lng)
                }}
              >
                {t(`language.short.${lng}`)}
              </button>
            ))}
          </fieldset>
        </div>
      </header>

      <main className={styles.main}>
        <nav className={styles.sidebar} aria-label={t('shell.nav')}>
          <span className={styles.sidebarPlaceholder}>{t('shell.placeholder')}</span>
        </nav>
        <section className={styles.content}>
          <h1 className={styles.tagline}>
            {t('shell.tagline', { product: config.branding.productName })}
          </h1>
          <p className={styles.lead}>{t('shell.placeholder')}</p>
        </section>
      </main>
    </div>
  )
}
