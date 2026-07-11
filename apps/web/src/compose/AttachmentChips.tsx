/**
 * The composer's attachment chip row (M2.7, FR-CMP-04). Shows in-flight/errored uploads (spinner or
 * a retry affordance + cancel) followed by fully-uploaded REGULAR attachments (remove). Inline images
 * are NOT chips — they live in the message body (Apple Mail convention); only `cid === null`
 * attachments surface here. Subscribes to the store so progress/removal re-render live.
 */

import { RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/formatters'
import { attachmentIcon } from '../mail/attachment-icon'
import { IconButton, Spinner } from '../ui'
import type { UploadItem } from './attachment-upload'
import styles from './composer.module.css'
import { useComposerStore } from './composer-store'
import type { DraftAttachment } from './reply'
import type { AttachmentController } from './use-attachment-upload'

export interface AttachmentChipsProps {
  readonly draftId: string
  readonly controller: AttachmentController
}

export function AttachmentChips({ draftId, controller }: AttachmentChipsProps) {
  const { t } = useTranslation()
  const uploads = useComposerStore((state) => state.uploads.get(draftId))
  const attachments = useComposerStore((state) => state.drafts.get(draftId)?.attachments)
  const inFlight = uploads ?? []
  const regular = (attachments ?? []).filter((a) => a.cid === null)
  if (inFlight.length === 0 && regular.length === 0) return null
  return (
    <ul className={styles.attachmentChips} aria-label={t('compose.attachmentsLabel')}>
      {inFlight.map((item) => (
        <li key={item.tempId}>
          <UploadChip
            item={item}
            onCancel={() => controller.removeUpload(item.tempId)}
            onRetry={() => controller.retry(item.tempId)}
          />
        </li>
      ))}
      {regular.map((attachment) => (
        <li key={attachment.blobId}>
          <DoneChip
            attachment={attachment}
            onRemove={() => controller.removeAttachment(attachment.blobId)}
          />
        </li>
      ))}
    </ul>
  )
}

function UploadChip({
  item,
  onCancel,
  onRetry,
}: {
  readonly item: UploadItem
  readonly onCancel: () => void
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  const Icon = attachmentIcon(item.type)
  const errored = item.status === 'error'
  // A size rejection re-fails identically on retry — offer only Remove for it, not a pointless Retry.
  const retryable =
    errored && item.error?.code !== 'tooLarge' && item.error?.code !== 'totalTooLarge'
  return (
    <div className={`${styles.attachmentChip}${errored ? ` ${styles.attachmentChipError}` : ''}`}>
      {errored ? (
        <Icon aria-hidden="true" className={styles.attachmentChipIcon} />
      ) : (
        <Spinner size="sm" label={t('compose.attachUploading', { name: item.name })} />
      )}
      <span className={styles.attachmentChipName} title={item.name}>
        {item.name}
      </span>
      <span className={styles.attachmentChipSize}>
        {errored ? t('compose.attachError') : formatBytes(item.size)}
      </span>
      {retryable && (
        <IconButton
          label={t('compose.attachRetry', { name: item.name })}
          variant="ghost"
          size="sm"
          onClick={onRetry}
        >
          <RotateCcw />
        </IconButton>
      )}
      <IconButton
        label={errored ? t('compose.attachRemove', { name: item.name }) : t('compose.attachCancel')}
        variant="ghost"
        size="sm"
        onClick={onCancel}
      >
        <X />
      </IconButton>
    </div>
  )
}

function DoneChip({
  attachment,
  onRemove,
}: {
  readonly attachment: DraftAttachment
  readonly onRemove: () => void
}) {
  const { t } = useTranslation()
  const Icon = attachmentIcon(attachment.type)
  const name = attachment.name ?? t('reading.attachments.unnamed')
  return (
    <div className={styles.attachmentChip}>
      <Icon aria-hidden="true" className={styles.attachmentChipIcon} />
      <span className={styles.attachmentChipName} title={name}>
        {name}
      </span>
      <span className={styles.attachmentChipSize}>{formatBytes(attachment.size)}</span>
      <IconButton
        label={t('compose.attachRemove', { name })}
        variant="ghost"
        size="sm"
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </div>
  )
}
