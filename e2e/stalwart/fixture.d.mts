// Types for the fixture constants, so a TypeScript spec can name the container rather than
// duplicating its port. Deliberately partial — the provisioning functions below `PASSWORD` are
// driven by the JS setup files and have no TypeScript caller.

export const HOST_PORT: number
/** The container as the TEST PROCESS reaches it, which is not the origin the browser uses. */
export const BASE_URL: string
export const DOMAIN: string
export const PASSWORD: string
