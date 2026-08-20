import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

/**
 * The message a surface shows when it has nothing to show — and, when there is one, the way out.
 *
 * There were thirty of these, hand-built, under nine class names across eight stylesheets, and
 * they had drifted in every dimension a paragraph can drift in: left-aligned in the message list,
 * centred in the contact list, centred at a larger size in files and calendar, and centred both
 * ways in the shell. Three of them are visible at once on the contacts screen, in three different
 * alignments. Not one had an icon, a heading, or a button — including the ones whose text told the
 * reader to go press a button somewhere else.
 *
 * Three deliberate choices:
 *
 * **`tone`, not a second component.** A surface with nothing in it and a surface that failed to
 * load are different states, and three screens rendered them through the SAME class — so a server
 * error looked exactly like an empty folder, with no colour, no retry, and no way to tell which
 * had happened. `tone="error"` is what makes that distinction available at every call site rather
 * than only where someone remembered.
 *
 * **An action, not just a sentence about one.** "No contacts yet. Use + above to add your first"
 * is a sentence pointing at a control the reader now has to find — and one that is disabled when
 * no writable book exists, so the instruction can be wrong. Where the action is possible it
 * belongs here; where it is not, the caller passes no action and says nothing about it.
 *
 * **Compact where it is not the whole surface.** A rail section with no labels yet is a line of
 * text inside a column of other things; a whole pane with nothing in it can afford the centred
 * treatment. One component, two densities, rather than nine classes.
 */
export interface EmptyStateProps {
  /** The state itself: `empty` is "nothing here", `error` is "this did not work". */
  readonly tone?: 'empty' | 'error'
  /** Optional mark. Skipped in `compact`, where it would outweigh the text beside it. */
  readonly icon?: LucideIcon
  /** The one-line statement. Required: a blank surface with no words is the defect this replaces. */
  readonly title: string
  /** An optional second line — why, or what happens next. */
  readonly description?: string
  /** The way out, where there is one: a Retry, a Create, a Connect. */
  readonly action?: ReactNode
  /** `compact` for a section inside a larger surface; `pane` (default) for a whole one. */
  readonly density?: 'compact' | 'pane'
}

export function EmptyState({
  tone = 'empty',
  icon: Icon,
  title,
  description,
  action,
  density = 'pane',
}: EmptyStateProps) {
  const compact = density === 'compact'
  return (
    <div
      className={[
        styles.root,
        compact ? styles.compact : styles.pane,
        tone === 'error' ? styles.error : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // An error is worth announcing; an empty folder is the expected outcome of a navigation and
      // announcing it would talk over the reader.
      {...(tone === 'error' ? { role: 'alert' } : {})}
    >
      {Icon !== undefined && !compact ? <Icon aria-hidden="true" className={styles.icon} /> : null}
      <p className={styles.title}>{title}</p>
      {description !== undefined && <p className={styles.description}>{description}</p>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  )
}
