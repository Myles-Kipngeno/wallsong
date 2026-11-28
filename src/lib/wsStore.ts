import { useCallback, useRef, useSyncExternalStore } from "react";
import { on, send } from "./bus";
import type { WsCmd, WsState } from "./types";

let currentState: WsState | null = null;
const listeners = new Set<() => void>();
let initialized = false;

function ensureInit() {
  if (initialized) return;
  initialized = true;

  on<WsState>("ws-state", (s) => {
    currentState = s;
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error("wsStore listener error:", err);
      }
    }
  });

  // Ask wallpaper window to send current state immediately
  send<WsCmd>("ws-cmd", { type: "hello" });
}

/** Returns the latest raw WsState snapshot without subscribing to React state updates. */
export function getWsState(): WsState | null {
  ensureInit();
  return currentState;
}

/** Subscribes an external listener to ws-state updates. */
export function subscribeWs(listener: () => void): () => void {
  ensureInit();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Selector hook for WsState powered by useSyncExternalStore.
 * The component re-renders ONLY when the selected slice changes according to isEqual (defaults to Object.is).
 */
export function useWs<T = WsState | null>(
  selector?: (state: WsState | null) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  ensureInit();
  const sel = selector ?? (((s: WsState | null) => s) as unknown as (state: WsState | null) => T);

  const lastSelectedRef = useRef<T>(sel(currentState));

  const getSnapshot = useCallback(() => {
    const nextSelected = sel(currentState);
    if (!isEqual(lastSelectedRef.current, nextSelected)) {
      lastSelectedRef.current = nextSelected;
    }
    return lastSelectedRef.current;
  }, [sel, isEqual]);

  return useSyncExternalStore(subscribeWs, getSnapshot);
}
