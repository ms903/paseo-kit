import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCcusageFailure } from "../plugins/ccusage-stats/server/ccusage";

test("identifies ccusage timeouts, termination signals, and quiet exit codes", () => {
  assert.equal(describeCcusageFailure({ killed: true, signal: "SIGTERM" }, ""), "ccusage timed out after 60 seconds");
  assert.equal(describeCcusageFailure({ signal: "SIGKILL" }, ""), "ccusage was terminated (SIGKILL)");
  assert.equal(describeCcusageFailure({ code: 1 }, ""), "ccusage exited (1)");
  assert.equal(describeCcusageFailure({ code: 2 }, "invalid timezone\n"), "ccusage exited (2). invalid timezone");
  assert.equal(describeCcusageFailure({ code: "ENOENT" }, ""), "ccusage executable was not found");
  assert.equal(describeCcusageFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, ""), "ccusage output exceeded the size limit");
});
