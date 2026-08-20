/**
 * Label sidebar container (M3.2). Binds {@link useLabels}/{@link useLabelActions} to {@link LabelList},
 * owns the create/rename/recolor/delete dialogs, and routes selection to `/mail?label=<keyword>` (the
 * M3.1 query-window seam — not a fake folder). Mirrors {@link FolderTree}. Recoloring a discovered
 * (unregistered) label registers it with the chosen color; deleting is non-destructive by default
 * with an optional "also remove from N known messages" strip.
 */

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useRoute } from '../../app/route'
import { countEmailsWithKeyword, useReplicaQuery } from '../../sync'
import { Button, Checkbox, Dialog, EmptyState, IconButton, Spinner } from '../../ui'
import { LabelFormDialog } from './LabelFormDialog'
import { LabelList } from './LabelList'
import styles from './labels.module.css'
import { type LabelSummary, useLabelActions, useLabels } from './use-labels'

type LabelDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly label: LabelSummary }
  | { readonly kind: 'recolor'; readonly label: LabelSummary }
  | { readonly kind: 'delete'; readonly label: LabelSummary }

export interface LabelsProps {
  /** Fired on every label pick, including a re-pick of the active one — see FolderTreeProps. */
  readonly onNavigate?: (() => void) | undefined
}

export function Labels({ onNavigate }: LabelsProps = {}) {
  const { t } = useTranslation()
  const labels = useLabels()
  const actions = useLabelActions()
  const route = useRoute()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<LabelDialog | null>(null)

  const activeLabel = route.search.get('label') ?? undefined
  // B20.8, as in `FolderTree`: nothing on screen and nothing announced is indistinguishable from
  // an account with no labels.
  if (labels === undefined) {
    return (
      <div className={styles.loading}>
        <Spinner size="sm" label={t('labels.loading')} />
      </div>
    )
  }

  // Only registered labels constrain a NEW slug (a discovered keyword becomes registered on "add").
  const existingKeywords = labels.filter((label) => !label.discovered).map((label) => label.keyword)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t('labels.title')}</span>
        <IconButton
          label={t('labels.new')}
          variant="ghost"
          size="sm"
          onClick={() => setDialog({ kind: 'create' })}
        >
          <Plus />
        </IconButton>
      </div>

      {labels.length === 0 ? (
        // The action, rather than a sentence pointing at the `+` above. The text used to read
        // "No labels yet. Use + to create one." — an instruction to go find a control.
        <EmptyState
          density="compact"
          title={t('labels.empty')}
          action={
            <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'create' })}>
              {t('labels.new')}
            </Button>
          }
        />
      ) : (
        <LabelList
          labels={labels}
          activeKeyword={activeLabel}
          onSelect={(keyword) => {
            // Re-picking the active label changes nothing, so it must not push a duplicate history
            // entry — but it still has to close the drawer on a narrow screen.
            if (keyword !== activeLabel) navigate(`/mail?label=${encodeURIComponent(keyword)}`)
            onNavigate?.()
          }}
          onRename={(label) => setDialog({ kind: 'rename', label })}
          onRecolor={(label) => setDialog({ kind: 'recolor', label })}
          onDelete={(label) => setDialog({ kind: 'delete', label })}
          onAddToLabels={(label) => actions.register(label.keyword, label.name, label.color)}
        />
      )}

      {labels.some((label) => label.discovered) && (
        <p className={styles.hint}>{t('labels.discoveredHint')}</p>
      )}

      {dialog?.kind === 'create' && (
        <LabelFormDialog
          mode="create"
          existingKeywords={existingKeywords}
          onClose={() => setDialog(null)}
          onSubmit={(name, color) => {
            actions.create(name, color)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <LabelFormDialog
          mode="rename"
          initialName={dialog.label.name}
          initialColor={dialog.label.color}
          existingKeywords={existingKeywords}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            actions.renameDisplay(dialog.label.keyword, name)
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'recolor' && (
        <LabelFormDialog
          mode="recolor"
          initialName={dialog.label.name}
          initialColor={dialog.label.color}
          existingKeywords={existingKeywords}
          onClose={() => setDialog(null)}
          onSubmit={(_name, color) => {
            if (dialog.label.discovered) {
              actions.register(dialog.label.keyword, dialog.label.name, color)
            } else {
              actions.recolor(dialog.label.keyword, color)
            }
            setDialog(null)
          }}
        />
      )}

      {dialog?.kind === 'delete' && (
        <DeleteLabelDialog
          label={dialog.label}
          onClose={() => setDialog(null)}
          onConfirm={(alsoStrip) => {
            actions.remove(dialog.label.keyword, { alsoStrip })
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}

interface DeleteLabelDialogProps {
  readonly label: LabelSummary
  readonly onClose: () => void
  readonly onConfirm: (alsoStrip: boolean) => void
}

function DeleteLabelDialog({ label, onClose, onConfirm }: DeleteLabelDialogProps) {
  const { t } = useTranslation()
  const [alsoStrip, setAlsoStrip] = useState(false)
  // `count()` over the index range, not `toArray().length`: this dialog only needs the number, and
  // the previous form deserialized every carrier's envelope to throw all of them away.
  const knownCount =
    useReplicaQuery(
      ({ db, accountId }) => countEmailsWithKeyword(db, accountId, label.keyword),
      [label.keyword],
    ) ?? 0

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('labels.delete.title')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('mailbox.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(alsoStrip)}>
            {t('labels.delete.confirm')}
          </Button>
        </>
      }
    >
      <p>{t('labels.delete.message', { name: label.name })}</p>
      {knownCount > 0 && (
        <Checkbox
          label={t('labels.delete.alsoStrip', { count: knownCount })}
          checked={alsoStrip}
          onChange={(event) => setAlsoStrip(event.target.checked)}
        />
      )}
    </Dialog>
  )
}
