/**
 * Intl-based locale-aware formatters (FR-I18N-01: localized dates/numbers).
 *
 * All helpers read the active i18next language so formatting follows the UI locale.
 */

import i18next from 'i18next'

function activeLocale(): string {
  return i18next.resolvedLanguage ?? i18next.language ?? 'en'
}

export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(activeLocale(), options).format(value)
}

const RELATIVE_DIVISIONS: {
  readonly amount: number
  readonly unit: Intl.RelativeTimeFormatUnit
}[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

export function formatRelativeTime(value: Date | number, base: Date | number = Date.now()): string {
  const formatter = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' })
  const valueMs = typeof value === 'number' ? value : value.getTime()
  const baseMs = typeof base === 'number' ? base : base.getTime()
  let duration = (valueMs - baseMs) / 1000

  for (const division of RELATIVE_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return formatter.format(Math.round(duration), 'year')
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(activeLocale(), options).format(value)
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

export function formatBytes(bytes: number, maximumFractionDigits?: number): string {
  let size = bytes
  let unitIndex = 0
  while (Math.abs(size) >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'byte'
  return new Intl.NumberFormat(activeLocale(), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: maximumFractionDigits ?? (unitIndex === 0 ? 0 : 1),
  }).format(size)
}
