import * as fs from "fs";
import * as path from "path";
import Parser from "./parser";
import { type Token, TokenType } from "./token";

const INDENT_SIZE = 2;

const COMMENT_TOKEN_TYPES = new Set<TokenType>([
  TokenType.SingleLineComment,
  TokenType.MultiLineComment,
  TokenType.DocLineComment,
  TokenType.InnerDocLineComment,
  TokenType.DocBlockComment,
  TokenType.InnerDocBlockComment,
]);

const LINE_COMMENT_TOKEN_TYPES = new Set<TokenType>([
  TokenType.SingleLineComment,
  TokenType.DocLineComment,
  TokenType.InnerDocLineComment,
]);

const ATOM_LIKE_TOKEN_TYPES = new Set<TokenType>([
  TokenType.Identifier,
  TokenType.Integer,
  TokenType.Float,
  TokenType.Bool,
  TokenType.String,
  TokenType.Char,
  TokenType.TemplateString,
]);

const IGNORED_FORMAT_DIRS = new Set<string>([
  ".git",
  ".yo-cache",
  "node_modules",
  "out",
  "yo-out",
]);

export interface FormatYoFilesOptions {
  check?: boolean;
  cwd?: string;
}

export interface FormatYoFilesResult {
  files: string[];
  changed: string[];
}

