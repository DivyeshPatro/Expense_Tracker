// Arithmetic in the amount field, so recording "dinner split three ways plus
// GST" doesn't mean leaving the app for a calculator.
//
// Hand-written tokenizer + recursive-descent parser. Deliberately NOT eval()
// or `new Function()`: this app has a strict CSP with no 'unsafe-eval' (see
// middleware.ts), the input is user-controlled, and a calculator that can
// reach `document` is a calculator that can be turned into something else.
// The parser below can only ever produce a number.
//
// Grammar (precedence climbing):
//
//   expr    := term (('+' | '-') term)*
//   term    := factor (('*' | '/') factor)*
//   factor  := ('-' | '+')* primary '%'*
//   primary := number | '(' expr ')'

import type { Paise } from "./money";

export type ExprResult = { ok: true; paise: Paise; isExpression: boolean } | { ok: false; error: string };

/** Longest input we'll even tokenize. An amount field has no legitimate use for more. */
const MAX_INPUT = 100;

type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: "+" | "-" | "*" | "/" }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "pct" };

class ParseError extends Error {}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " ") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      let dots = 0;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) {
        if (src[j] === ".") dots++;
        j++;
      }
      if (dots > 1) throw new ParseError("Check the decimal point");
      toks.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    // A leading "." — ".5" is a legitimate thing to type.
    if (c === ".") {
      let j = i + 1;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      if (j === i + 1) throw new ParseError("Check the decimal point");
      toks.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    // × and ÷ because phone keyboards offer them, and x because people type it
    if (c === "×" || c === "x" || c === "X") {
      toks.push({ t: "op", v: "*" });
      i++;
      continue;
    }
    if (c === "÷") {
      toks.push({ t: "op", v: "/" });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === "%") {
      toks.push({ t: "pct" });
      i++;
      continue;
    }
    throw new ParseError(`"${c}" isn't something I can calculate`);
  }
  return toks;
}

// The AST keeps percent as its own node rather than collapsing it during
// parsing, because what a percent MEANS depends on the operator it sits
// beside — see evaluate().
type Node =
  | { k: "num"; v: number }
  | { k: "neg"; a: Node }
  | { k: "pct"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; l: Node; r: Node };

function parse(toks: Tok[]): Node {
  let pos = 0;
  const peek = () => toks[pos];
  const eat = () => toks[pos++];

  function primary(): Node {
    const tok = peek();
    if (!tok) throw new ParseError("The expression is incomplete");
    if (tok.t === "num") {
      eat();
      return { k: "num", v: tok.v };
    }
    if (tok.t === "lparen") {
      eat();
      const inner = expr();
      const close = peek();
      if (!close || close.t !== "rparen") throw new ParseError("Missing a closing bracket");
      eat();
      return inner;
    }
    throw new ParseError("The expression is incomplete");
  }

  function factor(): Node {
    const tok = peek();
    if (tok && tok.t === "op" && (tok.v === "-" || tok.v === "+")) {
      eat();
      const inner = factor();
      return tok.v === "-" ? { k: "neg", a: inner } : inner;
    }
    let node = primary();
    while (peek()?.t === "pct") {
      eat();
      node = { k: "pct", a: node };
    }
    return node;
  }

  function term(): Node {
    let left = factor();
    for (;;) {
      const tok = peek();
      if (tok && tok.t === "op" && (tok.v === "*" || tok.v === "/")) {
        eat();
        left = { k: "bin", op: tok.v, l: left, r: factor() };
      } else return left;
    }
  }

  function expr(): Node {
    let left = term();
    for (;;) {
      const tok = peek();
      if (tok && tok.t === "op" && (tok.v === "+" || tok.v === "-")) {
        eat();
        left = { k: "bin", op: tok.v, l: left, r: term() };
      } else return left;
    }
  }

  const out = expr();
  if (pos !== toks.length) throw new ParseError("I couldn't read the whole expression");
  return out;
}

/**
 * Percent is context-sensitive, matching how calculators and spreadsheets
 * behave and how people actually talk about money:
 *
 *   2500 * 18%  → 450        (18% OF 2500 — the GST amount)
 *   2500 + 18%  → 2950       (2500 PLUS 18% of it — the GST-inclusive total)
 *   2500 - 10%  → 2250       (a 10% discount)
 *   18%         → 0.18       (no context; just a hundredth)
 *
 * "2500+18%" meaning 2500.18 would be technically consistent and practically
 * useless — nobody adds eighteen hundredths of a rupee to a bill. The live
 * preview under the field exists so this convention is never a guess: the
 * user sees the resolved figure before saving.
 */
function evaluate(n: Node): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "neg":
      return -evaluate(n.a);
    case "pct":
      return evaluate(n.a) / 100;
    case "bin": {
      const l = evaluate(n.l);
      // Percent on the right of + or - is read relative to the left side.
      if ((n.op === "+" || n.op === "-") && n.r.k === "pct") {
        const portion = l * (evaluate(n.r.a) / 100);
        return n.op === "+" ? l + portion : l - portion;
      }
      const r = evaluate(n.r);
      if (n.op === "/" && r === 0) throw new ParseError("Can't divide by zero");
      return n.op === "+" ? l + r : n.op === "-" ? l - r : n.op === "*" ? l * r : l / r;
    }
  }
}

/**
 * The paise a form should submit for whatever is currently in an amount field,
 * expression or not. 0 when it isn't a usable amount, matching the
 * `Number(x) || 0` idiom the forms used before.
 *
 * Exists because resolving the expression only on blur made submission depend
 * on event ordering: any path that submits without blurring first sent the raw
 * "2500+18%" into validation, which then reported "Enter a valid amount" while
 * the preview directly above it read "= ₹2,950". Reading through this instead
 * makes the submitted value independent of focus entirely.
 */
