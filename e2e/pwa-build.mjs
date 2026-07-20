// Builds the two deployments tests/deploy.spec.ts drives, and stages the first one (M3.10 wave 2).
//
//   .pwa/dist-a   build A — the app exactly as it ships
//   .pwa/dist-b   build B — a genuinely different deploy (see pwa-stage.vite.config.mjs)
//   .pwa/root     the SERVED directory, staged from A
//
// `root` is a third directory rather than a symlink to one of the other two because the suite
// REWRITES IT UNDER THE RUNNING SERVER: deploy.spec.ts edits `root/config.json` to model a hoster
// rebranding a deployed directory, and copies B over it to model a deploy. Both must be able to
// happen without disturbing the pristine copies they are compared against.
//
// Dependency-free: node: builtins only, matching stalwart/fixture.mjs and mount-server.mjs.

import { spawnSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

export const PWA_DIR = resolve(HERE, '.pwa')
export const DIST_A = resolve(PWA_DIR, 'dist-a')
export const DIST_B = resolve(PWA_DIR, 'dist-b')
export const SERVED_ROOT = resolve(PWA_DIR, 'root')

function build(label, args, env) {
  console.log(`[pwa-build] ${label}`)
  const result = spawnSync('pnpm', ['--filter', '@waxwing/web', 'exec', 'vite', 'build', ...args], {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`)
}

export function buildDeployments() {
  rmSync(PWA_DIR, { recursive: true, force: true })

  // A: the shipping configuration, only redirected to another outDir.
  build('build A (as shipped)', ['--outDir', DIST_A, '--emptyOutDir'])

  // B: the same source through pwa-stage.vite.config.mjs, which moves every chunk hash.
  build('build B (staged deploy)', ['--config', resolve(HERE, 'pwa-stage.vite.config.mjs')], {
    WAXWING_STAGE_OUT_DIR: DIST_B,
    WAXWING_STAGE_MARKER: 'b',
  })

  stageBuildA()
  console.log(`[pwa-build] staged A → ${SERVED_ROOT}`)
}

/** Reset the served directory to build A. Called by globalSetup and by the suite between tests. */
export function stageBuildA() {
  rmSync(SERVED_ROOT, { recursive: true, force: true })
  cpSync(DIST_A, SERVED_ROOT, { recursive: true })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildDeployments()
