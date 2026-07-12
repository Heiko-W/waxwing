/**
 * Shared create/rename/recolor dialog for labels (M3.2). One small form covers all three modes:
 *  - `create`  — name + color, validated (slug/length/collision) against the existing keywords;
 *  - `rename`  — name only (the wire keyword is immutable, so only non-empty is enforced);
 *  - `recolor` — color only.
 * Used by both the sidebar {@link Labels} container and the {@link LabelMenu}'s "New label…" entry.
 */

import { type FormEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, TextInput } from '../../ui'
import { LABEL_COLORS, type LabelColor, MAX_KEYWORD_LENGTH, validateLabelName } from './label-model'
import styles from './labels.module.css'

export type LabelFormMode = 'create' | 'rename' | 'recolor'

export interface LabelFormDialogProps {
  readonly mode: LabelFormMode
  readonly initialName?: string
  readonly initialColor?: LabelColor
  /** Existing label keywords, for the create-collision check. */
  readonly existingKeywords: readonly string[]
  readonly onClose: () => void
  readonly onSubmit: (name: string, color: LabelColor) => void
}

interface ColorPickerProps {
  readonly value: LabelColor
  readonly name: string
  readonly onChange: (color: LabelColor) => void
}

function ColorPicker({ value, name, onChange }: ColorPickerProps) {
  const { t } = useTranslation()
  return (
    <div
      role="radiogroup"
      aria-label={t('labels.create.colorLabel')}
      className={styles.colorPicker}
    >
      {LABEL_COLORS.map((color) => (
        <label key={color} className={styles.colorOption}>
          <input
            type="radio"
            name={name}
            className={styles.colorInput}
            checked={value === color}
            onChange={() => onChange(color)}
            aria-label={t(`labels.color.${color}`)}
          />
          <span
            aria-hidden="true"
            className={styles.colorDot}
            style={{ backgroundColor: `var(--waxwing-label-${color})` }}
          />
        </label>
      ))}
    </div>
  )
}

export function LabelFormDialog({
  mode,
  initialName,
  initialColor,
  existingKeywords,
  onClose,
  onSubmit,
}: LabelFormDialogProps) {
  const { t } = useTranslation()
  const formId = useId()
  const errorId = useId()
  const groupName = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initialName ?? '')
  const [color, setColor] = useState<LabelColor>(initialColor ?? 'blue')
  const [error, setError] = useState<string | null>(null)

  const showName = mode !== 'recolor'
  const showColor = mode !== 'rename'
  const title =
    mode === 'create'
      ? t('labels.create.title')
      : mode === 'rename'
        ? t('labels.rename.title')
        : t('labels.recolor.title')
  const submitLabel =
    mode === 'create'
      ? t('labels.create.submit')
      : mode === 'rename'
        ? t('labels.rename.submit')
        : t('labels.save')

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (showName) {
      // Rename edits the display name only (keyword immutable) → non-empty is the only rule.
      const failure =
        mode === 'rename'
          ? name.trim() === ''
            ? 'empty'
            : null
          : validateLabelName(name, existingKeywords)
      if (failure !== null) {
        setError(t(`labels.error.${failure}`))
        return
      }
    }
    onSubmit(showName ? name.trim() : (initialName ?? ''), color)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      {...(showName ? { initialFocusRef: inputRef } : {})}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('mailbox.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.form}>
        {showName && (
          <div className={styles.form}>
            <label htmlFor={`${formId}-name`} className={styles.formLabel}>
              {t('labels.create.nameLabel')}
            </label>
            <TextInput
              id={`${formId}-name`}
              ref={inputRef}
              value={name}
              maxLength={MAX_KEYWORD_LENGTH * 4}
              invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value)
                if (error !== null) setError(null)
              }}
            />
            {error !== null && (
              <p id={errorId} className={styles.formError}>
                {error}
              </p>
            )}
          </div>
        )}
        {showColor && (
          <div className={styles.form}>
            <span className={styles.formLabel}>{t('labels.create.colorLabel')}</span>
            <ColorPicker value={color} name={groupName} onChange={setColor} />
          </div>
        )}
      </form>
    </Dialog>
  )
}
