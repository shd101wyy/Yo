import type { Token } from "./token";

export interface TokenAndError {
  token: Token;
  errorMessage: string;
}

export type ErrorKind = "overflow";

export class YoLexerError {
  public characterIndex: number;
  public message: string;
  public row: number;

  constructor({
    characterIndex,
    message,
    row,
  }: {
    characterIndex: number;
    message: string;
    row: number;
  }) {
    this.characterIndex = characterIndex;
    this.message = message;
    this.row = row;
  }

  public toString(): string {
    return `Lexer Error at row ${this.row + 1}: ${this.message}`;
  }
}

export class YoError {
  public tokenAndErrorList: TokenAndError[] = [];
  public isAssertionError: boolean;
  public kind?: ErrorKind;

  constructor(
    tokenAndErrorList: TokenAndError[],
    isAssertionError?: boolean,
    kind?: ErrorKind
  ) {
    this.tokenAndErrorList = tokenAndErrorList;
    this.isAssertionError = isAssertionError || false;
    this.kind = kind;
  }

  public toString(): string {
    const errorMessages = this.tokenAndErrorList
      .map(({ token, errorMessage }) => {
        return `Error: ${errorMessage}
${getLineAtToken({ token })}`;
      })
      .join("\n\n");
    return errorMessages;
  }
}

/**
 * Cache for `inputString.split("\n")` keyed by the inputString itself.
 *
 * `formatErrorMessage` calls `getLineAtToken` for every formatted
 * error, and the synthesizer's overload-resolution path catches and
 * discards tens of thousands of these per compile. Splitting a
 * multi-thousand-character module source each time is wasted work —
 * the source doesn't change. Per `perf-repros/run.sh ts-nested-tostring`
 * profiling, `inputString.split("\n")` accounted for 100% of
 * `stringSplitFast` calls (262 ms self-time on the small repro).
 *
 * Using a `WeakRef`-keyed structure would be ideal, but `Map` on the
 * primitive string suffices: tokens from the same module all share
 * the same `inputString` reference (Yo lexer stores one canonical
 * string per module), so the cache size is bounded by the number of
 * compiled modules.
 */
const _inputLinesCache: Map<string, string[]> = new Map();
function _splitLinesCached(inputString: string): string[] {
  let lines = _inputLinesCache.get(inputString);
  if (lines === undefined) {
    lines = inputString.split("\n");
    _inputLinesCache.set(inputString, lines);
  }
  return lines;
}

export function getLineAtToken({ token }: { token: Token }): string {
  const { position, modulePath, inputString } = token;
  const { row, column } = position;

  const lines = _splitLinesCached(inputString);
  const lineString = lines[row];
  return `${modulePath}:${row + 1}:${column + 1}:
${lineString}
${" ".repeat(column + Math.floor(token.value.length / 2))}^`;
}

export function getLineAtPosition({
  modulePath,
  inputString,
  position,
}: {
  modulePath: string;
  inputString: string;
  position: { row: number; column: number };
}): string {
  const { row, column } = position;

  const lines = _splitLinesCached(inputString);
  const lineString = lines[row];
  return `${modulePath}:${row + 1}:${column + 1}:

${lineString}
${" ".repeat(column)}^`;
}

export function formatErrorMessage({
  token,
  errorMessage,
  cause,
  isAssertionError,
  kind,
}: {
  token: Token;
  errorMessage: string;
  cause?: Error;
  isAssertionError?: boolean;
  kind?: ErrorKind;
}): YoError {
  const errorMessages = `${errorMessage.trim()}

${getLineAtToken({ token })}`;

  return new YoError(
    [
      {
        token,
        errorMessage:
          errorMessages + (cause?.message ? "\n" + cause.message : ""),
      },
    ],
    isAssertionError,
    kind
  );
}

export function formatErrorMessages(
  tokenAndErrorList: TokenAndError[],
  isAssertionError?: boolean,
  kind?: ErrorKind
): YoError {
  if (tokenAndErrorList.length === 0) {
    throw new Error("tokenAndErrorList must not be empty");
  }

  return new YoError(tokenAndErrorList, isAssertionError, kind);
}

/**
 * Render ANY thrown value into a non-empty diagnostic string.
 *
 * `YoError` does not extend `Error`, so generic `error.message` reads yield
 * `undefined` on it, and a thrown value whose message/toString is empty
 * produced diagnostics like `Failed to import module "...":` with NOTHING
 * after the colon (see issues/fixed/basic-test-struct-batch-count-usize-i32.md —
 * that empty message made a real batch compile failure look unactionable for
 * weeks). Every wrap-and-rethrow diagnostic site should use this instead of
 * hand-rolled instanceof chains.
 */
export function describeThrown(error: unknown): string {
  let text = "";
  if (error instanceof YoError || error instanceof YoLexerError) {
    text = error.toString();
  } else if (error instanceof Error) {
    text = error.message;
    if (!text.trim() && error.stack) {
      text = error.stack;
    }
  } else {
    text = String(error);
  }
  if (!text.trim()) {
    try {
      text = `(empty error message; raw value: ${JSON.stringify(error)})`;
    } catch {
      text = "(empty error message)";
    }
  }
  return text;
}

export function formatWarningMessages({
  warningMessage,
  tokenAndWarningList,
}: {
  warningMessage?: string;
  tokenAndWarningList: { token: Token; warningMessage: string }[];
}): string {
  const warningMessages = tokenAndWarningList
    .map(({ token, warningMessage: message }) => {
      return `Warning: ${message}
${getLineAtToken({ token })}`;
    })
    .join("\n\n");
  return (
    (warningMessage ? "Warning: " + warningMessage + "\n" : "") +
    warningMessages
  );
}

export function printYoError(error: YoError | Error) {
  console.error(error.toString());
}
