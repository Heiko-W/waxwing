/** Auth error hierarchy. Kept small; the app maps these to localized UX (SP.4/M1.4). */

/** Base class for every error thrown by the auth module. */
export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthError'
  }
}

/** The configuration is unusable (missing OAuth config, endpoint absent from discovery, …). */
export class AuthConfigError extends AuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthConfigError'
  }
}

/**
 * No valid access token and none could be obtained (no/expired refresh token, refused
 * refresh). The app prompts for re-auth without losing unsent state (FR-AUTH-06).
 */
export class AuthExpiredError extends AuthError {
  constructor(message = 'Session expired; re-authentication required', options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthExpiredError'
  }
}

/** The OAuth redirect callback could not be processed (state mismatch, provider error, …). */
export class OAuthCallbackError extends AuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OAuthCallbackError'
  }
}
