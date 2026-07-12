/**
 * A self-contained "Label" trigger (M3.2): an icon button that opens the {@link LabelMenu} picker
 * anchored to itself. Used by the message-list bulk bar and the reading-view action bar; the list's
 * `l` shortcut uses {@link LabelMenu} directly with its own anchor.
 */

import type { Id } from '@waxwing/jmap'
import { Tag } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ButtonSize, IconButton } from '../../ui'
import { LabelMenu } from './LabelMenu'

export interface LabelMenuButtonProps {
  readonly ids: Id[]
  readonly size?: ButtonSize
}

export function LabelMenuButton({ ids, size }: LabelMenuButtonProps) {
  const { t } = useTranslation()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        ref={anchorRef}
        label={t('labels.assign')}
        variant="ghost"
        {...(size ? { size } : {})}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Tag />
      </IconButton>
      {open && <LabelMenu ids={ids} anchorRef={anchorRef} onClose={() => setOpen(false)} />}
    </>
  )
}
