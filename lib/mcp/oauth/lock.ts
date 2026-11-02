/**
 * Cross-context serialisation for one server's OAuth state.
 *
 * Two panels (or a panel and the options page) can react to the same `401` at
 * the same moment. MCP authorization servers commonly rotate refresh tokens, so
 * two refreshes carrying the same token lose the grant and log the user out.
 * Web Locks are shared by every extension context, which is the browser
 * equivalent of the per-server lock file pi uses between processes.
 *
 * Runtimes without the API (unit tests, older browsers) run unserialised: the
 * generation check in the token source still keeps a stale write from winning.
 */

/**
 * Lock scopes.
 *
 * `oauth` guards the credentials (refresh, sign-in), `connection` guards opening
 * a client. They must stay distinct names: Web Locks are not reentrant, so a
 * connection that refreshes a token would deadlock if both used one name.
 */
export type ServerLockScope = 'oauth' | 'connection';

/**
 * The lock is held elsewhere (typically an interactive sign-in in another
 * panel), so this attempt must say so instead of waiting forever.
 */
export class ServerLockBusyError extends Error {
  constructor(lockName: string) {
    super(`Another operation is already running (${lockName})`);
    this.name = 'ServerLockBusyError';
  }
}

export interface ServerLockOptions {
  /** Give up after this long. Without it the wait is unbounded. */
  timeoutMs?: number;
}

/** Serialise `run` with every other operation of the same scope for a server. */
export async function withServerLock<T>(
  serverId: string,
  run: () => Promise<T>,
  scope: ServerLockScope = 'oauth',
  options: ServerLockOptions = {},
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.request) return run();

  const name = `lumo:mcp:${scope}:${serverId}`;
  if (!options.timeoutMs) return locks.request(name, run);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let granted = false;
  try {
    return await locks.request(name, { signal: controller.signal }, async () => {
      granted = true;
      return run();
    });
  } catch (error) {
    // Only a wait that never got the lock is "busy"; an error from `run` itself
    // must keep its own meaning.
    if (!granted) throw new ServerLockBusyError(name);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
