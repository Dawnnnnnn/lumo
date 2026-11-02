import { describe, expect, it, vi } from 'vitest';
import {
  createOAuthFetch,
  sanitizeOAuthResponseBody,
} from '@/lib/mcp/oauth/oauth-fetch';

/**
 * Guard for the interoperability bug that made sign-in look broken: ScriptHub
 * answers client registration with `"client_uri": ""`, and `@ai-sdk/mcp`
 * validates that field with `z.string().url()` — so a server that is otherwise
 * perfectly healthy failed registration, before the consent window could open.
 */
describe('OAuth response tolerance', () => {
  it('drops empty URL fields a server should have omitted', () => {
    const body = JSON.stringify({
      client_id: 'shc_123',
      client_name: 'Lumo',
      client_uri: '',
      logo_uri: '',
      tos_uri: '',
      policy_uri: '',
      redirect_uris: ['https://abc.chromiumapp.org/'],
    });

    expect(JSON.parse(sanitizeOAuthResponseBody(body))).toEqual({
      client_id: 'shc_123',
      client_name: 'Lumo',
      redirect_uris: ['https://abc.chromiumapp.org/'],
    });
  });

  it('keeps every field that is not an empty URL', () => {
    const body = JSON.stringify({
      issuer: 'https://sh.example',
      resource: 'https://sh.example/mcp',
      client_name: '',
      scope: '',
      redirect_uris: [],
      authorization_servers: [],
    });

    // Empty *non-URL* strings are legal in the schema, so they are left alone:
    // the correction has to stay narrower than "remove anything falsy".
    expect(JSON.parse(sanitizeOAuthResponseBody(body))).toEqual({
      issuer: 'https://sh.example',
      resource: 'https://sh.example/mcp',
      client_name: '',
      scope: '',
      redirect_uris: [],
      authorization_servers: [],
    });
  });

  it('reaches nested objects', () => {
    const body = JSON.stringify({ data: { token_endpoint: '', client_id: 'x' } });
    expect(JSON.parse(sanitizeOAuthResponseBody(body))).toEqual({
      data: { client_id: 'x' },
    });
  });

  it('leaves a body that is already correct byte-identical', () => {
    const body = '{"client_id":"shc_1","redirect_uris":["https://a.example/cb"]}';
    expect(sanitizeOAuthResponseBody(body)).toBe(body);
  });

  it('leaves non-JSON bodies alone', () => {
    const body = '<html>error</html>';
    expect(sanitizeOAuthResponseBody(body)).toBe(body);
  });
});

describe('OAuth fetch wrapper', () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'content-type': 'application/json', 'content-length': '999' },
    });

  it('rewrites a JSON body and keeps the status plus content type', async () => {
    const wrapped = createOAuthFetch(
      vi.fn(async () => jsonResponse({ client_id: 'c', client_uri: '' })),
    );

    const response = await wrapped('https://as.example/register', { method: 'POST' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    // The stale framing header would describe the old body.
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual({ client_id: 'c' });
  });

  it('passes non-JSON responses through untouched', async () => {
    const text = new Response('denied', { status: 400, headers: { 'content-type': 'text/plain' } });
    const wrapped = createOAuthFetch(vi.fn(async () => text));

    const response = await wrapped('https://as.example/token', { method: 'POST' });
    expect(await response.text()).toBe('denied');
  });

  it('still surfaces a token response that is genuinely broken', async () => {
    // Removing empty URLs must not mask a missing access token: the SDK has to
    // reject this with its own message.
    const wrapped = createOAuthFetch(
      vi.fn(async () => jsonResponse({ token_type: 'Bearer', access_token: '' })),
    );

    const response = await wrapped('https://as.example/token', { method: 'POST' });
    expect(await response.json()).toEqual({ token_type: 'Bearer', access_token: '' });
  });
});
