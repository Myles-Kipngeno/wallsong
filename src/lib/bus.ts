import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./native";

/**
 * Messages between the wallpaper window and the deck.
 * In the app these are Tauri events; in a browser (`npm run dev`) they travel
 * over a BroadcastChannel, so two tabs can stand in for the two windows.
 */
const channel = !inTauri && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("wallsong") : null;

export function send<T>(event: string, payload: T): void {
  if (inTauri) {
    void emit(event, payload);
  } else {
    channel?.postMessage({ event, payload });
  }
}

export async function on<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (inTauri) return listen<T>(event, (e) => handler(e.payload));
  const listener = (m: MessageEvent) => {
    if (m.data?.event === event) handler(m.data.payload as T);
  };
  channel?.addEventListener("message", listener);
  return () => channel?.removeEventListener("message", listener);
}

/** Calls a Rust command; rejects with a readable message outside the app. */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) return Promise.reject(new Error(`${command} needs the Wallsong app`));
  return invoke<T>(command, args);
}
