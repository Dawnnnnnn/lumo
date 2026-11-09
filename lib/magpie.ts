/**
 * Magpie (self-hosted gateway) vendor specifics.
 *
 * Unlike OpenCode, Magpie serves every wire protocol from one base — OpenAI
 * Chat (`/chat/completions`), Responses (`/responses`) and Anthropic
 * (`/messages`) all live under `${origin}/v1`, and so does the model list
 * (`/models`, Bearer-authenticated). It needs no extra request headers, so the
 * only thing the vendor contributes is the default endpoint: a local gateway
 * listening on its standard port.
 */

/** Default origin, used when a vendor-Magpie provider leaves its URL empty. */
export const MAGPIE_ORIGIN = 'http://127.0.0.1:3425';

/** Base URL every protocol shares on a Magpie origin. */
export function magpieBaseUrl(origin = MAGPIE_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}/v1`;
}
