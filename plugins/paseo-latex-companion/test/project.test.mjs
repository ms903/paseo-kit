import assert from "node:assert/strict";
import test from "node:test";
import { displayFormula, inlineFormulas, projectTable, renderCell } from "../client/project.ts";

test("extracts complete math without interpreting code, URLs, currency or escaped dollars", () => {
  const line = String.raw`**$q_E/q_K$** and \(v=1\) and [the $x$](https://example.org/$u$)`
    + " and `$code$`"
    + String.raw` <code>$source$</code> $10 and $20, \$a\$ and unfinished $z.`;
  const formulas = inlineFormulas(line);
  assert.deepEqual(formulas.map(({ tex }) => tex), ["q_E/q_K", "v=1", "x"]);
  for (const formula of formulas) assert.equal(line.slice(formula.start, formula.end), formula.raw);
  assert.deepEqual(inlineFormulas("~~~text\n$x$\n~~~~\n$y$\n```js\n$z$").map(f => f.tex), ["y"]);
});

test("recovers raw table columns before Better Paseo splits pipes inside TeX", () => {
  const tex = String.raw`\eta\lambda_E \ge |X_E^\top r_K|_\infty/n`;
  const lines = ["| 指标 | 条件 $|x|$ | 结果 |", "| --- | :--- | ---: |",
    "| KKT | **$" + tex + "$** | EMG 归零 |",
    String.raw`| 转义 \| | \(\|x\|\) | 保留 |`];
  assert.deepEqual(projectTable(lines.join("\r\n")), {
    header: ["指标", "条件 $|x|$", "结果"],
    rows: [["KKT", "**$" + tex + "$**", "EMG 归零"], [String.raw`转义 \|`, String.raw`\(\|x\|\)`, "保留"]]
  });
  assert.deepEqual(projectTable("A | B\n--|--\n$x | y$"), { header: ["A", "B"], rows: [["$x", "y$"]] });
  assert.equal(projectTable("| paragraph | with pipes |\nnext line"), null);
});

test("recognizes standalone display delimiters and waits for a close", () => {
  assert.equal(displayFormula("$$\r\nx^2\r\n$$\n"), "x^2");
  assert.equal(displayFormula(String.raw`\[a=b\]`), "a=b");
  assert.equal(displayFormula("$$\nx^"), null);
  assert.equal(displayFormula("plain $$x$$"), null);
  assert.equal(displayFormula("$$x$$ and $$y$$"), null);
});

test("projects emphasis and formula nodes while keeping raw HTML inert", () => {
  const node = (tag) => ({ tag, children: [], append(...children) { this.children.push(...children.filter(Boolean)); } });
  const document = { createDocumentFragment: () => node("#fragment"), createElement: node };
  const fragment = renderCell('**$a*b$** and `$code$` <img src=x> [a](javascript:alert)', document,
    (tex, display) => ({ tex, display }));
  const first = fragment.children[0];
  assert.equal(first.tag, "strong");
  assert.deepEqual(first.children, [{ tex: "a*b", display: false }]);
  assert.equal(fragment.children.find(child => child.tag === "code").textContent, "$code$");
  assert.ok(fragment.children.includes("<img src=x>"));
  assert.ok(!fragment.children.some(child => child.tag === "a"));
});
