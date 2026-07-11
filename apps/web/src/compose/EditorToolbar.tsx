/**
 * Formatting toolbar for {@link RichTextEditor} (M2.1, FR-CMP-01). An APG **toolbar**: one tab stop
 * with roving focus (ArrowLeft/Right/Home/End move between controls, mirroring the folder tree's
 * roving idiom). Toggle buttons expose their state via `aria-pressed` fed from {@link ActiveFormats};
 * the link button opens a small Dialog for the URL (or removes an active link). In plain-text mode
 * only the mode toggle is shown — there is nothing to format.
 *
 * Font-size / colour controls are intentionally out of scope for M2.1 (kept a clean all-button
 * roving group); `EditorEngine.setFontSize` exists for a later composer iteration.
 */

import { Bold, Italic, Link2, List, ListOrdered, Quote, Type, Underline } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '../ui'
import styles from './editor.module.css'
import type { ActiveFormats } from './editor-engine'

/** The formatting actions the toolbar can invoke (implemented by {@link RichTextEditor}). */
export interface ToolbarCommands {
  toggleBold(): void
  toggleItalic(): void
  toggleUnderline(): void
  toggleUnorderedList(): void
  toggleOrderedList(): void
  toggleQuote(): void
  removeLink(): void
}

export interface EditorToolbarProps {
  readonly active: ActiveFormats
  readonly plainText: boolean
  /** Format controls are disabled until the async engine has mounted. */
  readonly busy: boolean
  readonly commands: ToolbarCommands
  /** Open the link editor (the dialog is owned by {@link RichTextEditor} so ⌘K can open it too). */
  readonly onRequestLink: () => void
  readonly onTogglePlainText: () => void
}

interface ToolButton {
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly pressed: boolean
  readonly onClick: () => void
}

export function EditorToolbar({
  active,
  plainText,
  busy,
  commands,
  onRequestLink,
  onTogglePlainText,
}: EditorToolbarProps) {
  const { t } = useTranslation()

  const modeButton: ToolButton = {
    key: 'mode',
    label: plainText ? t('compose.richTextMode') : t('compose.plainTextMode'),
    icon: <Type />,
    pressed: plainText,
    onClick: onTogglePlainText,
  }

  const buttons: ToolButton[] = plainText
    ? [modeButton]
    : [
        {
          key: 'bold',
          label: t('compose.bold'),
          icon: <Bold />,
          pressed: active.bold,
          onClick: commands.toggleBold,
        },
        {
          key: 'italic',
          label: t('compose.italic'),
          icon: <Italic />,
          pressed: active.italic,
          onClick: commands.toggleItalic,
        },
        {
          key: 'underline',
          label: t('compose.underline'),
          icon: <Underline />,
          pressed: active.underline,
          onClick: commands.toggleUnderline,
        },
        {
          key: 'ul',
          label: t('compose.bulletList'),
          icon: <List />,
          pressed: active.unorderedList,
          onClick: commands.toggleUnorderedList,
        },
        {
          key: 'ol',
          label: t('compose.numberedList'),
          icon: <ListOrdered />,
          pressed: active.orderedList,
          onClick: commands.toggleOrderedList,
        },
        {
          key: 'quote',
          label: t('compose.quote'),
          icon: <Quote />,
          pressed: active.quote,
          onClick: commands.toggleQuote,
        },
        {
          key: 'link',
          label: active.link ? t('compose.removeLink') : t('compose.insertLink'),
          icon: <Link2 />,
          pressed: active.link,
          onClick: () => (active.link ? commands.removeLink() : onRequestLink()),
        },
        modeButton,
      ]

  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusIndex, setFocusIndex] = useState(0)
  useEffect(() => {
    if (focusIndex > buttons.length - 1) setFocusIndex(0)
  }, [buttons.length, focusIndex])

  function focusAt(index: number): void {
    const clamped = (index + buttons.length) % buttons.length
    setFocusIndex(clamped)
    refs.current[clamped]?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        focusAt(focusIndex + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        focusAt(focusIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        focusAt(0)
        break
      case 'End':
        event.preventDefault()
        focusAt(buttons.length - 1)
        break
      default:
        break
    }
  }

  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={t('compose.toolbar')}
      onKeyDown={onKeyDown}
    >
      {buttons.map((button, index) => (
        <IconButton
          key={button.key}
          ref={(element) => {
            refs.current[index] = element
          }}
          label={button.label}
          variant="ghost"
          size="sm"
          aria-pressed={button.pressed}
          disabled={busy && button.key !== 'mode'}
          tabIndex={index === focusIndex ? 0 : -1}
          onFocus={() => setFocusIndex(index)}
          onClick={button.onClick}
        >
          {button.icon}
        </IconButton>
      ))}
    </div>
  )
}
