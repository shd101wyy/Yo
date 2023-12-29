import { Token } from "./token";

export function getLineAtToken(inputString: string, token: Token): string {
  const { position } = token;
  const { character, line } = position;

  const lines = inputString.split("\n");
  const lineString = lines[line];
  return `Line ${line + 1}, column ${character + 1}:
  
${lineString}
${" ".repeat(character)}^`;
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
  const { position } = token;
  const { character, line } = position;

  const lines = inputString.split("\n");
  const lineString = lines[line];
  const errorMessages = `${errorMessage}
Line ${line + 1}, column ${character + 1}:

${lineString}
${" ".repeat(character)}^`;
  return new Error(
    errorMessages + (cause?.message ? "\n" + cause.message : "")
  );
}

export function formatErrorMessages({
  inputString,
  tokenAndErrorList,
  cause,
}: {
  inputString: string;
  tokenAndErrorList: { token: Token; errorMessage: string }[];
  cause?: Error;
}): Error {
  const errorMessages = tokenAndErrorList
    .map(({ token, errorMessage }) => {
      const { position } = token;
      const { character, line } = position;

      const lines = inputString.split("\n");
      const lineString = lines[line];
      return `${errorMessage}
Line ${line + 1}, column ${character + 1}:

${lineString}
${" ".repeat(character)}^`;
    })
    .join("\n\n");
  return new Error(
    errorMessages + (cause?.message ? "\n" + cause.message : "")
  );
}