export function amountToPaise(raw: string): Paise {
  const r = evaluateAmount(raw);
  return r.ok ? r.paise : 0;
}

/** The operators a keypad can produce. The tokenizer already reads \u00d7 and \u00f7,
 *  so the string stays legible instead of carrying * and / the reader never typed. */
const KEY_OPS = ["+", "-", "\u00d7", "\u00f7"] as const;
const isKeyOp = (c: string) => (KEY_OPS as readonly string[]).includes(c);

/** Digits before the point, per operand. An amount field has no use for more. */
const MAX_OPERAND_INT_DIGITS = 9;
/** Money has two. Typing a third should do nothing rather than round later. */
const MAX_OPERAND_DECIMALS = 2;

/**
 * One keypad press against the current expression string.
 *
 * A keypad cannot let the reader put the caret anywhere, so the rules are
 * about the operand being typed right now — everything after the last
 * operator — rather than the string as a whole. That is what keeps "500+7" and
 * a bare "7" behaving identically.
 *
 * The states this exists to make unreachable:
 *   \u2022 "500++"      \u2014 a second operator REPLACES the trailing one
 *   \u2022 "+500"       \u2014 an operator with nothing to its left is ignored
 *   \u2022 "007"        \u2014 a lone leading zero is replaced by the first real digit
 *   \u2022 "1.2.3"      \u2014 one point per operand
 *   \u2022 "1.234"      \u2014 two decimal places per operand
 *
 * A trailing operator IS allowed: "500+" is what the string looks like between
 * two taps. It is not a valid expression, and evaluateAmount says so — which
 * is why the display reads through partialAmount() and the save through
 * evaluateAmount().
 */
export function pressAmountKey(cur: string, key: string): string {
  if (key === "clear") return "";
  if (key === "back") return cur.slice(0, -1);
  if (cur.length >= MAX_INPUT) return cur;

  if (isKeyOp(key)) {
    if (!cur) return cur; // nothing to operate on yet
    if (isKeyOp(cur[cur.length - 1])) return cur.slice(0, -1) + key; // swap, never doubled
    return cur + key;
  }

  // The operand under the cursor: everything since the last operator.
  let start = cur.length;
  while (start > 0 && !isKeyOp(cur[start - 1])) start--;
  const operand = cur.slice(start);

  if (key === ".") {
    if (operand.includes(".")) return cur;
    // ".5" is legible but "0.5" is what people mean, and the parser reads both.
    return operand === "" ? cur + "0." : cur + ".";
  }

  const digits = key === "00" ? "00" : key;
  if (!/^\d+$/.test(digits)) return cur; // an unknown key changes nothing

  const [int = "", dec] = operand.split(".");
  if (dec !== undefined) {
    const room = MAX_OPERAND_DECIMALS - dec.length;
    return room <= 0 ? cur : cur + digits.slice(0, room);
  }
  const allZero = /^0+$/.test(digits);
  if (int === "") return cur + (allZero ? "0" : digits);
  if (int === "0") return allZero ? cur : cur.slice(0, -1) + digits;
  if (int.length >= MAX_OPERAND_INT_DIGITS) return cur;
  return cur + digits.slice(0, MAX_OPERAND_INT_DIGITS - int.length);
}

/**
 * What an amount display should SHOW while an expression is still being typed.
 *
 * "500+" is not a valid expression and evaluateAmount rightly refuses it, but a
 * display that blanks the moment an operator is tapped is unusable \u2014 the
 * reader needs to see the \u20b9500 they are adding to. So an unparseable input is
 * retried with a trailing operator removed, and anything still unreadable
 * shows nothing rather than a guess.
 *
 * This is display only. Saving goes through evaluateAmount, which refuses the
 * incomplete string, so a half-typed sum can never be persisted.
 */
export function partialAmount(raw: string): Paise {
  const direct = evaluateAmount(raw);
  if (direct.ok) return direct.paise;
  const trimmed = raw.replace(/[+\-*/\u00d7\u00f7\s]+$/, "");
  if (!trimmed || trimmed === raw) return 0;
  const partial = evaluateAmount(trimmed);
  return partial.ok ? partial.paise : 0;
}

/** Does this input use any arithmetic, or is it just a number? Drives whether the preview shows. */
export function looksLikeExpression(raw: string): boolean {
  return /[+\-*/%()×÷xX]/.test(raw.replace(/^\s*-/, ""));
}

/**
 * Parse an amount, which may be an expression, into integer paise.
 *
 * Rounds once at the very end. Intermediate steps stay in float — an expense
 * calculator divides by 3 constantly, and rounding each step would drift.
 */
export function evaluateAmount(raw: string): ExprResult {
  const cleaned = raw.replace(/[₹,]/g, "").trim();
  if (!cleaned) return { ok: false, error: "Enter an amount" };
  if (cleaned.length > MAX_INPUT) return { ok: false, error: "That expression is too long" };

  let value: number;
  try {
    value = evaluate(parse(tokenize(cleaned)));
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : "That isn't a valid amount" };
  }

  if (!Number.isFinite(value)) return { ok: false, error: "That doesn't work out to a number" };
  if (value < 0) return { ok: false, error: "Amount can't be negative" };

  const paise = Math.round(value * 100);
  if (paise === 0) return { ok: false, error: "Enter an amount above zero" };
  // Beyond ~₹10 crore per transaction is far likelier to be a typo than real,
  // and BigInt columns aside, it makes every total unreadable.
  if (paise > 100_000_000_00) return { ok: false, error: "That amount is too large" };

  return { ok: true, paise, isExpression: looksLikeExpression(cleaned) };
}
