/**
 * Converts LaTeX (as written in `$…$` / `$$…$$`) into the words a tutor would say when reading it
 * aloud. Rule-based on purpose: deterministic, zero-latency, and good enough that a TTS model stops
 * spelling out backslashes. Unknown commands degrade to their bare name rather than being dropped.
 */

const SYMBOLS: Record<string, string> = {
  alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta", epsilon: "epsilon", varepsilon: "epsilon", zeta: "zeta", eta: "eta",
  theta: "theta", vartheta: "theta", iota: "iota", kappa: "kappa", lambda: "lambda", mu: "mu", nu: "nu", xi: "xi", pi: "pi", rho: "rho",
  sigma: "sigma", tau: "tau", upsilon: "upsilon", phi: "phi", varphi: "phi", chi: "chi", psi: "psi", omega: "omega",
  Gamma: "capital gamma", Delta: "capital delta", Theta: "capital theta", Lambda: "capital lambda", Xi: "capital xi", Pi: "capital pi",
  Sigma: "capital sigma", Phi: "capital phi", Psi: "capital psi", Omega: "capital omega",
  cdot: "times", times: "times", div: "divided by", pm: "plus or minus", mp: "minus or plus", ast: "star", circ: "composed with",
  leq: "is less than or equal to", le: "is less than or equal to", geq: "is greater than or equal to", ge: "is greater than or equal to",
  neq: "is not equal to", ne: "is not equal to", approx: "is approximately", equiv: "is equivalent to", sim: "is similar to",
  propto: "is proportional to", ll: "is much less than", gg: "is much greater than",
  infty: "infinity", to: "goes to", rightarrow: "goes to", leftarrow: "comes from", Rightarrow: "implies", implies: "implies",
  Leftrightarrow: "if and only if", iff: "if and only if", mapsto: "maps to", longrightarrow: "goes to",
  in: "in", notin: "not in", subset: "is a subset of", subseteq: "is a subset of", supset: "is a superset of", supseteq: "is a superset of",
  cup: "union", cap: "intersect", setminus: "minus", emptyset: "the empty set", varnothing: "the empty set",
  forall: "for all", exists: "there exists", nexists: "there does not exist", neg: "not", lnot: "not", land: "and", lor: "or",
  wedge: "and", vee: "or", oplus: "x or", otimes: "tensor",
  partial: "partial", nabla: "del", angle: "angle", perp: "perpendicular to", parallel: "parallel to", degree: "degrees",
  ldots: "dot dot dot", cdots: "dot dot dot", dots: "dot dot dot", vdots: "and so on", ddots: "and so on",
  prime: "prime", hbar: "h bar", ell: "ell", Re: "the real part of", Im: "the imaginary part of",
  mid: "given", vert: "bar", lvert: "the absolute value of", rvert: "", lVert: "the norm of", rVert: "", langle: "the inner product of", rangle: "",
  lfloor: "the floor of", rfloor: "", lceil: "the ceiling of", rceil: "",
  sin: "sine", cos: "cosine", tan: "tangent", cot: "cotangent", sec: "secant", csc: "cosecant", arcsin: "arc sine", arccos: "arc cosine",
  arctan: "arc tangent", sinh: "hyperbolic sine", cosh: "hyperbolic cosine", tanh: "hyperbolic tangent",
  log: "log", ln: "the natural log of", lg: "log", exp: "e to the", det: "the determinant of", dim: "the dimension of", ker: "the kernel of",
  deg: "the degree of", gcd: "the g c d of", max: "the maximum of", min: "the minimum of", sup: "the supremum of", inf: "the infimum of",
  arg: "the argument of", Pr: "the probability of", mod: "mod", pmod: "mod", bmod: "mod",
  quad: " ", qquad: " ", ",": " ", ";": " ", ":": " ", "!": "", " ": " ", left: "", right: "", big: "", Big: "", bigl: "", bigr: "", Bigl: "", Bigr: "",
  displaystyle: "", textstyle: "", scriptstyle: "", limits: "", nolimits: "", "%": "percent", "&": "and", "#": "number", "$": "dollars",
  "{": "the set of", "}": "", "|": "the norm of", "\\": ". ",
};

