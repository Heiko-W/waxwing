import { Archive, Bell, Star, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useId, useState } from 'react'
import { Avatar } from '../Avatar'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Checkbox } from '../Checkbox'
import { Dialog } from '../Dialog'
import { IconButton } from '../IconButton'
import { Menu } from '../Menu'
import { Select } from '../Select'
import { Skeleton } from '../Skeleton'
import { Spinner } from '../Spinner'
import { SplitPane } from '../SplitPane'
import { Switch } from '../Switch'
import { TextInput } from '../TextInput'
import { ToastProvider, useToast } from '../Toast'
import { Tooltip } from '../Tooltip'
import styles from './gallery.module.css'

/**
 * Dev-only component gallery (M1.1 "Done when": all base components shown in light/dark with
 * zero axe violations). Not shipped — it mounts only under `VITE_WAXWING_GALLERY=1` in the
 * dev server and is dead-code-eliminated from production builds (see src/main.tsx). Section
 * copy is intentionally plain English here (dev tooling), while the components themselves
 * still resolve their own labels through i18n.
 */

type ThemeChoice = 'auto' | 'light' | 'dark'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.row}>{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      {children(id)}
    </div>
  )
}

function ToastButtons() {
  const { toast } = useToast()
  return (
    <>
      <Button onClick={() => toast({ title: 'Message sent', tone: 'success' })}>
        Success toast
      </Button>
      <Button onClick={() => toast({ title: 'Draft saved' })}>Neutral toast</Button>
      <Button
        variant="destructive"
        onClick={() =>
          toast({ title: 'Send failed', description: 'Check your connection.', tone: 'danger' })
        }
      >
        Error toast
      </Button>
    </>
  )
}

export function Gallery() {
  const [theme, setThemeChoice] = useState<ThemeChoice>('auto')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [notify, setNotify] = useState(true)
  const [remember, setRemember] = useState(false)
  const closeDialog = useCallback(() => setDialogOpen(false), [])

  function applyTheme(next: ThemeChoice): void {
    setThemeChoice(next)
    const root = document.documentElement
    if (next === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)
  }

  const menuItems = [
    { id: 'archive', label: 'Archive', icon: Archive, onSelect: () => {} },
    { id: 'star', label: 'Add star', icon: Star, onSelect: () => {} },
    { id: 'delete', label: 'Delete', icon: Trash2, onSelect: () => {}, destructive: true },
  ]

  return (
    <ToastProvider>
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Waxwing design system</h1>
          <fieldset className={styles.themeSwitch} aria-label="Preview theme">
            {(['auto', 'light', 'dark'] as const).map((choice) => (
              <Button
                key={choice}
                size="sm"
                variant={theme === choice ? 'primary' : 'secondary'}
                aria-pressed={theme === choice}
                onClick={() => applyTheme(choice)}
              >
                {choice}
              </Button>
            ))}
          </fieldset>
        </header>

        <main className={styles.main}>
          <Section title="Buttons">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="primary" loading>
              Loading
            </Button>
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Button variant="secondary" size="sm">
              Small
            </Button>
          </Section>

          <Section title="Icon buttons & menu">
            <IconButton label="Archive">
              <Archive />
            </IconButton>
            <IconButton label="Notifications" variant="secondary">
              <Bell />
            </IconButton>
            <Tooltip content="Move to trash">
              <IconButton label="Delete" variant="ghost">
                <Trash2 />
              </IconButton>
            </Tooltip>
            <Menu triggerLabel="Message actions" trigger="Actions" items={menuItems} />
          </Section>

          <Section title="Form controls">
            <Field label="Subject">
              {(id) => <TextInput id={id} placeholder="Weekly report" />}
            </Field>
            <Field label="Email (invalid)">
              {(id) => <TextInput id={id} defaultValue="not-an-email" invalid />}
            </Field>
            <Field label="Sort by">
              {(id) => (
                <Select id={id} defaultValue="date">
                  <option value="date">Date</option>
                  <option value="from">From</option>
                  <option value="subject">Subject</option>
                </Select>
              )}
            </Field>
            <Checkbox
              label="Remember me"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <Checkbox label="Partial selection" indeterminate />
            <Switch label="Notify on new mail" checked={notify} onCheckedChange={setNotify} />
          </Section>

          <Section title="Data & feedback">
            <Avatar name="Bob Baker" size="sm" />
            <Avatar name="Carol Danvers" />
            <Avatar name="alice@waxwing.test" size="lg" />
            <Badge tone="neutral">24</Badge>
            <Badge tone="accent">9</Badge>
            <Badge tone="danger">3</Badge>
            <Badge tone="success">OK</Badge>
            <Badge tone="warning">!</Badge>
            <Spinner />
            <Skeleton width={160} height={16} />
            <Skeleton width={40} height={40} circle />
          </Section>

          <Section title="Overlays">
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
            <ToastButtons />
          </Section>

          <Section title="Split pane">
            <div className={styles.splitHost}>
              <SplitPane
                label="Resize list pane"
                defaultPrimarySize={220}
                minPrimarySize={140}
                maxPrimarySize={360}
              >
                <div className={styles.pane}>Message list</div>
                <div className={styles.pane}>Reading pane</div>
              </SplitPane>
            </div>
          </Section>
        </main>

        <Dialog
          open={dialogOpen}
          onClose={closeDialog}
          title="Delete conversation?"
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={closeDialog}>
                Delete
              </Button>
            </>
          }
        >
          <p className={styles.dialogBody}>
            This permanently removes the conversation and its messages. This cannot be undone.
          </p>
        </Dialog>
      </div>
    </ToastProvider>
  )
}
