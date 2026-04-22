import assert from "node:assert/strict";

import { normalizeRenderableMarkdown, sanitizeMindMapLabel } from "../src/utils.ts";

function run(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

run("decodes html entities and escaped newlines in markdown content", () => {
  const normalized = normalizeRenderableMarkdown("第一行\\n第二行 &hellip; &#x4E2D;&#25991;");

  assert.equal(normalized, "第一行\n第二行 ... 中文");
});

run("wraps bare latex runs in prose without touching existing markdown math", () => {
  const normalized = normalizeRenderableMarkdown("记作 \\{x_1, x_2, x_3, &hellip;\\}，并且已有公式 $f(x)$。");

  assert.equal(normalized, "记作 $\\{x_1, x_2, x_3, ...\\}$，并且已有公式 $f(x)$。");
});

run("wraps math-like markdown table cells for katex rendering", () => {
  const normalized = normalizeRenderableMarkdown("| 示例 | 通项公式 |\n| --- | --- |\n| \\frac{1}{2}, \\frac{2}{3}, &hellip; | x_n = \\frac{n}{n+1} |");

  assert.equal(
    normalized,
    "| 示例 | 通项公式 |\n| --- | --- |\n| $\\frac{1}{2}, \\frac{2}{3}, ...$ | $x_n = \\frac{n}{n+1}$ |",
  );
});

run("repairs broken full-line math with nested dollar fences", () => {
  const normalized = normalizeRenderableMarkdown("\\lim_{n \\to \\infty} x_n = a \\iff \\forall \\varepsilon > 0, \\exists N \\in \\mathbb{N}^+, \\text{当 } n > N \\text{ 时，有 } |$x_n - a$| < \\varepsilon");

  assert.equal(
    normalized,
    "$\\lim_{n \\to \\infty} x_n = a \\iff \\forall \\varepsilon > 0, \\exists N \\in \\mathbb{N}^+, \\text{当 } n > N \\text{ 时，有 } \\lvert x_n - a \\rvert < \\varepsilon$",
  );
});

run("repairs quoted formulas that lost the leading slash", () => {
  const normalized = normalizeRenderableMarkdown("视频通过\"\\frac{1}{n} o 0\"这一典型例子说明问题。".replace("\\f", "\f"));

  assert.equal(normalized, "视频通过\"$\\frac{1}{n} \\to 0$\"这一典型例子说明问题。");
});

run("collapses redundant dollar delimiters without wrapping prose lines", () => {
  const normalized = normalizeRenderableMarkdown("> $$\\left|\\frac{1}{n} - 0\\right| = \\frac{1}{n} < \\varepsilon$$$\n> 故 $\\lim_{n \\to \\infty} \\frac{1}{n} = 0。$");

  assert.equal(normalized, "> $$\\left|\\frac{1}{n} - 0\\right| = \\frac{1}{n} < \\varepsilon$$\n> 故 $\\lim_{n \\to \\infty} \\frac{1}{n} = 0。$");
});

run("repairs common llm markdown emphasis artifacts", () => {
  const normalized = normalizeRenderableMarkdown("结论：你最近更像是\\*\\*数学基础 + 机器学习实战 + AI前沿认知\\*\\*==");

  assert.equal(normalized, "结论：你最近更像是**数学基础 + 机器学习实战 + AI前沿认知**");
});

run("converts highlight marks into portable markdown emphasis", () => {
  const normalized = normalizeRenderableMarkdown("学习重心是==高等数学与OpenCV==，公式为 \\(x_n = \\frac{n}{n+1}\\)。");

  assert.equal(normalized, "学习重心是**高等数学与OpenCV**，公式为 $x_n = \\frac{n}{n+1}$。");
});

run("repairs truncated mindmap labels before rendering", () => {
  const sanitized = sanitizeMindMapLabel(
    "核心公式$f(x_0+\\Delta$ x)\\app",
    "说明微分的核心近似公式与线性主部。",
  );

  assert.equal(sanitized, "核心公式$f(x_0+\\Delta x)$");
});
