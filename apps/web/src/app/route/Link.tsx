/**
 * Internal navigation link (M1.4). Renders a real `<a href>` (so it is a true link for
 * assistive tech, keyboard and open-in-new-tab) but intercepts an unmodified left-click to
 * navigate in-app via the router. Modified clicks (ctrl/meta/shift/alt, non-primary button)
 * and `target`ed links fall through to the browser. Use ONLY for base-relative internal
 * paths; external branding links use a plain `<a>`.
 */

import type { ComponentPropsWithoutRef, MouseEvent } from 'react'
import { useRouter } from './hooks'

export interface LinkProps extends Omit<ComponentPropsWithoutRef<'a'>, 'href'> {
  /** Base-relative internal path, e.g. `/contacts` or `/mail/inbox/42`. */
  readonly to: string
  readonly replace?: boolean
}

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const router = useRouter()

  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event)
    if (event.defaultPrevented) return
    const modified =
      event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    if (modified || rest.target) return
    event.preventDefault()
    if (replace) {
      router.navigate(to, { replace: true })
    } else {
      router.navigate(to)
    }
  }

  return <a href={router.href(to)} onClick={handleClick} {...rest} />
}
