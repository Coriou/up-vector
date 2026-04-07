import type { Token, TokenType } from "./types";

const KEYWORDS: Record<string, TokenType> = {
  and: "AND",
  or: "OR",
  not: "NOT",
  glob: "GLOB",
  in: "IN",
  contains: "CONTAINS",
  has: "HAS",
  field: "FIELD",
  true: "TRUE",
  false: "FALSE",
};

const MAX_FILTER_LENGTH = 8192;

export function tokenize(input: string): Token[] {
  if (input.length > MAX_FILTER_LENGTH) {
    throw new Error(`Filter string too long (max ${MAX_FILTER_LENGTH} chars)`);
  }
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // String literals (single or double quotes)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++; // skip opening quote
      let value = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i++;
        }
      }
      if (i >= input.length) {
        throw new Error(`Unterminated string at position ${start}`);
      }
      i++; // skip closing quote
      tokens.push({ type: "STRING", value, pos: start });
      continue;
    }

    // Numbers (including negative)
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      // Negative sign: only treat as number if followed by digit
      if (ch === "-") {
        const next = input[i + 1];
        if (!next || next < "0" || next > "9") {
          throw new Error(`Unexpected character '-' at position ${i}`);
        }
      }
      const start = i;
      if (ch === "-") i++;
      while (i < input.length && input[i] >= "0" && input[i] <= "9") i++;
      if (i < input.length && input[i] === ".") {
        i++;
        while (i < input.length && input[i] >= "0" && input[i] <= "9") i++;
      }
      tokens.push({
        type: "NUMBER",
        value: Number(input.slice(start, i)),
        pos: start,
      });
      continue;
    }

    // Identifiers and keywords
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      const start = i;
      i++;
      while (i < input.length) {
        const c = input[i];
        if (
          (c >= "a" && c <= "z") ||
          (c >= "A" && c <= "Z") ||
          (c >= "0" && c <= "9") ||
          c === "_" ||
          c === "."
        ) {
          i++;
        } else if (c === "[") {
          // Consume bracket expression: [0], [#-1], etc.
          i++; // skip [
          while (i < input.length && input[i] !== "]") i++;
          if (i < input.length) i++; // skip ]
        } else {
          break;
        }
      }
      const word = input.slice(start, i);
      const keyword = KEYWORDS[word.toLowerCase()];
      if (keyword) {
        tokens.push({
          type: keyword,
          value: keyword === "TRUE" ? true : keyword === "FALSE" ? false : word,
          pos: start,
        });
      } else {
        tokens.push({ type: "IDENTIFIER", value: word, pos: start });
      }
      continue;
    }

    // Operators
    if (ch === "!" && input[i + 1] === "=") {
      tokens.push({ type: "NEQ", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (ch === "<" && input[i + 1] === "=") {
      tokens.push({ type: "LTE", value: "<=", pos: i });
      i += 2;
      continue;
    }
    if (ch === ">" && input[i + 1] === "=") {
      tokens.push({ type: "GTE", value: ">=", pos: i });
      i += 2;
      continue;
    }
    if (ch === "=") {
      tokens.push({ type: "EQ", value: "=", pos: i });
      i++;
      continue;
    }
    if (ch === "<") {
      tokens.push({ type: "LT", value: "<", pos: i });
      i++;
      continue;
    }
    if (ch === ">") {
      tokens.push({ type: "GT", value: ">", pos: i });
      i++;
      continue;
    }

    // Parentheses and comma
    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: "(", pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ")", pos: i });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "COMMA", value: ",", pos: i });
      i++;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ type: "EOF", value: "", pos: i });
  return tokens;
}
