import type { PluginIconProps } from "@getpaseo/plugin";
import { useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, View } from "react-native";

/** All mounted fallback icons on this host share one tick. A registered pill alone starts nothing. */
export function createClockIcon() {
  const listeners = new Set<() => void>();
  let phase = 0;
  let stop: (() => void) | undefined;
  let disposed = false;

  function notify() {
    for (const listener of listeners) listener();
  }

  function observeMotion() {
    let active = AppState.currentState === "active";
    let reduced = true; // Render a still clock until the system preference is known.
    let current = true;
    let preferenceChanged = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    function updateTimer() {
      if (active && !reduced) {
        timer ??= setInterval(() => {
          phase = (phase + 1) % 8;
          notify();
        }, 1_000);
      } else {
        clearInterval(timer);
        timer = undefined;
        if (phase !== 0) {
          phase = 0;
          notify();
        }
      }
    }
    const visibility = AppState.addEventListener("change", (state) => {
      active = state === "active";
      updateTimer();
    });
    const preference = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      preferenceChanged = true;
      reduced = value;
      updateTimer();
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!current || preferenceChanged) return;
      reduced = value;
      updateTimer();
    }).catch(() => { /* Keep the clock still if the system preference is unavailable. */ });
    return () => {
      current = false;
      visibility.remove();
      preference?.remove();
      clearInterval(timer);
      phase = 0;
    };
  }

  function subscribe(listener: () => void) {
    if (disposed) return () => {};
    listeners.add(listener);
    stop ??= observeMotion();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        stop?.();
        stop = undefined;
      }
    };
  }
  const snapshot = () => phase;

  function ClockIcon({ size, color }: PluginIconProps) {
    const step = useSyncExternalStore(subscribe, snapshot, snapshot);
    const stroke = Math.max(1, size / 12);
    const middle = size / 2;
    return (
      <View pointerEvents="none" accessible={false} style={{ width: size, height: size }}>
        <View style={{
          position: "absolute", inset: 0.5, borderWidth: stroke,
          borderRadius: middle, borderColor: color,
        }} />
        <View style={{
          position: "absolute", top: middle - stroke / 2, left: middle - stroke / 2,
          width: size * 0.27, height: stroke, backgroundColor: color, borderRadius: stroke / 2,
        }} />
        <View style={{ width: size, height: size, transform: [{ rotate: `${step * 45}deg` }] }}>
          <View style={{
            position: "absolute", left: middle - stroke / 2, top: size * 0.19,
            width: stroke, height: size * 0.31 + stroke / 2,
            backgroundColor: color, borderRadius: stroke / 2,
          }} />
        </View>
      </View>
    );
  }

  return {
    Icon: ClockIcon,
    dispose() {
      disposed = true;
      stop?.();
      stop = undefined;
      listeners.clear();
    },
  };
}
