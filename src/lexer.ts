import { charIsOperator, IdentifierRegex, Token, TokenType } from "./token";

/**
 * Lexer
 * @param input
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let line = 0;
  let totalCharacters = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const characterColumn = i - totalCharacters;

    // Check operators
    let operator: string = "";
    let j = i;
    while (charIsOperator(input[j])) {
      operator += input[j];
      j = j + 1;
    }

    if (
      operator &&
      // Skip comments
      !operator.startsWith("//") &&
      !operator.startsWith("/*")
    ) {
      tokens.push({
        type: TokenType.Operator,
        value: operator,
        position: { line, character: characterColumn },
      });
      i = j - 1;
      continue;
    }

    switch (char) {
      case " ":
      case "\t":
      case "\n":
      case "r": {
        let whitespaces = "";
        let j = i;
        const currentLine = line;
        while (
          input[j] === " " ||
          input[j] === "\t" ||
          input[j] === "\n" ||
          input[j] === "\r"
        ) {
          whitespaces += input[j];
          if (input[j] === "\n") {
            line++; // reset the line number
            totalCharacters = j + 1; // reset the character number
          }
          j = j + 1;
        }
        tokens.push({
          type: TokenType.Whitespace,
          value: whitespaces,
          position: { line: currentLine, character: characterColumn },
        });
        i = j - 1;
        break;
      }
      // comments
      case "/":
        if (input[i + 1] === "/") {
          // single line comment
          let comment = "";
          let j = i;
          while (input[j] !== "\n" && j < input.length) {
            // ignore the rest of the line
            comment += input[j];
            j = j + 1;
          }
          tokens.push({
            type: TokenType.SingleLineComment,
            value: comment,
            position: { line, character: characterColumn },
          });
          i = j - 1;
        } else if (input[i + 1] === "*") {
          // multi line comment
          let j = i;
          let comment = "";
          const currentLine = line;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            // ignore the rest of the comment
            if (input[j] === "\n") {
              totalCharacters = j + 1;
              line++;
            }
            if (j >= input.length - 1) {
              throw new Error("Unterminated multi-line comment");
            }
            if (input[j] === "*" && input[j + 1] === "/") {
              comment += "*/";
              break;
            } else {
              comment += input[j];
            }
            j = j + 1;
          }
          tokens.push({
            type: TokenType.MultiLineComment,
            value: comment,
            position: { line: currentLine, character: characterColumn },
          });
          i = j + 1;
        } else {
          throw new Error(`Unexpected character ${char}`);
        }
        break;
      // parens
      case "(":
        tokens.push({
          type: TokenType.LParen,
          value: char,
          position: { line, character: characterColumn },
        });
        break;

      case ")":
        tokens.push({
          type: TokenType.RParen,
          value: char,
          position: { line, character: characterColumn },
        });
        break;

      case "[":
        tokens.push({
          type: TokenType.LBracket,
          value: char,
          position: { line, character: characterColumn },
        });
        break;

      case "]":
        tokens.push({
          type: TokenType.RBracket,
          value: char,
          position: { line, character: characterColumn },
        });
        break;

      case "{":
        tokens.push({
          type: TokenType.LCurlyBracket,
          value: char,
          position: { line, character: characterColumn },
        });
        break;

      case "}":
        tokens.push({
          type: TokenType.RCurlyBracket,
          value: char,
          position: { line, character: characterColumn },
        });
        break;
      // char
      case "'": {
        let value = "";

        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "\\") {
            value += input[j];
            j = j + 1;
            value += input[j];
            continue;
          }
          if (input[j] === "'") {
            i = j;
            break;
          }

          value += input[j];
        }

        // Check if it's a valid char
        if (value.length === 1 || (value.length === 2 && value[0] === "\\")) {
          tokens.push({
            type: TokenType.Char,
            value,
            position: { line, character: characterColumn },
          });
        } else {
          throw new Error(`Invalid char ${value}`);
        }

        break;
      }
      // string
      case '"': {
        let stringValue = "";

        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "\\") {
            stringValue += input[j];
            j = j + 1;
            stringValue += input[j];
            continue;
          }
          if (input[j] === '"') {
            i = j;
            break;
          }

          stringValue += input[j];
        }

        tokens.push({
          type: TokenType.String,
          value: stringValue,
          position: { line, character: characterColumn },
        });

        break;
      }
      // infix identifier
      case "`": {
        let value = "";

        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "`") {
            i = j;
            break;
          }
          value += input[j];
        }

        // Validate if it's a valid identifier using IdentifierRegex
        if (IdentifierRegex.test(value)) {
          tokens.push({
            type: TokenType.InfixIdentifier,
            value,
            position: { line, character: characterColumn },
          });
        } else {
          throw new Error(`Invalid infix identifier ${value}`);
        }

        break;
      }
      // other
      case ",":
        tokens.push({
          type: TokenType.Comma,
          value: char,
          position: { line, character: characterColumn },
        });
        break;
      case ";":
        tokens.push({
          type: TokenType.Semicolon,
          value: char,
          position: { line, character: characterColumn },
        });
        break;

      // primary & keywords
      default:
        if (/[0-9]/.test(char)) {
          // integer
          let value = char;
          i = i + 1;

          while (/[0-9]/.test(input[i]) && input[i]) {
            value += input[i];
            i = i + 1;
          }

          if (input[i] === "." && (input[i + 1] ?? "").match(/[0-9]/)) {
            value += input[i];
            i = i + 1;

            while (/[0-9]/.test(input[i])) {
              value += input[i];
              i = i + 1;
            }

            tokens.push({
              type: TokenType.Float,
              value,
              position: { line, character: characterColumn },
            });
            i = i - 1;
          } else {
            tokens.push({
              type: TokenType.Integer,
              value,
              position: { line, character: characterColumn },
            });
            i = i - 1;
          }
        } else if (/[_a-zA-Z\xA0-\uFFFF]/.test(char)) {
          // identifier
          let value = char;
          i = i + 1;

          while (/[_a-zA-Z0-9\xA0-\uFFFF]/.test(input[i]) && input[i]) {
            value += input[i];
            i = i + 1;
          }
          i = i - 1;

          // Add support for trailing !? characters in identifiers
          if (
            (input[i + 1] === "!" || input[i + 1] === "?") &&
            IdentifierRegex.test(value + input[i + 1])
          ) {
            i = i + 1;
            value += input[i];
          }

          // Check if the identifier is valid using IdentifierRegex
          if (IdentifierRegex.test(value)) {
            switch (value) {
              // boolean
              case "true":
              case "false":
                tokens.push({
                  type: TokenType.Boolean,
                  value,
                  position: { line, character: characterColumn },
                });
                break;
              // identifier
              default:
                tokens.push({
                  type: TokenType.Identifier,
                  value,
                  position: { line, character: characterColumn },
                });
                break;
            }
          } else {
            throw new Error(`Invalid identifier ${value}`);
          }
        } else {
          throw new Error(`Unexpected character ${char}`);
        }

        break;
    }
  }

  return tokens;
}
