import { Token } from "./token";

export interface TokenAndError {
  token: Token;
  errorMessage: string;
}

export type ErrorKind = "overflow";

export class YoLexerError {
  public characterIndex: number;
  public message: string;

  constructor({
    characterIndex,
    message,
  }: {
    characterIndex: number;
    message: string;
  }) {
    this.characterIndex = characterIndex;
    this.message = message;
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

export function getLineAtToken({ token }: { token: Token }): string {
  const { position, modulePath, inputString } = token;
  const { row, column } = position;

  const lines = inputString.split("\n");
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

  const lines = inputString.split("\n");
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

export function formatWarningMessages({
  warningMessage,
  tokenAndWarningList,
}: {
  warningMessage?: string;
  tokenAndWarningList: { token: Token; warningMessage: string }[];
}): string {
  const warningMessages = tokenAndWarningList
    .map(({ token, warningMessage }) => {
      return `Warning: ${warningMessage}
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
