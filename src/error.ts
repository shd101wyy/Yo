import { Token } from "./token";

export interface TokenAndError {
  token: Token;
  errorMessage: string;
}

export class MoLexerError {
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

export class MoParserError {
  public tokenAndErrorList: TokenAndError[] = [];

  constructor(tokenAndErrorList: TokenAndError[]) {
    this.tokenAndErrorList = tokenAndErrorList;
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
}: {
  token: Token;
  errorMessage: string;
  cause?: Error;
}): MoParserError {
  const errorMessages = `${errorMessage.trim()}

${getLineAtToken({ token })}`;

  return new MoParserError([
    {
      token,
      errorMessage:
        errorMessages + (cause?.message ? "\n" + cause.message : ""),
    },
  ]);
}

export function formatErrorMessages(
  tokenAndErrorList: TokenAndError[]
): MoParserError {
  if (tokenAndErrorList.length === 0) {
    throw new Error("tokenAndErrorList must not be empty");
  }

  return new MoParserError(tokenAndErrorList);
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
