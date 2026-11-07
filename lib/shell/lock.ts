/**
 * A per-key async mutex for shell executions.
 *
 * The VFS is a snapshot plus an in-place index, and a script performs
 * read-modify-write sequences (`cp`, `mv`, `>>`) that IndexedDB cannot make
 * atomic across calls. Two `sh` calls issued in the same step (the model is free
 * to call the tool in parallel) could therefore lose an update: both read the
 * same bytes, both write, the later write wins silently.
 *
 * Serialising per conversation is the narrowest fix: unrelated conversations
 * still run in parallel, and a long script only delays its own conversation.
 * It does not protect against `file_write` (a different tool, different path),
 * which is why the VFS also revalidates its index against storage events.
 */

const tails = new Map<string, Promise<void>>();

/** Run `task` after every previously queued task for `key` has settled. */
export function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  // `then(task, task)`: a failed predecessor must not block the queue, and this
  // caller still owns its own result.
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, settled);
  void settled.then(() => {
    // Only the tail cleans up; a queued successor already replaced the entry.
    if (tails.get(key) === settled) tails.delete(key);
  });
  return run;
}

/** Test-only: drop queued chains. */
export function resetKeyLocksForTests(): void {
  tails.clear();
}
