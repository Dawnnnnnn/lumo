/**
 * `fetch` for the OAuth requests only, tolerant of empty optional URL fields.
 *
 * Real authorization servers send fields they do not have as an empty string
 * instead of omitting them. ScriptHub, for example, answers client registration
 * with `"client_uri": ""`. `@ai-sdk/mcp` validates client metadata with
 * `z.string().url()`, so a *present but empty* URL fails the whole registration
 * response — and because registration is the step before the consent window,
 * the visible symptom is "clicking Sign in does nothing".
 *
 * The spec is on the strict side here (RFC 7591 says these fields are URLs when
 * present), but a client that cannot register against a working server is not
 * being rigorous, it is being broken. Dropping empty URL-valued fields is the
 * narrowest possible correction:
 *
 * - only fields whose *value* is `""`;
 * - only fields whose *name* is a URL (or a known endpoint);
 * - only responses that are JSON, and only inside the OAuth flow.
 *
 * Everything else — including a genuinely malformed token response — is passed
 * through untouched so the SDK can still reject it with its own message.
 */

type FetchFunction = typeof globalThis.fetch;

/** Keys that hold a single URL. Arrays (`redirect_uris`) are deliberately absent. */
const URL_FIELD_PATTERN = /(?:^|_)ur[il]$|^(?:issuer|resource)$/;

/** Endpoint fields that are URLs but do not end in `url`/`uri`. */
const URL_FIELD_NAMES = new Set([
  'issuer',
  'resource',
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'revocation_endpoint',
  'userinfo_endpoint',
  'end_session_endpoint',
  'jwks_endpoint',
  'resource_documentation',
  'service_documentation',
]);

function isUrlField(key: string): boolean {
  return URL_FIELD_NAMES.has(key) || URL_FIELD_PATTERN.test(key);
}

/**
 * Remove `""` values from URL-valued fields, recursively.
 *
 * Returns whether anything changed, so an untouched response keeps its exact
 * bytes (and no allocation happens for the common case).
 */
function stripEmptyUrlFields(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = stripEmptyUrlFields(entry);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (typeof value !== 'object' || value === null) {
    return { value, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === '' && isUrlField(key)) {
      changed = true;
      continue;
    }
    const result = stripEmptyUrlFields(entry);
    if (result.changed) changed = true;
    next[key] = result.value;
  }
  return { value: changed ? next : value, changed };
}

/** Rewrite a JSON body with empty URL fields removed; leaves non-JSON alone. */
export function sanitizeOAuthResponseBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  const { value, changed } = stripEmptyUrlFields(parsed);
  return changed ? JSON.stringify(value) : body;
}

/** Wrap `fetch` so OAuth responses tolerate empty URL fields. */
export function createOAuthFetch(fetchImpl?: FetchFunction): FetchFunction {
  const base: FetchFunction = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return async (input, init) => {
    const response = await base(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    // Discovery, registration and token responses are JSON. Anything else (an
    // HTML error page, an SSE stream) is passed through byte for byte.
    if (!/json/i.test(contentType)) return response;

    let body: string;
    try {
      body = await response.text();
    } catch {
      return response;
    }

    const sanitized = sanitizeOAuthResponseBody(body);
    if (sanitized === body) {
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const headers = new Headers(response.headers);
    // Framing headers describe the old body; `fetch` computed them from the wire
    // bytes and they would be wrong after the rewrite.
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(sanitized, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
