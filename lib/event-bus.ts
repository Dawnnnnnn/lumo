/**
 * React-facing half of the typed event bus.
 *
 * The transport lives in `event-bus-core.ts` so non-React contexts (the shell
 * worker, storage adapters) can import it without pulling React into their
 * bundle. Existing imports keep working through the re-exports below.
 */

import { useEffect, useRef } from 'react';
import { onEvent, type LumoEventMap, type LumoEventType } from './event-bus-core';

export {
  emitEvent,
  onEvent,
  resetEventBusForTests,
  type LumoEventMap,
  type LumoEventType,
} from './event-bus-core';

/**
 * Subscribe for the lifetime of a component.
 *
 * The handler is held in a ref so an inline arrow does not re-subscribe on every
 * render, matching `useStorageWatch`.
 */
export function useEvent<K extends LumoEventType>(
  type: K,
  handler: (payload: LumoEventMap[K]) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return onEvent(type, (payload) => handlerRef.current(payload));
  }, [type]);
}
