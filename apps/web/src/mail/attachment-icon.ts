/**
 * The lucide icon representing an attachment's media type — shared by the reader's attachment strip
 * ({@link AttachmentList}, M1.8) and the composer's attachment chips (M2.7), so both stay in sync.
 */

import { FileText, ImageIcon, type LucideIcon, Paperclip } from 'lucide-react'

export function attachmentIcon(type: string): LucideIcon {
  if (type.startsWith('image/')) return ImageIcon
  if (type === 'application/pdf') return FileText
  return Paperclip
}
