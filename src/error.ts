import { Token } from "./token";

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
  const { character, line } = position;

  const lines = inputString.split("\n");
  const lineString = lines[line];
  return `${modulePath}:${line + 1}:${character + 1}:
  
${lineString}
${" ".repeat(Math.max(character - Math.floor(token.value.length / 2), 0))}^`;
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
}): Error {
  const errorMessages = `${errorMessage}
${getLineAtToken({ modulePath, inputString, token })}`;
  return new Error(
    errorMessages + (cause?.message ? "\n" + cause.message : "")
  );
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
}): Error {
  const errorMessages = tokenAndErrorList
    .map(({ token, errorMessage }) => {
      return `${errorMessage}
${getLineAtToken({ modulePath, inputString, token })}`;
    })
    .join("\n\n");
  return new Error(
    (errorMessage ? errorMessage + "\n" : "") +
      errorMessages +
      (cause?.message ? "\n" + cause.message : "")
  );
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
