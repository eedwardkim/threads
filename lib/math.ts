function normalizeProse(source: string, before = "", after = ""): string {
  let result = "";
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "\\") continue;
    const opener = source[index + 1];
    if (opener !== "(" && opener !== "[") {
      index++;
      continue;
    }
    const closer = opener === "(" ? ")" : "]";
    let end = index + 2;
    for (; end < source.length; end++) {
      if (source[end] !== "\\") continue;
      if (source[end + 1] === closer) break;
      end++;
    }
    if (end >= source.length) continue;
    const body = source.slice(index + 2, end).trim();
    if (!body) continue;
    const previous = source[index - 1] ?? before;
    const next = source[end + 2] ?? after;
    result += source.slice(start, index);
    result += opener === "(" ? `$${body}$` : `${previous && previous !== "\n" ? "\n" : ""}$$\n${body}\n$$${next && next !== "\n" ? "\n" : ""}`;
    start = end + 2;
    index = end + 1;
  }
  return result + source.slice(start);
}

export function normalizeMathDelimiters(source: string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  let mathCloser: string | null = null;
  while (index < source.length) {
    let end = index;
    if (index === 0 || source[index - 1] === "\n") {
      const line = source.slice(index, source.indexOf("\n", index) < 0 ? source.length : source.indexOf("\n", index) + 1);
      const fence = /^(?: {0,3}> ?)*[ \t]*(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(line);
      if (fence) {
        const close = new RegExp(`^(?: {0,3}> ?)*[ \\t]*${fence[1][0]}{${fence[1].length},}[ \\t]*\\r?$`, "gm");
        close.lastIndex = index + line.length;
        const match = close.exec(source);
        end = match ? match.index + match[0].length : source.length;
      } else if (!mathCloser && /^(?: {4}|\t)/.test(line)) {
        end = index + line.length;
      }
    }
    if (end === index && (source[index] === "`" || source[index] === "$")) {
      const character = source[index];
      const runs = character === "`" ? /`+/g : /\$+/g;
      runs.lastIndex = index;
      const opener = runs.exec(source)!;
      for (let match = runs.exec(source); match; match = runs.exec(source)) {
        if (match[0].length === opener[0].length) {
          end = match.index + match[0].length;
          break;
        }
      }
      if (end === index) {
        index += opener[0].length;
        continue;
      }
    }
    if (end > index) {
      parts.push(normalizeProse(source.slice(start, index), source[start - 1], source[index]), source.slice(index, end));
      start = index = end;
      mathCloser = null;
    } else if (source[index] === "\\") {
      const next = source[index + 1];
      if (next === mathCloser) mathCloser = null;
      else if (!mathCloser && (next === "(" || next === "[")) mathCloser = next === "(" ? ")" : "]";
      index += 2;
    } else {
      index++;
    }
  }
  parts.push(normalizeProse(source.slice(start), source[start - 1]));
  return parts.join("");
}
