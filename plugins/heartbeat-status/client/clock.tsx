import type { PluginIconProps, PluginTheme } from "@getpaseo/plugin";
import { useEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, Platform, View } from "react-native";
import { accentColors, defaults, type HeartbeatSettings } from "../shared/settings";

/** Paseo's surface tokens are hex colors. Prefer the palette with the higher contrast. */
function contrast(color: string, surface: string) {
  function luminance(hex: string) {
    const short = /^#([0-9a-f]{3})$/i.exec(hex);
    if (short) hex = "#" + [...short[1]].map((digit) => digit + digit).join("");
    const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
    if (!rgb) return null;
    const [r, g, b] = rgb.slice(1).map((pair) => {
      const value = parseInt(pair, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const a = luminance(color), b = luminance(surface);
  return a === null || b === null ? 0 : (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Native glyphs in one installation share a single UI-thread rotation while at least one is mounted. */
export function createClockIcon() {
  let progress: Animated.Value | undefined;
  let angle: Animated.AnimatedInterpolation<string> | undefined;
  let mounted = 0;
  let stop: (() => void) | undefined;
  let disposed = false;
  let settings = defaults;
  const subscribers = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  };
  const snapshot = () => settings;

  function observeMotion(value: Animated.Value) {
    let active = AppState.currentState === "active";
    let reduced = true; // Render a still clock until the system preference is known.
    let current = true;
    let preferenceChanged = false;
    let animation: Animated.CompositeAnimation | undefined;

    function updateAnimation() {
      if (active && !reduced && settings.animate) {
        if (animation) return;
        animation = Animated.loop(Animated.timing(value, {
          toValue: 1, duration: 6_000, easing: Easing.linear, useNativeDriver: true, isInteraction: false,
        }));
        animation.start();
      } else if (animation) {
        animation.stop();
        animation = undefined;
        value.setValue(0);
      }
    }
    const visibility = AppState.addEventListener("change", (state) => {
      active = state === "active";
      updateAnimation();
    });
    const preference = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      preferenceChanged = true;
      reduced = value;
      updateAnimation();
    });
    const stopSettings = subscribe(updateAnimation);
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!current || preferenceChanged) return;
      reduced = value;
      updateAnimation();
    }).catch(() => { /* Keep the clock still if the system preference is unavailable. */ });
    return () => {
      current = false;
      visibility.remove();
      preference?.remove();
      stopSettings();
      animation?.stop();
      value.setValue(0);
    };
  }

  function mount() {
    if (disposed || Platform.OS === "web" || !progress) return;
    mounted++;
    stop ??= observeMotion(progress);
    return () => {
      mounted--;
      if (!mounted) {
        stop?.();
        stop = undefined;
      }
    };
  }
  function ClockIcon({ size, theme, surface }: PluginIconProps & { theme?: PluginTheme; surface?: string }) {
    const saved = useSyncExternalStore(subscribe, snapshot, snapshot);
    const palette = accentColors[saved.accent];
    const background = surface ?? theme?.colors.surface0 ?? "#fff";
    const color = contrast(palette.dark, background) > contrast(palette.light, background) ? palette.dark : palette.light;
    if (Platform.OS !== "web" && !angle) {
      progress = new Animated.Value(0);
      angle = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
    }
    useEffect(mount, []);
    const stroke = Math.max(1, size / 12);
    const middle = size / 2;
    const hand = <View style={{
      position: "absolute", left: middle - stroke / 2, top: size * 0.19,
      width: stroke, height: size * 0.31 + stroke / 2,
      backgroundColor: color, borderRadius: stroke / 2,
    }} />;
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
        {angle ? (
          <Animated.View style={{ width: size, height: size, transform: [{ rotate: angle }] }}>{hand}</Animated.View>
        ) : (
          <View testID={saved.animate ? "paseo-heartbeat-fallback-hand" : undefined} style={{ width: size, height: size }}>{hand}</View>
        )}
      </View>
    );
  }

  return {
    Icon: ClockIcon,
    setSettings(next: HeartbeatSettings) {
      if (disposed || (settings.accent === next.accent && settings.animate === next.animate)) return;
      settings = next;
      for (const listener of subscribers) listener();
    },
    dispose() {
      disposed = true;
      stop?.();
      stop = undefined;
      subscribers.clear();
    },
  };
}
