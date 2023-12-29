import { Token } from "./token";

export function getLineAtToken(inputString: string, token: Token): string {
  const { position } = token;
  const { character, line } = position;

  const lines = inputString.split("\n");
  const lineString = lines[line];
  return `Line ${line + 1}, column ${character + 1}:
  
${lineString}
${" ".repeat(character - Math.floor(token.value.length / 2))}^`;
}

export function formatErrorMessage({
  inputString,
  token,
  errorMessage,
  cause,
}: {
  inputString: string;
  token: Token;
  errorMessage: string;
  cause?: Error;
}): Error {
  const errorMessages = `${errorMessage}
${getLineAtToken(inputString, token)}`;
  return new Error(
    errorMessages + (cause?.message ? "\n" + cause.message : "")
  );
}

export function formatErrorMessages({
  inputString,
  errorMessage,
  tokenAndErrorList,
  cause,
}: {
  inputString: string;
  errorMessage?: string;
  tokenAndErrorList: { token: Token; errorMessage: string }[];
  cause?: Error;
}): Error {
  const errorMessages = tokenAndErrorList
    .map(({ token, errorMessage }) => {
      return `${errorMessage}
${getLineAtToken(inputString, token)}`;
    })
    .join("\n\n");
  return new Error(
    (errorMessage ? errorMessage + "\n" : "") +
      errorMessages +
      (cause?.message ? "\n" + cause.message : "")
  );
}
