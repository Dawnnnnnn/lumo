/**
 * The one error a connection is allowed to raise when it needs a human.
 *
 * `@ai-sdk/mcp` models this as `UnauthorizedError`, which it throws from inside
 * its own authorization attempt. We deliberately never run that attempt during a
 * connection (see `token-source.ts`), so the condition has to be named
 * explicitly: "authenticate me with the server's challenge, and do not retry".
 */

/** Parsed `WWW-Authenticate` challenge from a `401` (RFC 6750 / RFC 9728). */
export interface AuthorizationChallenge {
  /** The raw header value, kept for diagnostics. */
  header?: string;
  /** `error` parameter: `invalid_token`, `insufficient_scope`, … */
  error?: string;
  /** `error_description` parameter. */
  errorDescription?: string;
  /** `scope` the server wants, space-delimited. */
  scope?: string;
  /** RFC 9728 §5.1 `resource_metadata` URL. */
  resourceMetadataUrl?: URL;
}

/**
 * Why the user is needed.
 *
 * `insufficient-scope` is worth separating: a refresh keeps the granted scope, so
 * a wider scope can only be obtained by signing in again, and the card can say
 * so instead of looking like a plain expiry.
 */
export type AuthorizationRequiredReason = 'sign-in' | 'insufficient-scope';

export interface AuthorizationRequiredOptions {
  challenge?: AuthorizationChallenge;
  reason?: AuthorizationRequiredReason;
  cause?: unknown;
}

export class McpAuthorizationRequiredError extends Error {
  readonly challenge?: AuthorizationChallenge;
  readonly reason: AuthorizationRequiredReason;

  constructor(options: AuthorizationRequiredOptions = {}) {
    super(
      options.reason === 'insufficient-scope'
        ? 'This server requires additional permissions'
        : 'This server requires authorization',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'McpAuthorizationRequiredError';
    this.challenge = options.challenge;
    this.reason = options.reason ?? 'sign-in';
  }

  /** Survives bundling boundaries where `instanceof` would not. */
  static isInstance(value: unknown): value is McpAuthorizationRequiredError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'McpAuthorizationRequiredError'
    );
  }
}

/** Read one `key="value"` parameter out of a challenge header. */
function challengeParam(header: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*"([^"]*)"`, 'i').exec(header);
  return match?.[1];
}

/**
 * Parse `WWW-Authenticate: Bearer …`.
 *
 * Only the parameters MCP uses are read; anything else is ignored on purpose, so
 * an unfamiliar scheme cannot make a connection fail.
 */
export function parseWwwAuthenticate(header: string | null | undefined): AuthorizationChallenge {
  const value = header?.trim();
  if (!value) return {};

  const challenge: AuthorizationChallenge = { header: value };
  const error = challengeParam(value, 'error');
  if (error) challenge.error = error;
  const description = challengeParam(value, 'error_description');
  if (description) challenge.errorDescription = description;
  const scope = challengeParam(value, 'scope');
  if (scope) challenge.scope = scope;
  const resourceMetadata = challengeParam(value, 'resource_metadata');
  if (resourceMetadata) {
    try {
      challenge.resourceMetadataUrl = new URL(resourceMetadata);
    } catch {
      // A malformed URL is not evidence; discovery can still proceed from the
      // server URL itself.
    }
  }
  return challenge;
}
