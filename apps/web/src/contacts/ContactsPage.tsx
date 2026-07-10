import { useTranslation } from 'react-i18next'
import styles from './contacts.module.css'

/**
 * Contacts route screen (lazy chunk). A localized placeholder for M1.4 — the real
 * contacts area lands in M4.2. Default export so `React.lazy(() => import(...))` can load it.
 */
export default function ContactsPage() {
  const { t } = useTranslation()
  return (
    <section className={styles.page} aria-labelledby="contacts-heading">
      <h1 id="contacts-heading" className={styles.title}>
        {t('contacts.title')}
      </h1>
      <p className={styles.placeholder}>{t('contacts.placeholder')}</p>
    </section>
  )
}
