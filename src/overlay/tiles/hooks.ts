import { useEffect, useState } from "react";
import { call, on } from "../../lib/bus";
import { inTauri } from "../../lib/native";
import type { BatteryInfo, RecycleBinInfo, WeatherNow } from "../../lib/types";

/** The current time, updated every `ms`. */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Calls a Wallsong command now and every `everyMs`, keeping the last good answer.
 * `null` until the first answer (or when the command needs the app and this is a browser).
 */
export function usePoll<T>(command: string, args: Record<string, unknown> | null, everyMs: number): T | null {
  const [value, setValue] = useState<T | null>(null);
  const key = args ? JSON.stringify(args) : "";
  useEffect(() => {
    if (!inTauri || args === null) {
      setValue(null);
      return;
    }
    let live = true;
    const load = () =>
      void call<T>(command, args)
        .then((v) => live && setValue(v))
        .catch(() => {
          /* keep showing the last answer */
        });
    load();
    const id = setInterval(load, everyMs);
    return () => {
      live = false;
      clearInterval(id);
    };
    // `key` stands in for `args`, which is a fresh object on every render.
  }, [command, key, everyMs]);
  return value;
}

/**
 * The battery: read once, then kept current by the core's "battery" event, sent every
 * 10 s and straight away when the charger goes in or out. `null` until known (or in a browser).
 */
export function useBattery(): BatteryInfo | null {
  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let live = true;
    let off: (() => void) | undefined;
    void call<BatteryInfo>("battery")
      .then((b) => live && setBattery(b))
      .catch(() => {});
    on<BatteryInfo>("battery", (b) => live && setBattery(b)).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return battery;
}
export const useRecycleBin = () => usePoll<RecycleBinInfo>("recycle_bin", {}, 30_000);
export const useWeather = (lat: number | null, lon: number | null) =>
  usePoll<WeatherNow>("weather", lat !== null && lon !== null ? { lat, lon } : null, 15 * 60_000);
