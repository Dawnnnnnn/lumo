/**
 * Bearer injection and the single 401 retry, at the `fetch` layer.
 *
 * The MCP client we use has no "just give me a token" hook, so authorization is
 * attached where the request is actually made. Two consequences, both intended:
 *
 * - Every request (initialize, tools/list, tools/call, the legacy SSE stream)
 *   carries the current token without the client knowing about OAuth.
 * - A `401` is answered by one refresh and one replay here, or by asking the
 *   user. The client never starts a discovery/registration flow of its own,
 *   which is what keeps background reconnects from registering clients.
 *
 * The body of an MCP request is a JSON string, so a replay is byte-identical; a
 * streaming body (which this client does not produce) is not replayed.
 */

import type { McpTokenSource } from './token-source';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Build the request headers with the token, replacing any previous one. */
function withBearerToken(init: RequestInit | undefined, token: string | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete('authorization');
  if (token) headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** A `401`, or a `403` whose challenge asks for more scope. */
export function isAuthorizationChallenge(response: Response): boolean {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  return /insufficient_scope/i.test(response.headers.get('www-authenticate') ?? '');
}

/** A body that can be sent twice: absent, or an in-memory payload. */
function isReplayable(init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (body == null || typeof body === 'string') return true;
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
}

/**
 * Wrap `fetch` so it authenticates, and retries once after a refresh.
 *
 * `tokenSource` is absent when the user configured a static `Authorization`
 * header: their credentials are already in `init.headers`, and the wrapper must
 * not overwrite them.
 */
export function withAuthorization(
  fetchImpl: FetchLike,
  tokenSource: McpTokenSource | undefined,
): FetchLike {
  if (!tokenSource) return fetchImpl;

  return async (input, init) => {
    const token = await tokenSource.token();
    const response = await fetchImpl(input, withBearerToken(init, token));

    if (!isAuthorizationChallenge(response)) return response;
    if (!isReplayable(init)) return response;

    try {
      // Throws `McpAuthorizationRequiredError` when a refresh cannot help.
      await tokenSource.handleUnauthorized(response, token);
    } catch (error) {
      // The rejection is being replaced by a state, so its body is never read.
      void response.body?.cancel().catch(() => {});
      throw error;
    }

    const retriedToken = await tokenSource.token();
    if (!retriedToken || retriedToken === token) {
      // Nothing to retry with (another context refilled the same token, or the
      // store is empty): hand the rejection to the caller as-is.
      return response;
    }

    void response.body?.cancel().catch(() => {});
    return fetchImpl(input, withBearerToken(init, retriedToken));
  };
}
