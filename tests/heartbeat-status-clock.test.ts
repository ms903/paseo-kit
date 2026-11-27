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

test("mounted fallback clocks share ticks, keep the dial fixed, and pause for motion preferences or backgrounding", async () => {
  const bundle = await build({
    entryPoints: ["plugins/heartbeat-status/client/clock.tsx"],
    bundle: true, platform: "node", format: "cjs", write: false, packages: "external",
  });
  const visibility = signal<string>();
  const motion = signal<boolean>();
  let initialMotion!: (reduced: boolean) => void;
  const timers = new Set<() => void>();
  let subscribe!: (listener: () => void) => () => void;
  type Node = { props: { style: { transform?: { rotate: string }[] }; children: Node[] } };
  const jsx = (_type: unknown, props: Node["props"]) => ({ props });
  const modules: Record<string, unknown> = {
    react: { useSyncExternalStore: (register: typeof subscribe, get: () => number) => {
      subscribe = register;
      return get();
    } },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View",
      AppState: { currentState: "active", addEventListener: visibility.subscribe },
      AccessibilityInfo: {
        isReduceMotionEnabled: () => new Promise<boolean>((resolve) => { initialMotion = resolve; }),
        addEventListener: motion.subscribe,
      },
    },
  };
  const module = { exports: {} as { createClockIcon(): {
    Icon(props: { size: number; color: string }): Node;
    dispose(): void;
  } } };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: (name: string) => modules[name],
    setInterval(callback: () => void, delay: number) {
      assert.equal(delay, 1000);
      timers.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => timers.delete(callback),
  });
  const clock = module.exports.createClockIcon();
  const face = () => clock.Icon({ size: 12, color: "#777" }).props.children;
  const angle = () => face()[2].props.style.transform?.[0].rotate;
  assert.equal(angle(), "0deg");
  assert.equal(visibility.count(), 0);
  const first = subscribe(() => {});
  const second = subscribe(() => {});
  assert.equal(visibility.count(), 1);
  assert.equal(motion.count(), 1);
  assert.equal(timers.size, 0);
  motion.emit(true);
  initialMotion(false); // An older asynchronous read must not override a live setting change.
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(timers.size, 0);

  motion.emit(false);
  assert.equal(timers.size, 1);
  const dial = JSON.stringify(face().slice(0, 2));
  for (const tick of timers) tick();
  assert.equal(angle(), "45deg");
  assert.equal(JSON.stringify(face().slice(0, 2)), dial);
  visibility.emit("background");
  assert.equal(timers.size, 0);
  assert.equal(angle(), "0deg");
  visibility.emit("active");
  assert.equal(timers.size, 1);
  motion.emit(true);
  assert.equal(timers.size, 0);
  motion.emit(false);
  first();
  assert.equal(timers.size, 1);
  second();
  assert.equal(timers.size, 0);
  assert.equal(visibility.count(), 0);
  assert.equal(motion.count(), 0);

  subscribe(() => {});
  clock.dispose();
  initialMotion(false); // Resolving after plugin unload cannot restart the clock.
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(timers.size, 0);
  assert.equal(visibility.count(), 0);
  assert.equal(motion.count(), 0);
});
