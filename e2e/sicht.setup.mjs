// Global setup for the visual sweep: the fixture has to advertise the origin the browser uses,
// because the client follows the session's absolute apiUrl and the Vite proxy only forwards this
// one origin. Same contract as read.setup.mjs.

import { up } from './stalwart/fixture.mjs'
import { seedReadMail } from './stalwart/seed-read.mjs'

export const APP_ORIGIN = 'http://localhost:4183'

export default async function globalSetup() {
  process.env.STALWART_PUBLIC_URL = APP_ORIGIN
  await up('dev')
  const summary = await seedReadMail()
  console.log(`[sicht.setup] seeded inbox ${summary.inboxId}: +${summary.created}`)
}
