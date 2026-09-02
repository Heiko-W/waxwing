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

/**
 * The encrypted secret store could not be destroyed because another connection held it open
 * (FR-AUTH-05). The credentials are STILL AT REST — this is a failed sign-out, not a warning, and
 * the UI has to say so rather than show a login form over a live session.
 */
export class SecretStoreBlockedError extends AuthError {
  constructor(dbName: string, options?: ErrorOptions) {
    super(`Could not delete "${dbName}": another connection is holding it open`, options)
    this.name = 'SecretStoreBlockedError'
  }
}

export interface OAuthCallbackErrorOptions extends ErrorOptions {
  /**
   * The authorization server's own error code (RFC 6749 §4.1.2.1) when the callback carried one —
   * `access_denied`, `server_error`, `temporarily_unavailable`, … Absent for the failures that
   * happen on THIS side: a missing or expired PKCE transaction, a state/`iss` mismatch, an
   * unreachable token endpoint.
   */
  code?: string
}

/**
 * The OAuth redirect callback could not be processed (state mismatch, provider error, …).
 *
 * {@link code} exists so the UI can tell the reader's own decision from a fault. "You declined the
 * sign-in request" and "the sign-in could not be completed" are different sentences, and the
 * generic "Something went wrong" that both used to get came with an offer to reset the app —
 * i.e. to delete the local mailbox — under a screen where nothing local was ever wrong.
 */
export class OAuthCallbackError extends AuthError {
  readonly code: string | undefined

  constructor(message: string, options?: OAuthCallbackErrorOptions) {
    super(message, options)
    this.name = 'OAuthCallbackError'
    this.code = options?.code
  }
}