export function formatYoSource(input: string, modulePath = "<input>"): string {
  if (input.length === 0) {
    return "";
  }

  const parser = new Parser({ modulePath, inputString: input });
  const parserError = parser.getParserError();
  if (parserError) {
    throw parserError;
  }

  const allTokens = parser.getTokens();
  const significantTokens = allTokens.filter(
    (token) => token.type !== TokenType.Whitespace
  );
  const inlineCurlyIndices = findInlineCurlyIndices(significantTokens);
  const skippedParenIndices =
    findRedundantGroupingParenIndices(significantTokens);
  const multilineParenIndices = findMultilineParenIndices(
    significantTokens,
    skippedParenIndices
  );
  const multilineBracketIndices =
    findMultilineBracketIndices(significantTokens);
  const multilineInlineCurlyIndices = findMultilineInlineCurlyIndices(
    significantTokens,
    inlineCurlyIndices
  );
  const rawValues = significantTokens.map((token, index) =>
    rawTokenValue(input, significantTokens, index)
  );

  let result = "";
  let indentLevel = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;
  let inlineCurlyDepth = 0;
  let atLineStart = true;
  let previousToken: Token | undefined;
  const parenStack: Array<{ index: number; multiline: boolean }> = [];
  const bracketStack: Array<{ multiline: boolean }> = [];
  const curlyStack: Array<{ inline: boolean; multiline: boolean }> = [];
  const continuationStack: Array<{
    parenDepth: number;
    bracketDepth: number;
    curlyDepth: number;
  }> = [];

  const trimTrailingHorizontalWhitespace = (): void => {
    result = result.replace(/[ \t]+$/u, "");
  };

  const writeIndentIfNeeded = (): void => {
    if (atLineStart) {
      result += " ".repeat(indentLevel * INDENT_SIZE);
      atLineStart = false;
    }
  };

  const write = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    writeIndentIfNeeded();
    result += text;
  };

  const ensureSpace = (): void => {
    if (!atLineStart && !result.endsWith(" ") && !result.endsWith("\n")) {
      result += " ";
    }
  };

  const newline = (): void => {
    trimTrailingHorizontalWhitespace();
    if (!result.endsWith("\n")) {
      result += "\n";
    }
    atLineStart = true;
  };

  const startOperatorContinuation = (): void => {
    newline();
    indentLevel++;
    continuationStack.push({ parenDepth, bracketDepth, curlyDepth });
  };

  const closeOperatorContinuations = (): void => {
    while (continuationStack.length > 0) {
      const top = continuationStack[continuationStack.length - 1]!;
      if (
        parenDepth > top.parenDepth ||
        bracketDepth > top.bracketDepth ||
        curlyDepth > top.curlyDepth
      ) {
        return;
      }
      continuationStack.pop();
      indentLevel = Math.max(0, indentLevel - 1);
    }
  };

  const writeBlockComment = (raw: string): void => {
    if (raw.includes("\n")) {
      if (!atLineStart) {
        newline();
      }
      const lines = normalizeMultilineBlockComment(raw);
      for (const line of lines) {
        write(line);
        newline();
      }
      return;
    }

    if (!atLineStart) {
      ensureSpace();
    }
    write(raw);
    ensureSpace();
  };

  for (let index = 0; index < significantTokens.length; index++) {
    const token = significantTokens[index]!;
    if (skippedParenIndices.has(index)) {
      continue;
    }

    const previous = previousToken;
    const next = nextToken(significantTokens, skippedParenIndices, index);
    const raw = rawValues[index]!;

    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      if (
        previous &&
        token.position.row > previous.position.row &&
        !atLineStart
      ) {
        newline();
      }
      if (LINE_COMMENT_TOKEN_TYPES.has(token.type)) {
        if (!atLineStart) {
          ensureSpace();
        }
        write(raw.trimEnd());
        newline();
      } else {
        writeBlockComment(raw);
      }
      previousToken = token;
      continue;
    }

    switch (token.type) {
      case TokenType.LCurlyBracket: {
        if (inlineCurlyIndices.has(index)) {
          const isMultiline = multilineInlineCurlyIndices.has(index);
          curlyStack.push({ inline: true, multiline: isMultiline });
          curlyDepth++;
          inlineCurlyDepth++;
          if (isMultiline) {
            write("{");
            indentLevel++;
            if (next && next.type !== TokenType.RCurlyBracket) {
              newline();
            }
          } else {
            write("{");
            if (next && next.type !== TokenType.RCurlyBracket) {
              ensureSpace();
            }
          }
        } else {
          curlyStack.push({ inline: false, multiline: false });
          write("{");
          curlyDepth++;
          indentLevel++;
          newline();
        }
        break;
      }
      case TokenType.RCurlyBracket: {
        const curlyFrame = curlyStack.pop();
        if (curlyFrame?.inline) {
          inlineCurlyDepth = Math.max(0, inlineCurlyDepth - 1);
          if (curlyFrame.multiline) {
            if (!atLineStart) {
              newline();
            }
            indentLevel = Math.max(0, indentLevel - 1);
            write("}");
          } else {
            trimTrailingHorizontalWhitespace();
            if (previous && previous.type !== TokenType.LCurlyBracket) {
              ensureSpace();
            }
            write("}");
          }
        } else {
          if (!atLineStart) {
            newline();
          }
          indentLevel = Math.max(0, indentLevel - 1);
          write("}");
        }
        curlyDepth = Math.max(0, curlyDepth - 1);
        break;
      }
      case TokenType.LParen:
        if (multilineParenIndices.has(index)) {
          write("(");
          parenStack.push({ index, multiline: true });
          parenDepth++;
          indentLevel++;
          if (next && next.type !== TokenType.RParen) {
            newline();
          }
        } else {
          write("(");
          parenStack.push({ index, multiline: false });
          parenDepth++;
        }
        break;
      case TokenType.LBracket: {
        const isMultiline = multilineBracketIndices.has(index);
        bracketStack.push({ multiline: isMultiline });
        bracketDepth++;
        if (isMultiline) {
          write("[");
          indentLevel++;
          if (next && next.type !== TokenType.RBracket) {
            newline();
          }
        } else {
          write("[");
        }
        break;
      }
      case TokenType.RParen:
        {
          closeOperatorContinuations();
          const frame = parenStack.pop();
          if (frame?.multiline) {
            if (!atLineStart) {
              newline();
            }
            indentLevel = Math.max(0, indentLevel - 1);
            write(")");
          } else {
            trimTrailingHorizontalWhitespace();
            write(")");
          }
          parenDepth = Math.max(0, parenDepth - 1);
        }
        break;
      case TokenType.RBracket: {
        closeOperatorContinuations();
        const bracketFrame = bracketStack.pop();
        bracketDepth = Math.max(0, bracketDepth - 1);
        if (bracketFrame?.multiline) {
          if (!atLineStart) {
            newline();
          }
          indentLevel = Math.max(0, indentLevel - 1);
          write("]");
        } else {
          trimTrailingHorizontalWhitespace();
          write("]");
        }
        break;
      }
      case TokenType.Comma: {
        closeOperatorContinuations();
        trimTrailingHorizontalWhitespace();
        write(",");
        if (
          next &&
          next.type !== TokenType.RParen &&
          next.type !== TokenType.RBracket &&
          next.type !== TokenType.RCurlyBracket
        ) {
          const currentBracket = bracketStack[bracketStack.length - 1];
          const currentCurly = curlyStack[curlyStack.length - 1];
          if (currentBracket?.multiline) {
            newline();
          } else if (currentCurly?.inline && currentCurly.multiline) {
            newline();
          } else if (
            currentBracket !== undefined ||
            (currentCurly?.inline && !currentCurly.multiline)
          ) {
            ensureSpace();
          } else if (parenStack[parenStack.length - 1]?.multiline === true) {
            newline();
          } else {
            ensureSpace();
          }
        }
        break;
      }
      case TokenType.Semicolon: {
        if (
          bracketDepth > 0 &&
          next &&
          next.type !== TokenType.RBracket &&
          !COMMENT_TOKEN_TYPES.has(next.type)
        ) {
          trimTrailingHorizontalWhitespace();
          ensureSpace();
          write(";");
          ensureSpace();
        } else {
          closeOperatorContinuations();
          trimTrailingHorizontalWhitespace();
          write(";");
          if (
            next &&
            (!COMMENT_TOKEN_TYPES.has(next.type) ||
              next.position.row > token.position.row)
          ) {
            newline();
            // Preserve at most one blank line between statements.
            if (next.position.row - token.position.row >= 2) {
              result += "\n";
            }
          }
        }
        break;
      }
      case TokenType.Dot: {
        // Trim only for MEMBER ACCESS. A dot WITH a left operand binds tight to
        // it (`str. len()` → `str.len()`), which is what the trim is for.
        //
        // A PREFIX dot (`.Some`, `.None`) has no left operand: it follows a
        // comma or an operator whose handler just established a space via
        // `ensureSpace()` (Comma :347, `=`/`=>` :423, struct-literal `:` :394).
        // Trimming unconditionally ATE that space, emitting `,.Some`, `=.Some`,
        // `=>.Err` and `:.Some`. That was an implementation accident, not a
        // style choice — the identifier form keeps its space (`= Some(x)` vs
        // `=.Some(x)`), and no other operator handler eats the space the
        // previous one set. It is also the whole reason `yo fmt` disagreed with
        // the self-hosted formatter, which never had the trim (measured: TS
        // emitted `_ptr =.Some(x)`, yo-self `_ptr = .Some(x)`).
        //
        // `needsSpaceBeforeAtom` is exactly the "has a left operand" predicate:
        // true for atom-like tokens and `)`/`]`/`}`, false after a comma, an
        // operator, or `(` — so `(.Some` stays tight (nothing writes a space
        // after an open paren) while `, .Some` keeps its comma space.
        // See plans/PREFIX_OPERATOR_OPERAND_RULE.md.
        if (needsSpaceBeforeAtom(previous)) {
          trimTrailingHorizontalWhitespace();
        }
        write(".");
        break;
      }
      case TokenType.Operator: {
        if (token.value === ":" && inlineCurlyDepth > 0) {
          trimTrailingHorizontalWhitespace();
          ensureSpace();
          write(":");
          if (next && next.position.row > token.position.row) {
            startOperatorContinuation();
          } else {
            ensureSpace();
          }
        } else if (isTightlyBoundOperator(token, previous, next)) {
          if (prefixOperatorNeedsLeadingSpace(token, previous)) {
            ensureSpace();
          } else {
            trimTrailingHorizontalWhitespace();
          }
          write(token.value);
        } else {
          // When the operator immediately follows an opening bracket, there is no
          // left operand — preserve any spacing the bracket already established
          // and don't add a new leading space (e.g. quote(&&), { ... }).
          const prevIsOpenBracket =
            previous?.type === TokenType.LParen ||
            previous?.type === TokenType.LBracket ||
            previous?.type === TokenType.LCurlyBracket;
          if (!prevIsOpenBracket) {
            trimTrailingHorizontalWhitespace();
            if (previous && token.position.row > previous.position.row) {
              newline();
            } else {
              ensureSpace();
            }
          }
          write(token.value);
          if (next && next.position.row > token.position.row) {
            startOperatorContinuation();
          } else {
            ensureSpace();
          }
        }
        break;
      }
      case TokenType.Identifier:
      case TokenType.Integer:
      case TokenType.Float:
      case TokenType.Bool:
      case TokenType.String:
      case TokenType.Char:
      case TokenType.TemplateString: {
        if (needsSpaceBeforeAtom(previous)) {
          ensureSpace();
        }
        write(raw);
        break;
      }
      case TokenType.Whitespace:
        break;
    }

    previousToken = token;
  }

  trimTrailingHorizontalWhitespace();
  if (result.length > 0 && !result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

export function findYoFormatFiles(
  inputPaths: string[],
  cwd = process.cwd()
): string[] {
  const pathsToFormat = inputPaths.length > 0 ? inputPaths : ["."];
  const files = new Set<string>();

  for (const inputPath of pathsToFormat) {
    const resolvedPath = path.resolve(cwd, inputPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${inputPath}`);
    }
    collectYoFiles(resolvedPath, files);
  }

  return [...files].sort();
}

export function formatYoFiles(
  inputPaths: string[],
  options: FormatYoFilesOptions = {}
): FormatYoFilesResult {
  const cwd = options.cwd ?? process.cwd();
  const files = findYoFormatFiles(inputPaths, cwd);
  const changed: string[] = [];

  for (const file of files) {
    const original = fs.readFileSync(file, "utf-8");
    const formatted = formatYoSource(original, file);
    if (formatted !== original) {
      changed.push(file);
      if (options.check !== true) {
        fs.writeFileSync(file, formatted, "utf-8");
      }
    }
  }

  return { files, changed };
}

function collectYoFiles(targetPath: string, files: Set<string>): void {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    if (targetPath.endsWith(".yo")) {
      files.add(targetPath);
    }
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_FORMAT_DIRS.has(entry.name)) {
      continue;
    }
    collectYoFiles(path.join(targetPath, entry.name), files);
  }
}

function nextToken(
  tokens: Token[],
  skippedIndices: Set<number>,
  index: number
): Token | undefined {
  for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex++) {
    if (!skippedIndices.has(nextIndex)) {
      return tokens[nextIndex];
    }
  }
  return undefined;
}

function findRedundantGroupingParenIndices(tokens: Token[]): Set<number> {
  const skippedIndices = new Set<number>();
  const matchingParens = findMatchingParenIndices(tokens);
  const parentParens = findParentParenIndices(tokens);
  const candidateLeftIndices = new Set<number>();

  for (const [leftIndex, rightIndex] of matchingParens) {
    if (isRedundantGroupingParen(tokens, leftIndex, rightIndex)) {
      candidateLeftIndices.add(leftIndex);
    }
  }

  for (const leftIndex of candidateLeftIndices) {
    const rightIndex = matchingParens.get(leftIndex)!;
    if (
      parenRemovalWouldExposeOperatorRhsInfix(
        tokens,
        leftIndex,
        rightIndex,
        parentParens,
        candidateLeftIndices
      )
    ) {
      continue;
    }
    skippedIndices.add(leftIndex);
    skippedIndices.add(rightIndex);
  }

  return skippedIndices;
}

function findParentParenIndices(tokens: Token[]): Map<number, number> {
  const parents = new Map<number, number>();
  const stack: number[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.LParen) {
      const parent = stack[stack.length - 1];
      if (parent !== undefined) {
        parents.set(index, parent);
      }
      stack.push(index);
    } else if (token.type === TokenType.RParen) {
      stack.pop();
    }
  }

  return parents;
}

function parenRemovalWouldExposeOperatorRhsInfix(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number,
  parentParens: Map<number, number>,
  candidateLeftIndices: Set<number>
): boolean {
  const previous = previousMeaningfulToken(tokens, leftIndex);
  if (previous?.type === TokenType.Operator) {
    return hasTopLevelOperator(tokens, leftIndex, rightIndex);
  }

  const parentLeftIndex = parentParens.get(leftIndex);
  if (
    parentLeftIndex === undefined ||
    !candidateLeftIndices.has(parentLeftIndex)
  ) {
    return false;
  }

  const parentPrevious = previousMeaningfulToken(tokens, parentLeftIndex);
  return (
    parentPrevious?.type === TokenType.Operator &&
    hasTopLevelOperator(tokens, leftIndex, rightIndex)
  );
}

function hasTopLevelOperator(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number
): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;

  for (let index = leftIndex + 1; index < rightIndex; index++) {
    const token = tokens[index]!;
    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      continue;
    }
    if (
      token.type === TokenType.Operator &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      curlyDepth === 0
    ) {
      return true;
    }

    if (token.type === TokenType.LParen) {
      parenDepth++;
    } else if (token.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.type === TokenType.LBracket) {
      bracketDepth++;
    } else if (token.type === TokenType.RBracket) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.type === TokenType.LCurlyBracket) {
      curlyDepth++;
    } else if (token.type === TokenType.RCurlyBracket) {
      curlyDepth = Math.max(0, curlyDepth - 1);
    }
  }

  return false;
}

function findMatchingParenIndices(tokens: Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.LParen) {
      stack.push(index);
    } else if (token.type === TokenType.RParen) {
      const leftIndex = stack.pop();
      if (leftIndex !== undefined) {
        pairs.set(leftIndex, index);
      }
    }
  }

  return pairs;
}

function findMultilineBracketIndices(tokens: Token[]): Set<number> {
  const multilineIndices = new Set<number>();
  const stack: number[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.LBracket) {
      stack.push(index);
    } else if (token.type === TokenType.RBracket) {
      const leftIndex = stack.pop();
      if (leftIndex !== undefined) {
        const leftToken = tokens[leftIndex]!;
        if (token.position.row > leftToken.position.row) {
          multilineIndices.add(leftIndex);
          multilineIndices.add(index);
        }
      }
    }
  }

  return multilineIndices;
}

function findMultilineInlineCurlyIndices(
  tokens: Token[],
  inlineCurlyIndices: Set<number>
): Set<number> {
  const multilineIndices = new Set<number>();
  const stack: number[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.LCurlyBracket) {
      stack.push(index);
    } else if (token.type === TokenType.RCurlyBracket) {
      const leftIndex = stack.pop();
      if (
        leftIndex !== undefined &&
        inlineCurlyIndices.has(leftIndex) &&
        token.position.row > tokens[leftIndex]!.position.row
      ) {
        multilineIndices.add(leftIndex);
        multilineIndices.add(index);
      }
    }
  }

  return multilineIndices;
}

function findMultilineParenIndices(
  tokens: Token[],
  skippedIndices: Set<number>
): Set<number> {
  const multilineIndices = new Set<number>();
  const matchingParens = findMatchingParenIndices(tokens);

  for (const [leftIndex, rightIndex] of matchingParens) {
    if (skippedIndices.has(leftIndex) || skippedIndices.has(rightIndex)) {
      continue;
    }
    const previous = previousMeaningfulToken(tokens, leftIndex);
    const forceMultiline =
      shouldForceControlFlowMultiline(
        tokens,
        leftIndex,
        rightIndex,
        previous
      ) ||
      hasTopLevelFieldBlock(tokens, leftIndex, rightIndex) ||
      shouldForceOperatorRhsBlock(tokens, leftIndex, rightIndex, previous);
    if (
      !forceMultiline &&
      tokens[rightIndex]!.position.row <= tokens[leftIndex]!.position.row
    ) {
      continue;
    }

    const firstInner = nextMeaningfulToken(tokens, leftIndex, rightIndex);
    if (
      firstInner?.type === TokenType.LCurlyBracket ||
      hasTopLevelCurlyArgument(tokens, leftIndex, rightIndex) ||
      (parenIsCallDelimiter(previous) &&
        hasDirectTopLevelClosureArgument(
          tokens,
          leftIndex,
          rightIndex,
          previous
        ))
    ) {
      continue;
    }

    multilineIndices.add(leftIndex);
    multilineIndices.add(rightIndex);
  }

  return multilineIndices;
}

function shouldForceOperatorRhsBlock(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number,
  previous: Token | undefined
): boolean {
  return (
    previous?.type === TokenType.Operator &&
    hasAnyToken(tokens, leftIndex, rightIndex, TokenType.LCurlyBracket)
  );
}

function hasAnyToken(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number,
  tokenType: TokenType
): boolean {
  for (let index = leftIndex + 1; index < rightIndex; index++) {
    if (tokens[index]!.type === tokenType) {
      return true;
    }
  }
  return false;
}

function shouldForceControlFlowMultiline(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number,
  previous: Token | undefined
): boolean {
  return (
    previous?.type === TokenType.Identifier &&
    (previous.value === "cond" ||
      previous.value === "if" ||
      previous.value === "match") &&
    hasTopLevelToken(tokens, leftIndex, rightIndex, TokenType.LCurlyBracket)
  );
}

function hasTopLevelCurlyArgument(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number
): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;
  let previousTopLevel: Token | undefined;

  for (let index = leftIndex + 1; index < rightIndex; index++) {
    const token = tokens[index]!;
    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      continue;
    }

    const atTopLevel =
      parenDepth === 0 && bracketDepth === 0 && curlyDepth === 0;
    if (
      token.type === TokenType.LCurlyBracket &&
      atTopLevel &&
      previousTopLevel?.type === TokenType.Comma
    ) {
      return true;
    }

    if (token.type === TokenType.LParen) {
      parenDepth++;
    } else if (token.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.type === TokenType.LBracket) {
      bracketDepth++;
    } else if (token.type === TokenType.RBracket) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.type === TokenType.LCurlyBracket) {
      curlyDepth++;
    } else if (token.type === TokenType.RCurlyBracket) {
      curlyDepth = Math.max(0, curlyDepth - 1);
    }

    if (atTopLevel) {
      previousTopLevel = token;
    }
  }

  return false;
}

function hasTopLevelFieldBlock(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number
): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;
  let sawTopLevelColon = false;

  for (let index = leftIndex + 1; index < rightIndex; index++) {
    const token = tokens[index]!;
    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      continue;
    }

    const atTopLevel =
      parenDepth === 0 && bracketDepth === 0 && curlyDepth === 0;
    if (
      token.type === TokenType.Operator &&
      token.value === ":" &&
      atTopLevel
    ) {
      sawTopLevelColon = true;
    } else if (
      token.type === TokenType.LCurlyBracket &&
      bracketDepth === 0 &&
      sawTopLevelColon
    ) {
      return true;
    }

    if (token.type === TokenType.LParen) {
      parenDepth++;
    } else if (token.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.type === TokenType.LBracket) {
      bracketDepth++;
    } else if (token.type === TokenType.RBracket) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.type === TokenType.LCurlyBracket) {
      curlyDepth++;
    } else if (token.type === TokenType.RCurlyBracket) {
      curlyDepth = Math.max(0, curlyDepth - 1);
    }
  }

  return false;
}

function hasDirectTopLevelClosureArgument(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number,
  previous: Token | undefined
): boolean {
  if (
    previous?.type === TokenType.Identifier &&
    ["cond", "if", "match", "test", "while"].includes(previous.value)
  ) {
    return false;
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;
  let sawTopLevelColon = false;
  let sawClosureOperator = false;

  for (let index = leftIndex + 1; index < rightIndex; index++) {
    const token = tokens[index]!;
    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      continue;
    }

    const atTopLevel =
      parenDepth === 0 && bracketDepth === 0 && curlyDepth === 0;
    if (token.type === TokenType.Operator && atTopLevel) {
      if (token.value === ":") {
        sawTopLevelColon = true;
      } else if (
        !sawTopLevelColon &&
        (token.value === "=>" || token.value === "->")
      ) {
        sawClosureOperator = true;
      }
    } else if (
      token.type === TokenType.LCurlyBracket &&
      atTopLevel &&
      sawClosureOperator
    ) {
      return true;
    }

    if (token.type === TokenType.LParen) {
      parenDepth++;
    } else if (token.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.type === TokenType.LBracket) {
      bracketDepth++;
    } else if (token.type === TokenType.RBracket) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.type === TokenType.LCurlyBracket) {
      curlyDepth++;
    } else if (token.type === TokenType.RCurlyBracket) {
      curlyDepth = Math.max(0, curlyDepth - 1);
    }
  }

  return false;
}

function isRedundantGroupingParen(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number
): boolean {
  if (rightIndex === leftIndex + 1) {
    return false;
  }

  const previous = previousMeaningfulToken(tokens, leftIndex);
  const next = nextMeaningfulToken(tokens, rightIndex);
  const firstInner = nextMeaningfulToken(tokens, leftIndex, rightIndex);

  if (!firstInner || tokenRangeHasComment(tokens, leftIndex + 1, rightIndex)) {
    return false;
  }
  if (parenIsCallDelimiter(previous)) {
    return false;
  }
  if (
    previous?.type === TokenType.Operator &&
    !operatorAllowsUngroupedRhs(previous.value)
  ) {
    return false;
  }
  const parenthesizedDotDeref = isParenthesizedDotDeref(
    tokens,
    leftIndex,
    rightIndex
  );
  if (previous?.type === TokenType.Dot && !parenthesizedDotDeref) {
    return false;
  }
  if (
    (next?.type === TokenType.Operator && !parenthesizedDotDeref) ||
    (next?.type === TokenType.Dot && !parenthesizedDotDeref) ||
    next?.type === TokenType.LParen
  ) {
    return false;
  }
  if (
    firstInner.type === TokenType.Identifier &&
    isFunctionTypeKeyword(firstInner.value)
  ) {
    return false;
  }
  if (hasTopLevelToken(tokens, leftIndex, rightIndex, TokenType.Comma)) {
    return false;
  }
  if (hasTopLevelToken(tokens, leftIndex, rightIndex, TokenType.Semicolon)) {
    return false;
  }

  return true;
}

function isParenthesizedDotDeref(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number
): boolean {
  const previous = previousMeaningfulToken(tokens, leftIndex);
  let innerToken: Token | undefined;
  let innerTokenCount = 0;
  for (let index = leftIndex + 1; index < rightIndex; index++) {
    const token = tokens[index]!;
    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      continue;
    }
    innerToken = token;
    innerTokenCount++;
    if (innerTokenCount > 1) {
      return false;
    }
  }
  return (
    previous?.type === TokenType.Dot &&
    innerToken?.type === TokenType.Operator &&
    innerToken.value === "*" &&
    innerTokenCount === 1
  );
}

function previousMeaningfulToken(
  tokens: Token[],
  index: number
): Token | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (!COMMENT_TOKEN_TYPES.has(token.type)) {
      return token;
    }
  }
  return undefined;
}

function nextMeaningfulToken(
  tokens: Token[],
  index: number,
  endExclusive = tokens.length
): Token | undefined {
  for (let i = index + 1; i < endExclusive; i++) {
    const token = tokens[i]!;
    if (!COMMENT_TOKEN_TYPES.has(token.type)) {
      return token;
    }
  }
  return undefined;
}

function tokenRangeHasComment(
  tokens: Token[],
  startInclusive: number,
  endExclusive: number
): boolean {
  for (let index = startInclusive; index < endExclusive; index++) {
    if (COMMENT_TOKEN_TYPES.has(tokens[index]!.type)) {
      return true;
    }
  }
  return false;
}

function parenIsCallDelimiter(previous: Token | undefined): boolean {
  return (
    previous !== undefined &&
    (ATOM_LIKE_TOKEN_TYPES.has(previous.type) ||
      previous.type === TokenType.RParen ||
      previous.type === TokenType.RBracket ||
      previous.type === TokenType.RCurlyBracket)
  );
}

function operatorAllowsUngroupedRhs(operator: string): boolean {
  return [":=", "::", "=", ":", "=>", "->"].includes(operator);
}

function isFunctionTypeKeyword(value: string): boolean {
  return value === "fn" || value === "unsafe_fn";
}

function hasTopLevelToken(
  tokens: Token[],
  leftIndex: number,
  rightIndex: number,
  tokenType: TokenType
): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;

  for (let index = leftIndex + 1; index < rightIndex; index++) {
    const token = tokens[index]!;
    if (COMMENT_TOKEN_TYPES.has(token.type)) {
      continue;
    }
    if (
      token.type === tokenType &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      curlyDepth === 0
    ) {
      return true;
    }

    if (token.type === TokenType.LParen) {
      parenDepth++;
    } else if (token.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.type === TokenType.LBracket) {
      bracketDepth++;
    } else if (token.type === TokenType.RBracket) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.type === TokenType.LCurlyBracket) {
      curlyDepth++;
    } else if (token.type === TokenType.RCurlyBracket) {
      curlyDepth = Math.max(0, curlyDepth - 1);
    }
  }

  return false;
}

function findInlineCurlyIndices(tokens: Token[]): Set<number> {
  const inlineIndices = new Set<number>();
  const stack: Array<{
    index: number;
    parenDepth: number;
    bracketDepth: number;
    hasTopLevelSemicolon: boolean;
  }> = [];
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.LCurlyBracket) {
      stack.push({
        index,
        parenDepth,
        bracketDepth,
        hasTopLevelSemicolon: false,
      });
    } else if (
      token.type === TokenType.Semicolon &&
      stack.length > 0 &&
      stack[stack.length - 1]!.parenDepth === parenDepth &&
      stack[stack.length - 1]!.bracketDepth === bracketDepth
    ) {
      stack[stack.length - 1]!.hasTopLevelSemicolon = true;
    } else if (token.type === TokenType.RCurlyBracket) {
      const frame = stack.pop();
      if (frame && !frame.hasTopLevelSemicolon) {
        inlineIndices.add(frame.index);
        inlineIndices.add(index);
      }
    } else if (token.type === TokenType.LParen) {
      parenDepth++;
    } else if (token.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.type === TokenType.LBracket) {
      bracketDepth++;
    } else if (token.type === TokenType.RBracket) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    }
  }

  return inlineIndices;
}

function rawTokenValue(input: string, tokens: Token[], index: number): string {
  const token = tokens[index]!;
  if (token.type === TokenType.TemplateString) {
    return readRawTemplateString(input, token.position.character);
  }
  return token.value;
}

function readRawTemplateString(input: string, start: number): string {
  let index = start + 1;
  let braceDepth = 0;

  while (index < input.length) {
    const char = input[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (braceDepth === 0 && char === "`") {
      return input.slice(start, index + 1);
    }
    if (braceDepth === 0 && char === "$" && input[index + 1] === "{") {
      braceDepth = 1;
      index += 2;
      continue;
    }
    if (braceDepth > 0) {
      if (char === "{") {
        braceDepth++;
      } else if (char === "}") {
        braceDepth--;
      }
    }
    index++;
  }

  return input.slice(start);
}

function isTightlyBoundOperator(
  token: Token,
  previous: Token | undefined,
  next: Token | undefined
): boolean {
  // After a dot, always tight (e.g. ptr.*(x), ptr.&(x))
  if (previous?.type === TokenType.Dot) {
    return true;
  }
  if (next?.type !== TokenType.LParen) {
    return false;
  }
  // Tight only when both:
  //   1. There is no whitespace between the operator and the '(' in the source
  //      (e.g. !(x), ?(V), *(T)). If the user wrote "= (x)", the space signals
  //      an infix operator with a parenthesized RHS, not a prefix op.
  //   2. The previous token is not an rvalue-end (atom, ')', ']', '}'). If it
  //      is, the operator is infix even when there's no space before '(',
  //      e.g. main::(fn()...) — '::' is infix between 'main' and '(fn...)'.
  const noSpaceBeforeParen =
    next.position.row === token.position.row &&
    next.position.column === token.position.column + token.value.length;
  if (!noSpaceBeforeParen) {
    return false;
  }
  const prevIsRvalueEnd =
    previous !== undefined &&
    (ATOM_LIKE_TOKEN_TYPES.has(previous.type) ||
      previous.type === TokenType.RParen ||
      previous.type === TokenType.RBracket ||
      previous.type === TokenType.RCurlyBracket);
  return !prevIsRvalueEnd;
}

function prefixOperatorNeedsLeadingSpace(
  token: Token,
  previous: Token | undefined
): boolean {
  if (
    previous?.type === TokenType.Operator &&
    previous.value === "..." &&
    token.value === "#"
  ) {
    return false;
  }
  return (
    previous?.type === TokenType.Comma ||
    // Any infix operator (e.g. ||, &&, +) before a prefix op needs a space so
    // they don't merge into a single lexer token (e.g. "||!" or "+!").
    // The dot operator is excluded because it binds tightly (e.g. ptr.*(x)).
    (previous?.type === TokenType.Operator && previous.value !== ".")
  );
}

function needsSpaceBeforeAtom(previous: Token | undefined): boolean {
  if (!previous) {
    return false;
  }
  return (
    ATOM_LIKE_TOKEN_TYPES.has(previous.type) ||
    previous.type === TokenType.RParen ||
    previous.type === TokenType.RBracket ||
    previous.type === TokenType.RCurlyBracket
  );
}

function normalizeMultilineBlockComment(raw: string): string[] {
  const lines = raw.split("\n").map((line) => line.trimEnd());
  const indentedLines = lines.slice(1);
  let commonIndent: number | undefined;

  for (const line of indentedLines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indent = leadingWhitespaceLength(line);
    commonIndent =
      commonIndent === undefined ? indent : Math.min(commonIndent, indent);
  }

  if (!commonIndent) {
    return lines;
  }

  return [
    lines[0]!,
    ...indentedLines.map((line) =>
      line.trim().length === 0 ? "" : line.slice(commonIndent)
    ),
  ];
}

function leadingWhitespaceLength(line: string): number {
  const match = line.match(/^[ \t]*/u);
  return match ? match[0].length : 0;
}
