export type ClassValue = string | false | null | undefined

/** Join truthy class names. Tiny local helper — no dependency for CSS Modules composition. */
export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ')
}
