/**
 * Typed, fire-and-forget event bus across the extension's trusted contexts.
 *
 * This half is React-free so the shell worker (which has no DOM and no reason
 * to carry React) can import `onEvent` for storage invalidation. The hook lives
 * in `event-bus.ts`, which re-exports this module.
 *
 * ## Why this exists
 *
 * Several things the UI must react to live in IndexedDB (stored files,
 * conversations), which emits no cross-context change event. Until now each case
 * was solved ad hoc and differently: a bounded revision counter in
 * `chrome.storage.local` for conversations, and a 3-second `setInterval` poll in
 * `ConversationFiles` for files. Raw `chrome.runtime.sendMessage` was the obvious
 * alternative but is awkward to use directly, because every notification needs a
 * hand-written sender *and* a matching listener that has to re-check the message
 * shape, and nothing ties the two together — a typo in either half fails silently.
 *
 * This module makes the pair a single typed declaration: add a key to
 * `LumoEventMap`, then `emitEvent` and `onEvent` are checked against it. There is
 * no registration step and no init call; the underlying `chrome.runtime.onMessage`
 * listener is installed on the first subscription and removed after the last.
 *
 * ## The one behaviour worth knowing
 *
 * `chrome.runtime.sendMessage` delivers `onMessage` to every page in the
 * extension *except the frame that sent it*. A file written by an MCP tool runs
 * in the side panel, and `ConversationFiles` — which needs to know — lives in
 * that same side panel, so a pure `sendMessage` bus would notify every context
 * except the one where the change originated. `emitEvent` therefore dispatches to
 * local subscribers directly as well as broadcasting. Local delivery is
 * synchronous and remote delivery is not, which is fine for the only contract
 * offered here: "something changed, re-read it".
 *
 * ## Scope and guarantees
 *
 * - Reaches the background worker and every extension page (side panel, options,
 *   preview). It does *not* reach content scripts — `runtime.sendMessage` cannot
 *   target them; use `chrome.tabs.sendMessage` for that.
 * - Delivery is best-effort and unacknowledged. A context that is not listening
 *   at emit time misses the event, so this is for *notifications*, never for
 *   state. Anything a context must know when it starts up belongs in storage,
 *   which is why `conversationsRevision` and `mcpSettings` stay on
 *   `chrome.storage.onChanged`: those readers need the value on mount too.
 * - Payloads cross a structured clone, so they must be plain data.
 * - Events are never coalesced. Merging them would mean dropping payload fields —
 *   two writes to different files would collapse into one, and a subscriber
 *   filtering on file name would miss its own. Subscribers that want to throttle
 *   should throttle their own reload.
 */
/**
 * Every cross-context event in the app, and its payload.
 *
 * Keys are `domain:past-tense-fact`. An event states what happened; it never
 * carries an instruction, so any number of contexts can interpret it
 * independently.
 */
export interface LumoEventMap {
  /**
   * Stored files were created, overwritten or deleted.
   *
   * `names` lists every affected file so a subscriber showing one file can
   * ignore changes to the others. Emitted from the `fileStorage` write/delete
   * path rather than from the MCP tools, because the tools are only three of the
   * callers — the options page deletes files too, and any future writer would
   * otherwise have to remember to announce itself.
   */
  'files:changed': { names: string[]; reason: 'write' | 'delete' };

  /**
   * The side panel's document mounted — i.e. the panel is now open.
   *
   * Emitted by the side panel itself on mount. Consumers subscribe to learn the
   * panel's liveness the moment it changes instead of waiting for the next focus
   * event, which is what the old `getContexts`-on-focus probe did and why it
   * could not see a panel open while the reading page was not focused.
   */
  'sidepanel:opened': object;

  /**
   * The side panel's document is being unloaded — i.e. the panel is closing.
   *
   * Emitted during `pagehide`, so it can still fail: the context is already
   * being torn down and `sendMessage` may reject. Subscribers keep the
   * focus/visibility fallback for exactly that case.
   */
  'sidepanel:closed': object;
}

export type LumoEventType = keyof LumoEventMap;

/** Envelope marker. A dedicated key keeps this disjoint from the `type`-tagged
 *  page (`lumo:page:*`) and WebMCP (`webmcp:*`) message protocols, so neither
 *  bus ever has to parse the other's traffic. */
