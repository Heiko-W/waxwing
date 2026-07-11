/**
 * Runtime config context (M1.4). Makes the loaded {@link WaxwingConfig} available to any
 * component — including lazy route screens that take no props — so branding (product name,
 * logo, links) is read from one place and never hardcoded (FR-THEME-02).
 */

import { createContext, type ReactNode, useContext } from 'react'
import type { WaxwingConfig } from './config'

const ConfigContext = createContext<WaxwingConfig | null>(null)

export function ConfigProvider({
  config,
  children,
}: {
  readonly config: WaxwingConfig
  readonly children: ReactNode
}) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
}

export function useConfig(): WaxwingConfig {
  const config = useContext(ConfigContext)
  if (!config) throw new Error('useConfig must be used within a ConfigProvider')
  return config
}

/** The config or `null` outside a provider — lets a component read an optional setting with a fallback. */
export function useConfigOptional(): WaxwingConfig | null {
  return useContext(ConfigContext)
}