const BLACKBOARD: Record<string, string> = { R: "the real numbers", N: "the natural numbers", Z: "the integers", Q: "the rationals", C: "the complex numbers", P: "the primes", E: "the expected value" };
const BIG_OPERATORS: Record<string, string> = { sum: "the sum", prod: "the product", int: "the integral", iint: "the double integral", oint: "the contour integral", bigcup: "the union", bigcap: "the intersection", coprod: "the coproduct" };
const COMMON_FRACTIONS: Record<string, string> = { "1/2": "one half", "1/3": "one third", "2/3": "two thirds", "1/4": "one quarter", "3/4": "three quarters" };
const ACCENTS: Record<string, string> = { hat: "hat", bar: "bar", vec: "vector", tilde: "tilde", dot: "dot", ddot: "double dot", overline: "bar", underline: "underlined", widehat: "hat", widetilde: "tilde" };
const STYLES = new Set(["mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "mathfrak", "boldsymbol", "bm", "textbf", "textit", "textrm", "textsf", "texttt", "operatorname", "mathop", "mbox", "text"]);
const MATRIX_ENVIRONMENTS = new Set(["matrix", "pmatrix", "bmatrix", "vmatrix", "Bmatrix", "Vmatrix", "smallmatrix", "array"]);

interface Cursor { source: string; index: number }

function peek(cursor: Cursor): string {
  return cursor.source[cursor.index] ?? "";
}

function skipSpaces(cursor: Cursor) {
  while (/\s/.test(peek(cursor))) cursor.index += 1;
}

/** Reads one "atom": a `{…}` group, a `\command` (with its own arguments when known), or a single character. */
function readAtom(cursor: Cursor): string {
  skipSpaces(cursor);
  const char = peek(cursor);
  if (!char) return "";
  if (char === "{") return readGroup(cursor);
  if (char === "\\") return readCommand(cursor);
  cursor.index += 1;
  return spokenCharacter(char, cursor);
}

function readGroup(cursor: Cursor): string {
  cursor.index += 1; // "{"
  const inner = readSequence(cursor, "}");
  cursor.index += 1; // "}"
  return inner;
}

function readRawGroup(cursor: Cursor): string {
  skipSpaces(cursor);
  if (peek(cursor) !== "{") return "";
  let depth = 0;
  const start = cursor.index;
  for (; cursor.index < cursor.source.length; cursor.index += 1) {
    const char = cursor.source[cursor.index];
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) { cursor.index += 1; break; }
  }
  return cursor.source.slice(start + 1, cursor.index - 1);
}

function readOptional(cursor: Cursor): string | null {
  skipSpaces(cursor);
  if (peek(cursor) !== "[") return null;
  const end = cursor.source.indexOf("]", cursor.index);
  if (end < 0) return null;
  const inner = cursor.source.slice(cursor.index + 1, end);
  cursor.index = end + 1;
  return spokenMath(inner);
}

function readScript(cursor: Cursor, marker: "^" | "_"): string | null {
  skipSpaces(cursor);
  if (peek(cursor) !== marker) return null;
  cursor.index += 1;
  return readAtom(cursor);
}

function readScripts(cursor: Cursor): { sub: string | null; sup: string | null } {
  let sub: string | null = null;
  let sup: string | null = null;
  for (let i = 0; i < 2; i += 1) {
    const next = readScript(cursor, "_");
    if (next !== null) sub = next;
    const up = readScript(cursor, "^");
    if (up !== null) sup = up;
  }
  return { sub, sup };
}

function ordinal(value: string): string {
  if (value === "3") return "cube";
  if (/^\d+$/.test(value)) return `${value}th`;
  return `${value}th`;
}

function spokenPower(base: string, exponent: string): string {
  const plain = exponent.trim();
  if (plain === "2") return `${base} squared`;
  if (plain === "3") return `${base} cubed`;
  if (plain === "T" || plain === "top") return `${base} transpose`;
  if (plain === "minus 1") return `${base} inverse`;
  if (plain === "prime") return `${base} prime`;
  if (plain === "star" || plain === "*") return `${base} star`;
  if (plain === "dagger") return `${base} dagger`;
  return `${base} to the power of ${plain}`;
}

function readCommand(cursor: Cursor): string {
  cursor.index += 1; // "\"
  const match = /^([A-Za-z]+|.)/.exec(cursor.source.slice(cursor.index));
  if (!match) return "";
  const name = match[1];
  cursor.index += name.length;

  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const numerator = readAtom(cursor);
    const denominator = readAtom(cursor);
    const common = COMMON_FRACTIONS[`${numerator}/${denominator}`];
    if (common) return common;
    return simple(numerator) && simple(denominator) ? `${numerator} over ${denominator}` : `the fraction ${numerator}, over ${denominator},`;
  }
  if (name === "binom") return `${readAtom(cursor)} choose ${readAtom(cursor)}`;
  if (name === "sqrt") {
    const degree = readOptional(cursor);
    const radicand = readAtom(cursor);
    return degree ? `the ${ordinal(degree)} root of ${radicand}` : `the square root of ${radicand}`;
  }
  if (name in BIG_OPERATORS) {
    const { sub, sup } = readScripts(cursor);
    const label = BIG_OPERATORS[name];
    if (sub && sup) return `${label} from ${sub} to ${sup} of`;
    if (sub) return `${label} over ${sub} of`;
    return `${label} of`;
  }
  if (name === "lim" || name === "limsup" || name === "liminf") {
    const { sub } = readScripts(cursor);
    const label = name === "lim" ? "the limit" : name === "limsup" ? "the limit superior" : "the limit inferior";
    return sub ? `${label} as ${sub} of` : `${label} of`;
  }
  if (name === "mathbb" || name === "mathbbm") {
    const letters = readRawGroup(cursor).trim();
    return BLACKBOARD[letters] ?? `blackboard ${letters}`;
  }
  if (name in ACCENTS) return `${readAtom(cursor)} ${ACCENTS[name]}`;
  if (STYLES.has(name)) {
    const raw = readRawGroup(cursor);
    return name === "text" || name === "mbox" || name.startsWith("text") ? raw.trim() : spokenMath(raw);
  }
  if (name === "begin") {
    const environment = readRawGroup(cursor).replace("*", "");
    if (MATRIX_ENVIRONMENTS.has(environment)) {
      if (environment === "array") readRawGroup(cursor);
      return "the matrix with rows:";
    }
    if (environment === "cases") return "the cases:";
    if (environment === "aligned" || environment === "align" || environment === "gathered" || environment === "split" || environment === "equation") return "";
    return "";
  }
  if (name === "end") { readRawGroup(cursor); return "."; }
  if (name === "not") return `not ${readAtom(cursor)}`;
  if (name === "over") return "over";
  if (name === "phantom" || name === "hphantom" || name === "vphantom" || name === "label" || name === "tag") { readRawGroup(cursor); return ""; }
  if (name === "color" || name === "textcolor") { readRawGroup(cursor); return ""; }
  if (name in SYMBOLS) return SYMBOLS[name];
  return name;
}