const ENVELOPE_KEY = 'lumoEvent';

interface EventEnvelope {
  [ENVELOPE_KEY]: string;
  payload: unknown;
}

function isEventEnvelope(message: unknown): message is EventEnvelope {
  return (
    !!message &&
    typeof message === 'object' &&
    typeof (message as Record<string, unknown>)[ENVELOPE_KEY] === 'string'
  );
}

type AnyHandler = (payload: never) => void;

/** Subscribers in *this* context, by event type. */
const subscribers = new Map<string, Set<AnyHandler>>();

/** The single `chrome.runtime.onMessage` listener, while any subscriber exists. */
let bridge: ((message: unknown) => boolean) | null = null;

function dispatchLocal(type: string, payload: unknown): void {
  const handlers = subscribers.get(type);
  if (!handlers || handlers.size === 0) return;
  // Snapshot: a handler may unsubscribe itself or others while dispatching.
  for (const handler of [...handlers]) {
    try {
      (handler as (p: unknown) => void)(payload);
    } catch (error) {
      // One bad subscriber must not stop the rest, and must not surface as an
      // unhandled rejection in the emitting code path.
      console.error(`[event-bus] handler for "${type}" threw:`, error);
    }
  }
}

function installBridge(): void {
  if (bridge) return;
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime?.onMessage) return;

  bridge = (message: unknown): boolean => {
    if (!isEventEnvelope(message)) return false;
    dispatchLocal(message[ENVELOPE_KEY], message.payload);
    // Never keep the response port open. Other listeners in this context answer
    // real requests on the same channel (`entrypoints/content.ts` returns a
    // page response, `webmcp-manager` its own), and Chrome closes the port after
    // the first responder — claiming it here would break them.
    return false;
  };
  runtime.onMessage.addListener(bridge);
}

function removeBridgeIfIdle(): void {
  if (!bridge) return;
  for (const handlers of subscribers.values()) {
    if (handlers.size > 0) return;
  }
  chrome.runtime.onMessage.removeListener(bridge);
  bridge = null;
}

/**
 * Subscribe to an event. Returns the unsubscribe function.
 *
 * Safe in any context, including ones without a `chrome` global (tests): the
 * subscription is recorded and local delivery still works, only the cross-context
 * bridge is skipped.
 */
export function onEvent<K extends LumoEventType>(
  type: K,
  handler: (payload: LumoEventMap[K]) => void,
): () => void {
  let handlers = subscribers.get(type);
  if (!handlers) {
    handlers = new Set();
    subscribers.set(type, handlers);
  }
  handlers.add(handler as AnyHandler);
  installBridge();

  let active = true;
  return () => {
    if (!active) return; // idempotent: double-unsubscribe must not free a re-added handler
    active = false;
    handlers!.delete(handler as AnyHandler);
    removeBridgeIfIdle();
  };
}

/**
 * Announce that something happened, here and in every other trusted context.
 *
 * Fire-and-forget by design: there is no delivery receipt and no error to
 * handle. A rejected broadcast is the normal case, not a fault — it means no
 * other context is listening, which is true whenever the side panel is the only
 * thing open.
 */
export function emitEvent<K extends LumoEventType>(type: K, payload: LumoEventMap[K]): void {
  // Local first: `sendMessage` deliberately skips the sending frame, so this is
  // the only delivery the emitting context gets.
  dispatchLocal(type, payload);

  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime?.sendMessage) return;

  const envelope: EventEnvelope = { [ENVELOPE_KEY]: type, payload };
  try {
    // `sendMessage` throws *synchronously* once the context is invalidated
    // rather than returning a rejected promise, so a bare `.catch()` would not
    // run and the error would escape into the caller — the failure documented in
    // `entrypoints/content-webmcp-bridge.ts`. Both paths have to be handled.
    void runtime.sendMessage(envelope)?.catch(() => {
      // "Receiving end does not exist": nobody else is open. Expected.
    });
  } catch {
    // Context torn down mid-call. Nothing to notify and nothing to recover.
  }
}

/** Test-only: drop all subscribers and detach the bridge. */
export function resetEventBusForTests(): void {
  subscribers.clear();
  if (bridge && typeof chrome !== 'undefined') {
    chrome.runtime?.onMessage?.removeListener(bridge);
  }
  bridge = null;
}
