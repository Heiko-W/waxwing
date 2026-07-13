/**
 * The page half of a notification click (M3.6). The service worker focuses this tab and posts it a
 * route; we navigate there.
 *
 * It has to be a message rather than `WindowClient.navigate()`, which is what a worker would normally
 * use: there is no `clientsClaim()` (M3.5, deliberately), so the tab that raised the notification is
 * typically NOT controlled by the worker — and `navigate()` rejects for an uncontrolled client.
 */

import { useEffect } from 'react'
import { useNavigate } from '../app/route'
import { isNotifyClickMessage } from './click-route'

export function useNotificationClickNavigation(): void {
  const navigate = useNavigate()

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const container = navigator.serviceWorker
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data
      if (!isNotifyClickMessage(data)) return
      navigate(data.path)
    }

    container.addEventListener('message', onMessage)
    return () => container.removeEventListener('message', onMessage)
  }, [navigate])
}
