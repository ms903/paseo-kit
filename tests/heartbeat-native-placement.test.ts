import assert from "node:assert/strict";
import test from "node:test";
import { coversIdleDot, locateSidebarDot, temporarilyHideDot, type NativeElement } from "../plugins/heartbeat-status/client/native-placement";

const bounds = (x: number, y: number, width = 20, height = 20) => () => ({ x, y, width, height });

function fixture(status = "done") {
  const writes: number[] = [];
  const rowId = "sidebar-workspace-row-host:w1";
  const node = (testID?: string) => ({
    __internalInstanceHandle: { stateNode: { canonical: { currentProps: { testID, style: { opacity: 0.3 } } } } },
  });
  const dot = { ...node(), setNativeProps: ({ style }: { style: { opacity: number } }) => writes.push(style.opacity) };
  const slot = { ...node("workspace-status-indicator-" + status), firstElementChild: dot, getBoundingClientRect: bounds(12, 17) };
  const row = node(rowId);
  const layout = { ...node(), parentElement: row, firstElementChild: slot };
  const column = { ...node(), parentElement: layout };
  const titleMetadata = { ...node(), parentElement: column };
  const anchor: NativeElement = { ...node(), parentElement: titleMetadata, getBoundingClientRect: bounds(40, 37, 1, 1) };
  return { anchor, slot, rowId, writes };
}

test("centers the native clock in the same workspace status slot and restores the dot", () => {
  const { anchor, rowId, writes } = fixture();
  const result = locateSidebarDot(anchor, rowId, 12);
  assert.equal(result.kind, "idle");
  if (result.kind !== "idle") return;
  assert.deepEqual([result.x, result.y], [-24, -16]);
  assert.equal(coversIdleDot(result, { getBoundingClientRect: bounds(16, 21, 12, 12) }), true);
  assert.equal(coversIdleDot(result, { getBoundingClientRect: bounds(40, 37, 12, 12) }), false);
  const restore = temporarilyHideDot(result, 0.3);
  assert.deepEqual(writes, [0]);
  restore?.();
  assert.deepEqual(writes, [0, 0.3]);
});

test("does not write to running, selection, unrelated or recycled status views", () => {
  for (const status of ["loading", "running", "needs_input", "attention", "failed"]) {
    const { anchor, rowId, writes } = fixture(status);
    assert.equal(locateSidebarDot(anchor, rowId, 12).kind, "busy");
    assert.deepEqual(writes, []);
  }
  const { anchor, rowId, slot, writes } = fixture();
  assert.equal(locateSidebarDot(anchor, "sidebar-workspace-row-other:w1", 12).kind, "unsupported");
  const result = locateSidebarDot(anchor, rowId, 12);
  if (result.kind !== "idle") throw new Error("missing initial idle indicator");
  const restore = temporarilyHideDot(result, 0.3);
  slot.__internalInstanceHandle.stateNode.canonical.currentProps.testID = "workspace-status-indicator-running";
  restore?.();
  assert.deepEqual(writes, [0]);
  assert.equal(temporarilyHideDot(result, 0.3), undefined);
});