function simple(value: string): boolean {
  return value.trim().split(/\s+/).length <= 2;
}

function spokenCharacter(char: string, cursor: Cursor): string {
  switch (char) {
    case "=": return "equals";
    case "+": return "plus";
    case "-": case "−": return "minus";
    case "*": return "times";
    case "/": return "over";
    case "<": return "is less than";
    case ">": return "is greater than";
    case "!": return "factorial";
    case "'": return "prime";
    case "(": case "[": return ",";
    case ")": case "]": return ",";
    case "|": return "bar";
    case "&": return ",";
    case "~": return " ";
    case ",": return ",";
    case ".": return /\d/.test(peek(cursor)) ? "." : ".";
    case ":": return "such that";
    case ";": return ";";
    default: return /^[A-Za-z]$/.test(char) ? char : char;
  }
}

function join(parts: string[]): string {
  return parts.filter((part) => part !== "").join(" ").replace(/\s+/g, " ").trim();
}

const FUNCTION_NAME = /(^|\s)([fghFGHPQuv](?: prime)*|sine|cosine|tangent|log|exp)$/;

/** Reads atoms until `terminator` (or the end), attaching `^`/`_` scripts, pairing `|…|`, and reading digits as numbers. */
function readSequence(cursor: Cursor, terminator: string | null): string {
  const parts: string[] = [];
  let digits = "";
  let absoluteOpen = false;
  const flushDigits = () => { if (digits) { parts.push(digits); digits = ""; } };
  while (cursor.index < cursor.source.length) {
    skipSpaces(cursor);
    const char = peek(cursor);
    if (!char || char === terminator) break;
    if (/\d/.test(char) || (char === "." && /\d/.test(cursor.source[cursor.index + 1] ?? ""))) {
      digits += char;
      cursor.index += 1;
      continue;
    }
    flushDigits();
    if (char === "^" || char === "_") {
      const base = parts.pop() ?? "";
      const { sub, sup } = readScripts(cursor);
      parts.push(spokenScripts(base, sub, sup));
      continue;
    }
    if (char === "}") { cursor.index += 1; continue; }
    if (char === "|" && !cursor.source.startsWith("\\|", cursor.index - 1)) {
      cursor.index += 1;
      parts.push(absoluteOpen ? "," : "the absolute value of");
      absoluteOpen = !absoluteOpen;
      continue;
    }
    if (char === "(" && FUNCTION_NAME.test(join(parts))) {
      cursor.index += 1;
      parts.push("of");
      continue;
    }
    let atom = readAtom(cursor);
    if (atom === "") continue;
    if (/^\s*[_^]/.test(cursor.source.slice(cursor.index))) {
      const { sub, sup } = readScripts(cursor);
      atom = spokenScripts(atom, sub, sup);
    }
    parts.push(atom);
  }
  flushDigits();
  return join(parts);
}

/** Reads a whole LaTeX expression into spoken words. */
export function spokenMath(latex: string): string {
  return readSequence({ source: latex, index: 0 }, null)
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,.;])(?:\s*[,.;])+/g, "$1")
    .replace(/^[,.;]\s*/, "")
    .replace(/[,;]\s*$/, "");
}

function spokenScripts(base: string, sub: string | null, sup: string | null): string {
  if (base.endsWith(",") && sub && sup) return `${base} evaluated from ${sub} to ${sup},`;
  let result = base;
  if (sub) result = `${result} sub ${sub}`;
  if (sup) result = spokenPower(result, sup);
  return result;
}
