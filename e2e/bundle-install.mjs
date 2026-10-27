// Install the REAL release artefact into a live Stalwart as an Application, and open it.
//
//   pnpm release          build dist-release/waxwing-stalwart.zip (and check its layout)
//   pnpm e2e:bundle       this script
//
// Why this exists, and why nothing else covers it: the release gate checks the zip's SHAPE (index.html
// at the root, a size cap, the two bundle documents) against what the Stalwart source says it wants,
// and the Playwright suites serve the app from Vite or a static server. Neither ever hands the zip to a
// Stalwart. Stalwart 1.0 does something with a bundle that 0.16 never did — it REFUSES one without a
// `stalwart-app.json` — and the only way to learn that without reading the source is to install it.
// (It is how the 0.25.1 bundle was found to be uninstallable on 1.0: "Application bundle does not
// contain a manifest", logged by the server, with `UpdateApps` reporting success all the same.)
//
// What it asserts is what a deployer experiences: the app is served under its prefix with `<base href>`
// rewritten to that prefix, the OAuth return page (`/oauth/callback`, a path that is NOT a file) falls
// back to the shell, `config.json` is served as JSON, and a hashed asset the shell references loads.
//
// The server fetches the zip over HTTP from this process, so the fixture container must reach the host:
// it is given the address of its own bridge gateway. The Application field names changed between 0.16
// (`enabled`) and 1.0 (`enable`); both are tried, the one the server accepts wins, and the script says
// which — so it runs unchanged against either pin.
//
// Dependency-free: node: builtins and the fixture module.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { ADMIN, BASE_URL, down, up } from './stalwart/fixture.mjs'

const ZIP = fileURLToPath(new URL('../dist-release/waxwing-stalwart.zip', import.meta.url))
const PREFIX = '/webmail'
const CONTAINER = 'waxwing-stalwart-dev'

const auth = `Basic ${Buffer.from(`${ADMIN.login}:${ADMIN.password}`).toString('base64')}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  throw new Error(`bundle install: ${message}`)
}

async function jmap(methodCalls) {
  const res = await fetch(`${BASE_URL}/jmap/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls,
    }),
  })
  if (!res.ok) fail(`JMAP HTTP ${res.status}: ${await res.text()}`)
  const [name, args] = (await res.json()).methodResponses[0]
  if (name === 'error') fail(`JMAP error: ${JSON.stringify(args)}`)
  return args
}

/** The address the fixture container reaches the host at: its network's gateway. */
function hostAddressForContainer() {
  const out = execFileSync(
    'docker',
    ['inspect', CONTAINER, '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'],
    { encoding: 'utf8' },
  ).trim()
  if (out === '') fail(`could not find the gateway of ${CONTAINER}`)
  return out
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: 'manual' })
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
}

async function main() {
  if (!existsSync(ZIP)) fail(`${ZIP} is missing — run \`pnpm release\` first`)
  const zip = readFileSync(ZIP)

  const server = createServer((request, response) => {
    if (request.url === '/waxwing-stalwart.zip') {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length })
      response.end(zip)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address()

  console.log('[bundle] fixture up')
  await up()
  let applicationId = null
  try {
    const url = `http://${hostAddressForContainer()}:${port}/waxwing-stalwart.zip`
    // 1.0 renamed `enabled` -> `enable`; the server refuses the one it does not know.
    let dialect = null
    for (const enable of [{ enable: true }, { enabled: true }]) {
      const created = await jmap([
        [
          'x:Application/set',
          {
            create: {
              w: {
                ...enable,
                description: 'Waxwing (release bundle check)',
                resourceUrl: url,
                urlPrefix: { [PREFIX]: true },
              },
            },
          },
          '0',
        ],
      ])
      if (created.created?.w) {
        applicationId = created.created.w.id
        dialect = Object.keys(enable)[0]
        break
      }
    }
    if (applicationId === null) fail('the server accepted neither `enable` nor `enabled`')
    console.log(`[bundle] application created (field: ${dialect})`)

    const action = await jmap([['x:Action/set', { create: { u: { '@type': 'UpdateApps' } } }, '0']])
    // The trap documented in the deployment notes: without `created` the action did nothing and said so
    // nowhere.
    if (!action.created?.u) fail(`UpdateApps was not run: ${JSON.stringify(action)}`)

    let shell = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const page = await get(`${PREFIX}/`)
      if (page.status === 200 && page.type.includes('text/html')) {
        shell = page
        break
      }
      await sleep(1000)
    }
    if (shell === null) {
      fail(
        'the bundle was never served — the server fetched it and refused it (see `docker logs ' +
          `${CONTAINER}\`); Stalwart 1.0 requires stalwart-app.json at the zip root`,
      )
    }
    if (!shell.body.includes(`<base href="${PREFIX}/"`)) {
      fail(`the shell's <base href> was not rewritten to ${PREFIX}/`)
    }
    console.log('[bundle] shell served, <base href> rewritten')

    const callback = await get(`${PREFIX}/oauth/callback?code=x&state=y`)
    if (callback.status !== 200 || !callback.type.includes('text/html')) {
      fail(
        `the OAuth return page ${PREFIX}/oauth/callback answered ${callback.status}, not the shell`,
      )
    }
    console.log('[bundle] /oauth/callback falls back to the shell')

    const config = await get(`${PREFIX}/config.json`)
    if (config.status !== 200 || !config.type.includes('json')) {
      fail(`config.json answered ${config.status} ${config.type}`)
    }
    JSON.parse(config.body)

    const asset = shell.body.match(/(?:src|href)="\.\/(assets\/[^"]+\.js)"/)?.[1]
    if (asset === undefined) fail('found no hashed script in the shell')
    const script = await get(`${PREFIX}/${asset}`)
    if (script.status !== 200 || !script.type.includes('javascript')) {
      fail(`${asset} answered ${script.status} ${script.type}`)
    }
    console.log(`[bundle] config.json and ${asset} load`)
  } finally {
    if (applicationId !== null) {
      await jmap([['x:Application/set', { destroy: [applicationId] }, '0']]).catch(() => {})
    }
    server.close()
    down()
  }
  console.log('[bundle] OK — the release bundle installs and is served')
}

await main()
