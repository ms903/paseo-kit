import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

function signal<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe: (_event: string, callback: (value: T) => void) => {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
    emit: (value: T) => listeners.forEach((listener) => listener(value)),
    count: () => listeners.size,
  };
}

test("mounted native clocks share one continuous UI-thread sweep and stop for reduced motion, backgrounding and unmount", async () => {
  const bundle = await build({
    entryPoints: ["plugins/heartbeat-status/client/clock.tsx"],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["react", "react/*", "react-native", "@getpaseo/plugin"],
  });
  const visibility = signal<string>();
  const motion = signal<boolean>();
  let initialMotion!: (reduced: boolean) => void;
  const loops = new Set<unknown>();
  const linear = (fraction: number) => fraction;
  type Timing = { duration: number; toValue: number; easing: typeof linear; useNativeDriver: boolean; isInteraction: boolean };
  let timing: Timing | undefined;
  let mounts = 0;
  let mount!: () => () => void;
  class Value {
    constructor(public current: number) {}
    setValue(current: number) { this.current = current; }
    interpolate(config: object) { return { source: this, config }; }
  }
  type Rotation = ReturnType<Value["interpolate"]>;
  type Node = { type: string; props: { style: { transform?: { rotate: Rotation }[] }; children: Node[] } };
  const jsx = (type: string, props: Node["props"]) => ({ type, props });
  let os = "ios";
  const modules: Record<string, unknown> = {
    "@getpaseo/plugin": { defineSettings: (definition: unknown) => definition },
    react: {
      useEffect(effect: typeof mount) { mounts++; mount = effect; },
      useSyncExternalStore: (_sub: unknown, read: () => unknown) => read(),
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View", Platform: { get OS() { return os; } }, Easing: { linear },
      Animated: {
        View: "AnimatedView", Value,
        timing(_source: Value, config: Timing) { timing = config; return config; },
        loop(config: Timing) {
          assert.ok(!loops.size, "A second mounted icon must reuse the first animation");
          return { start: () => loops.add(config), stop: () => loops.delete(config) };
        },
      },
      AppState: { currentState: "active", addEventListener: visibility.subscribe },
      AccessibilityInfo: {
        isReduceMotionEnabled: () => new Promise<boolean>((resolve) => { initialMotion = resolve; }),
        addEventListener: motion.subscribe,
      },
    },
  };
  const module = { exports: {} as { createClockIcon(): {
    Icon(props: { size: number; color: string; surface?: string }): Node;
    setSettings(value: { accent: string; animate: boolean }): void;
    dispose(): void;
  } } };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: (name: string) => modules[name],
  });
  const clock = module.exports.createClockIcon();
  const face = (surface = "#fff") => clock.Icon({ size: 12, color: "#777", surface }).props.children;
  assert.equal(visibility.count(), 0);
  const [dial, shortHand, longHand] = face();
  assert.equal(dial.type, "View");
  assert.equal(shortHand.type, "View");
  assert.equal(longHand.type, "AnimatedView");
  const rotation = longHand.props.style.transform![0].rotate;
  assert.deepEqual(JSON.parse(JSON.stringify(rotation.config)), { inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  assert.equal(rotation.source.current, 0);
  const first = mount();
  assert.equal(face()[2].props.style.transform![0].rotate, rotation);
  const second = mount();
  assert.equal(mounts, 2);
  assert.equal(visibility.count(), 1);
  assert.equal(motion.count(), 1);
  assert.equal(loops.size, 0);
  motion.emit(true);
  initialMotion(false); // An older asynchronous read must not override a live setting change.
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(loops.size, 0);

  motion.emit(false);
  assert.equal(loops.size, 1);
  assert.ok(timing);
  assert.equal(timing.duration, 6000);
  assert.equal(timing.toValue, 1);
  assert.equal(timing.useNativeDriver, true);
  assert.equal(timing.isInteraction, false);
  assert.equal(timing.easing, linear);
  assert.equal(timing.easing(1 / 120), 1 / 120);
  clock.setSettings({ accent: "violet", animate: false });
  assert.equal(loops.size, 0);
  const border = (surface: string) => (face(surface)[0].props.style as { borderColor?: string }).borderColor;
  assert.equal(border("#fff"), "#8A3FFC");
  assert.equal(border("#18181b"), "#D4BBFF");
  clock.setSettings({ accent: "violet", animate: true });
  assert.equal(loops.size, 1);
  rotation.source.current = 0.375;
  visibility.emit("background");
  assert.equal(loops.size, 0);
  assert.equal(rotation.source.current, 0);
  visibility.emit("active");
  assert.equal(loops.size, 1);
  motion.emit(true);
  assert.equal(loops.size, 0);
  motion.emit(false);
  first();
  assert.equal(loops.size, 1);
  second();
  assert.equal(loops.size, 0);
  assert.equal(visibility.count(), 0);
  assert.equal(motion.count(), 0);

  mount();
  clock.dispose();
  initialMotion(false); // Resolving after plugin unload cannot restart the clock.
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(loops.size, 0);
  assert.equal(visibility.count(), 0);
  assert.equal(motion.count(), 0);

  os = "web";
  const browserClock = module.exports.createClockIcon();
  const browserGlyph = browserClock.Icon({ size: 12, color: "#777" });
  assert.equal(browserGlyph.props.children[2].type, "View");
  assert.equal((browserGlyph.props.children[2].props as { testID?: string }).testID, "paseo-heartbeat-fallback-hand");
  browserClock.setSettings({ accent: "amber", animate: false });
  assert.equal((browserClock.Icon({ size: 12, color: "#777" }).props.children[2].props as { testID?: string }).testID, undefined);
  assert.equal(mount(), undefined, "Browser fallback delegates to CSS, including its reduced-motion query");
  browserClock.dispose();
});
