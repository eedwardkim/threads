import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "../lib/math";

const inline = String.raw`\(x^2\)`;
const display = String.raw`\[\binom{15}{3}=\boxed{455}\]`;

describe("math delimiter normalization", () => {
  it.each([
    [inline, "$x^2$"],
    [`Answer: ${inline}.`, "Answer: $x^2$."],
    [display, "$$\n\\binom{15}{3}=\\boxed{455}\n$$"],
    [`Before ${display} after.`, "Before \n$$\n\\binom{15}{3}=\\boxed{455}\n$$\n after."],
    ["\\[\n  a + b = c\n\\]", "$$\na + b = c\n$$"],
    ["\\[\n    a + b = c\n\\]", "$$\na + b = c\n$$"],
    [`${inline} and ${inline}`, "$x^2$ and $x^2$"],
    [String.raw`\(x \\ y\)`, String.raw`$x \\ y$`],
    [String.raw`\(\$5\)`, String.raw`$\$5$`],
    ["`code`\\[x\\]`code`", "`code`\n$$\nx\n$$\n`code`"],
    ["`code`\\[x\\]", "`code`\n$$\nx\n$$"],
  ])("converts paired math in %j", (source, expected) => {
    expect(normalizeMathDelimiters(source)).toBe(expected);
    expect(normalizeMathDelimiters(expected)).toBe(expected);
  });

  it.each([
    "Plain text and $5 prices.",
    String.raw`$x^2$ and $$\frac{a}{b}$$`,
    String.raw`$\text{literal \(x\)}$`,
    String.raw`\\(not math\\) and \\[not math\\]`,
    String.raw`\(unfinished and \[unfinished`,
    String.raw`stray \) and \]`,
    String.raw`\(\) and \[  \]`,
    `\`${inline}\``,
    `\`\`literal \` ${display}\`\``,
    `\`multiline\n${inline}\ncode\``,
    `\`\`\`latex\n${display}\n\`\`\``,
    `~~~~latex\n${inline}\n~~~\n${display}\n~~~~`,
    `\`\`\`\`text\n\`\`\`\n${inline}\n\`\`\`\``,
    `\`\`\`latex\n${display}`,
    `> \`\`\`latex\n> ${inline}\n> \`\`\``,
    `- \`\`\`latex\n  ${inline}\n  \`\`\``,
    `    ${inline}\n\t${display}`,
  ])("preserves code, existing math, and incomplete delimiters in %j", (source) => {
    expect(normalizeMathDelimiters(source)).toBe(source);
  });

  it("normalizes prose after fenced and inline code", () => {
    const code = `~~~latex\n${display}\n~~~~`;
    expect(normalizeMathDelimiters(`${code}\n${inline} and \`${inline}\` then ${inline}`))
      .toBe(`${code}\n$x^2$ and \`${inline}\` then $x^2$`);
  });

  it("does not pair delimiters across code", () => {
    const source = String.raw`\(before ` + "`code`" + String.raw` after\)`;
    expect(normalizeMathDelimiters(source)).toBe(source);
  });

  it("does not let an unmatched code marker hide subsequent math", () => {
    expect(normalizeMathDelimiters(`Unmatched \` then ${inline}`)).toBe("Unmatched ` then $x^2$");
  });
});
