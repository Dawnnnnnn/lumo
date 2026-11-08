import {
  AUTHORIZE_CHANNEL,
  PROBE_CHANNEL,
  PROBE_VERSION,
  isProbeResponse,
  type ProbeResponse,
} from './extension-protocol';

/**
 * Cold `MV3` service workers are asleep most of the time; waking one is the only
 * slow part of a probe (the message itself is microseconds). Two seconds covers a
 * cold start with room to spare while still failing visibly rather than leaving
 * a card on "connecting" forever.
 */
const PROBE_TIMEOUT_MS = 2000;

export interface ProbeOutcome {
  ok: boolean;
  response?: ProbeResponse;
  /** Human-readable reason when `ok` is false. */
  error?: string;
  /** True when the extension could not be reached at all. */
  unreachable?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timed out after ${ms} ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function clientInfo() {
  return {
    id: chrome.runtime.id,
    name: 'Lumo',
    version: chrome.runtime.getManifest().version,
  };
}

/**
 * One L0 round trip.
 *
 * `sendMessage` rejects immediately when the extension is not installed or does
 * not declare `externally_connectable`; the UI renders that as "not installed"
 * rather than as an error the user must act on. An installed extension that is
 * older than this contract has no listener for `lumo:authorize`, and rejects the
 * same way — the caller distinguishes that by which message it sent.
 */
async function send(extensionId: string, channel: string): Promise<ProbeOutcome> {
  const request = { channel, version: PROBE_VERSION, id: crypto.randomUUID(), client: clientInfo() };

  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage(extensionId, request) as Promise<unknown>,
      PROBE_TIMEOUT_MS,
    );
    if (!isProbeResponse(response)) {
      return { ok: false, error: 'The extension returned a malformed response.' };
    }
    return { ok: response.ok, response, error: response.error?.message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message,
      unreachable: /Receiving end does not exist|Could not establish connection/i.test(message),
    };
  }
}

/** Read-only: who is there, and would it accept us. */
export function probeExtension(extensionId: string): Promise<ProbeOutcome> {
  return send(extensionId, PROBE_CHANNEL);
}

/**
 * Ask the provider to let us in.
 *
 * This is the one call a provider is allowed to answer by opening its own
 * settings, so it belongs behind an explicit user action and nowhere else.
 */
export function authorizeExtension(extensionId: string): Promise<ProbeOutcome> {
  return send(extensionId, AUTHORIZE_CHANNEL);
}
