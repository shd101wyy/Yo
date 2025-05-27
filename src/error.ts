import { Token } from "./token";

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
  public modulePath: string;
  public inputString: string;
  public token: Token;
  public message;

  constructor({
    modulePath,
    inputString,
    token,
    message,
  }: {
    modulePath: string;
    inputString: string;
    token: Token;
    message: string;
  }) {
    this.modulePath = modulePath;
    this.inputString = inputString;
    this.token = token;
    this.message = message;
  }
}

export function getLineAtToken({
  modulePath,
  inputString,
  token,
}: {
  modulePath: string;
  inputString: string;
  token: Token;
}): string {
  const { position } = token;
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
  modulePath,
  inputString,
  token,
  errorMessage,
  cause,
}: {
  modulePath: string;
  inputString: string;
  token: Token;
  errorMessage: string;
  cause?: Error;
}): MoParserError {
  const errorMessages = `${errorMessage.trim()}

${getLineAtToken({ modulePath, inputString, token })}`;

  return new MoParserError({
    modulePath,
    inputString,
    token,
    message: errorMessages + (cause?.message ? "\n" + cause.message : ""),
  });
}

export function formatErrorMessages({
  modulePath,
  inputString,
  errorMessage,
  tokenAndErrorList,
  cause,
}: {
  modulePath: string;
  inputString: string;
  errorMessage?: string;
  tokenAndErrorList: { token: Token; errorMessage: string }[];
  cause?: Error;
}): MoParserError {
  if (tokenAndErrorList.length === 0) {
    throw new Error("tokenAndErrorList must not be empty");
  }

  const errorMessages = tokenAndErrorList
    .map(({ token, errorMessage }) => {
      return `${errorMessage}
${getLineAtToken({ modulePath, inputString, token })}`;
    })
    .join("\n\n");

  return new MoParserError({
    modulePath,
    inputString,
    token: tokenAndErrorList[0]!.token,
    message:
      (errorMessage ? errorMessage + "\n" : "") +
      errorMessages +
      (cause?.message ? "\n" + cause.message : ""),
  });
}

export function formatWarningMessages({
  modulePath,
  inputString,
  warningMessage,
  tokenAndWarningList,
}: {
  modulePath: string;
  inputString: string;
  warningMessage?: string;
  tokenAndWarningList: { token: Token; warningMessage: string }[];
}): string {
  const warningMessages = tokenAndWarningList
    .map(({ token, warningMessage }) => {
      return `Warning: ${warningMessage}
${getLineAtToken({ modulePath, inputString, token })}`;
    })
    .join("\n\n");
  return (
    (warningMessage ? "Warning: " + warningMessage + "\n" : "") +
    warningMessages
  );
}
