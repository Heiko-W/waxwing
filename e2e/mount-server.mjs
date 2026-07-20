// The `/mail/` MOUNT harness (M3.10). Serves the built apps/web bundle under a PATH PREFIX
// instead of the root, and reverse-proxies Stalwart's paths the way vite.config.ts's `demoProxy`
// does for `vite preview`.
//
// WHY THIS EXISTS — and why `vite preview` cannot stand in for it.
//
// Stalwart's own webmail deployment serves the app under a sub-path, not at the origin root
// (FR-DEP-02). `vite preview` only ever serves at `/`, so every E2E suite the repo has ever run
// has exercised the root deployment exclusively. That gap is not academic: M3.5's changelog
// records that the built `index.html` needed its `<base>` element, and that WITHOUT it a
// deep-link reload of `/mail/inbox/42` resolved the relative `./assets/index-*.js` against the
// ROUTE path (`/mail/mail/inbox/`) rather than the mount, 404'd the entry chunk, and left a
// WHITE SCREEN. Vite's `base: './'` (vite.config.ts) emits those relative URLs deliberately, so
// the `<base>` element is the single load-bearing thing standing between the shipping bundle and
// a dead deployment — and it is INVISIBLE at the root, where `./assets/…` happens to resolve
// correctly no matter what. A defect that only ever appears in the one deployment shape our
// users get, and never in the one our tests use, is precisely the defect a harness must exist
// for. See tests/mount.spec.ts.
//
// Dependency-free: node: builtins only, matching stalwart/fixture.mjs. Run standalone with
// `node mount-server.mjs --port 4185`, or as a Playwright `webServer` command.

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '../apps/web/dist')

/** The path prefix the app is mounted under. Trailing slash is part of the contract. */
export const MOUNT = '/mail/'

/**
 * Stalwart's paths, proxied to the fixture. This is the same set `demoProxy` enumerates in
 * apps/web/vite.config.ts — kept in sync by hand rather than imported, because that file is
 * TypeScript inside the web package and this is a dependency-free .mjs in the e2e package.
 *
 * `/jmap` must also carry the WebSocket upgrade: it is proxied `ws: true` for the demo, and the
 * push-transport suite asserts the NEGATIVE (no WS is ever attempted). That assertion is only
 * meaningful if an attempt WOULD have succeeded at the transport layer, so the upgrade path has
 * to be genuinely forwarded here rather than quietly dropped.
 */
const PROXY_PATHS = ['/jmap', '/.well-known', '/auth', '/login', '/api', '/logo']

const PROXY_TARGET = process.env.WAXWING_PROXY_TARGET ?? 'http://127.0.0.1:18080'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const mimeFor = (path) => MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'

const isProxied = (path) =>
  PROXY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

/**
 * Rewrite the mount prefix into `index.html`.
 *
 * index.html ships `<base href="/" />` as a literal, root-path, double-quoted token precisely so
 * a deployment can rewrite it (its own comment says so, and warns against putting a lookalike in
 * that comment where a pattern-matcher would find it first). We match that exact literal.
 *
 * If the tag is ABSENT we do NOT synthesise one. Serving the bundle base-less under a mount is
 * exactly the M3.5 white-screen defect, and mount.spec.ts's mutation proof depends on this
 * function being a faithful rewriter rather than a repairman: a helpful fallback here would make
 * the regression test permanently green and therefore worthless.
 */
export function rewriteBase(html, mount = MOUNT) {
  return html.replace('<base href="/"', `<base href="${mount}"`)
}

/** Reject `..` traversal before it reaches the filesystem. */
function safeJoin(root, relativePath) {
  const target = normalize(join(root, relativePath))
  return target.startsWith(root) ? target : null
}

async function serveStatic(res, filePath) {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return false
    res.writeHead(200, {
      'content-type': mimeFor(filePath),
      'content-length': info.size,
      // The suites rebuild dist between runs; a cached entry chunk would test the previous build.
      'cache-control': 'no-store',
    })
    createReadStream(filePath).pipe(res)
    return true
  } catch {
    return false
  }
}

async function serveIndex(res, status = 200) {
  const html = rewriteBase(await readFile(join(DIST, 'index.html'), 'utf8'))
  res.writeHead(status, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
  res.end(html)
}

function proxy(req, res, target) {
  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      // changeOrigin: Stalwart authenticates and builds absolute session URLs off the Host it
      // sees, so it must see its own, not ours.
      headers: { ...req.headers, host: target.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`mount-server: upstream ${target.host} unreachable: ${err.message}\n`)
  })
  req.pipe(upstream)
}

export function createMountServer({ mount = MOUNT, target = PROXY_TARGET } = {}) {
  const upstream = new URL(target)

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)

    // Stalwart's paths are NOT under the mount — the JMAP server owns the origin root and the app
    // is a guest in a subdirectory, which is the whole point of the mount shape.
    if (isProxied(path)) return proxy(req, res, upstream)

    // Anything outside the mount is not ours. Bounce the bare origin to the mount so a human
    // opening the port lands somewhere useful.
    if (!path.startsWith(mount)) {
      if (path === '/' || `${path}/` === mount) {
        res.writeHead(302, { location: mount })
        return res.end()
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(`mount-server: ${path} is outside ${mount}\n`)
    }

    const relative = path.slice(mount.length)

    // index.html is served through the rewriter, never as a static file, so no route can ever
    // receive the un-rewritten root-based document.
    if (relative === '' || relative === 'index.html') return serveIndex(res)

    const filePath = safeJoin(DIST, relative)
    if (filePath === null) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('mount-server: forbidden\n')
    }
    if (await serveStatic(res, filePath)) return

    // SPA fallback — but ONLY for extension-less paths. A missing `.js` must 404 rather than
    // receive index.html: the M3.5 defect is a 404 on the entry chunk, and answering it with HTML
    // would turn a hard failure into a confusing MIME error and hide what actually broke.
    if (!relative.split('/').pop().includes('.')) return serveIndex(res)

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`mount-server: ${relative} not found in dist\n`)
  })

  // WebSocket upgrades for the proxied paths (see PROXY_PATHS). Raw socket splice: node:http has
  // no built-in proxy, and pulling in `ws`/`http-proxy` for one path would put a dependency in a
  // package that deliberately has none.
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (!isProxied(path)) return socket.destroy()

    const outbound = netConnect(Number(upstream.port), upstream.hostname, () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n')
      outbound.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
      if (head?.length) outbound.write(head)
      outbound.pipe(socket)
      socket.pipe(outbound)
    })
    outbound.on('error', () => socket.destroy())
    socket.on('error', () => outbound.destroy())
  })

  return server
}

// CLI: `node mount-server.mjs --port 4185`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.indexOf('--port')
  const port = Number(portArg === -1 ? (process.env.PORT ?? 4185) : process.argv[portArg + 1])
  createMountServer().listen(port, () => {
    console.log(`[mount-server] ${DIST}`)
    console.log(`[mount-server] http://localhost:${port}${MOUNT} → proxying to ${PROXY_TARGET}`)
  })
}
