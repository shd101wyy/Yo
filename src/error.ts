import { Token } from "./token";

export function formatErrorMessage({
  inputString,
  token,
  errorMessage,
}: {
  inputString: string;
  token: Token;
  errorMessage: string;
}) {
  const { position } = token;
  const { character, line } = position;

  const lines = inputString.split("\n");
  const lineString = lines[line];
  const errorMessages = `${errorMessage}
Line ${line + 1}, column ${character + 1}:

${lineString}
${" ".repeat(character)}^`;
  return new Error(errorMessages);
}
