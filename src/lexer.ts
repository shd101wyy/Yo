import { MoLexerError } from "./error";
import { charIsOperator, IdentifierRegex, Token, TokenType } from "./token";

/**
 * Lexer
 * @param input
 */
export function tokenize(input: string, modulePath: string): Token[] {
  const tokens: Token[] = [];
  let line = 0;
  let totalCharacters = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const characterColumn = i - totalCharacters;
    const characterIndex = i;

    // Check operators
    let operator: string = "";
    let j = i;

    // dot "." can only form operator with dot itself, not with other operators
    // For example, `..`, `...` are valid operators.
    //
    // expression x.*.* will be split into:
    // - `.`
    // - `*`
    // - `.`
    // - `*`
    //
    // Special handling for dot operators
    if (input[j] === ".") {
      while (input[j] === ".") {
        operator += input[j];
        j = j + 1;
      }
    } else {
      // Handle other operators (excluding dots)
      while (charIsOperator(input[j]!) && input[j] !== ".") {
        operator += input[j];
        j = j + 1;
      }
    }

    if (
      operator &&
      // Skip comments
      !operator.startsWith("//") &&
      !operator.startsWith("/*")
    ) {
      tokens.push({
        type: operator === "." ? TokenType.Dot : TokenType.Operator,
        value: operator,
        position: {
          row: line,
          column: characterColumn,
          character: characterIndex,
        },
        modulePath,
        inputString: input,
      });
      i = j - 1;
      continue;
    }

    switch (char) {
      case " ":
      case "\t":
      case "\n":
      case "\r": {
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
          position: {
            row: currentLine,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
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
            position: {
              row: line,
              column: characterColumn,
              character: characterIndex,
            },
            modulePath,
            inputString: input,
          });
          i = j - 1;
        } else if (input[i + 1] === "*") {
          // multi line comment
          let j = i;
          let comment = "";
          const currentLine = line;
          let nestingLevel = 1; // Track nesting level, starting with 1 for the opening /*

          comment += input[j]; // Add the opening '/'
          j++;
          comment += input[j]; // Add the opening '*'
          j++;

          while (nestingLevel > 0 && j < input.length) {
            if (input[j] === "\n") {
              totalCharacters = j + 1;
              line++;
            }

            // Check for nested opening comment
            if (input[j] === "/" && input[j + 1] === "*") {
              nestingLevel++;
              comment += "/*";
              j += 2;
              continue;
            }

            // Check for closing comment
            if (input[j] === "*" && input[j + 1] === "/") {
              nestingLevel--;
              comment += "*/";
              j += 2;
              continue;
            }

            comment += input[j];
            j++;
          }

          if (nestingLevel > 0) {
            throw new MoLexerError({
              message: "Unterminated multi-line comment",
              characterIndex: input.length - 1,
            });
          }

          tokens.push({
            type: TokenType.MultiLineComment,
            value: comment,
            position: {
              row: currentLine,
              column: characterColumn,
              character: characterIndex,
            },
            modulePath,
            inputString: input,
          });
          i = j - 1;
        } else {
          throw new MoLexerError({
            message: `Unexpected character ${char}`,
            characterIndex: i + 1,
          });
        }
        break;
      // parens
      case "(":
        tokens.push({
          type: TokenType.LParen,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;

      case ")":
        tokens.push({
          type: TokenType.RParen,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;

      case "[":
        tokens.push({
          type: TokenType.LBracket,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;

      case "]":
        tokens.push({
          type: TokenType.RBracket,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;

      case "{":
        tokens.push({
          type: TokenType.LCurlyBracket,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;

      case "}":
        tokens.push({
          type: TokenType.RCurlyBracket,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
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
            value: `'${value}'`,
            position: {
              row: line,
              column: characterColumn,
              character: characterIndex,
            },
            modulePath,
            inputString: input,
          });
        } else {
          throw new MoLexerError({
            message: `Invalid char '${value}', expected char to have length 1.`,
            characterIndex: i,
          });
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
          value: `"${stringValue}"`,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });

        break;
      }
      // backtick identifier
      case "`": {
        let value = "";
        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "\\") {
            value += input[j];
            j = j + 1;
            value += input[j];
            continue;
          }
          if (input[j] === "`") {
            i = j;
            break;
          }

          value += input[j];
        }

        if (!IdentifierRegex.test(value)) {
          throw new MoLexerError({
            message: `Invalid backtick identifier \`${value}\``,
            characterIndex: i,
          });
        }

        tokens.push({
          type: TokenType.BacktickIdentifier,
          value: `\`${value}\``,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });

        break;
      }
      // other
      case ",":
        tokens.push({
          type: TokenType.Comma,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;
      case ";":
        tokens.push({
          type: TokenType.Semicolon,
          value: char,
          position: {
            row: line,
            column: characterColumn,
            character: characterIndex,
          },
          modulePath,
          inputString: input,
        });
        break;

      // primary & keywords
      default:
        if (/[0-9]/.test(char)) {
          const startIndex = i;
          // integer
          let value = char;
          i = i + 1;

          let regex = /[0-9_]/;
          if (input[i - 1] === "0" && typeof input[i] === "string") {
            // hexdecimal
            if (input[i] === "x" || input[i] === "X") {
              value += input[i];
              i = i + 1;
              regex = /[0-9A-Fa-f]/;
            }
            // binary
            else if (input[i] === "b" || input[i] === "B") {
              value += input[i];
              i = i + 1;
              regex = /[01]/;
            }
            // octal
            else if (input[i] === "o" || input[i] === "O") {
              value += input[i];
              i = i + 1;
              regex = /[0-7]/;
            }
          }

          while (typeof input[i] === "string" && regex.test(input[i]!)) {
            value += input[i];
            i = i + 1;
          }

          if (
            input[i] === "." &&
            input[startIndex - 1] !== "." && // NOTE: For parsing case like x.0.0
            (input[i + 1] ?? "").match(/[0-9]/)
          ) {
            value += input[i];
            i = i + 1;

            while (typeof input[i] === "string" && /[0-9_]/.test(input[i]!)) {
              value += input[i];
              i = i + 1;
            }

            // Check if it's e-notation behind
            // such:
            // - > 1.0e-10
            // - > 1.0e10
            if (
              (input[i] === "e" || input[i] === "E") &&
              typeof input[i + 1] === "string" &&
              (input[i + 1] === "+" ||
                input[i + 1] === "-" ||
                /[0-9]/.test(input[i + 1]!))
            ) {
              value += input[i];
              i = i + 1;
              if (input[i] === "+" || input[i] === "-") {
                value += input[i];
                i = i + 1;
              }
              while (typeof input[i] === "string" && /[0-9_]/.test(input[i]!)) {
                value += input[i];
                i = i + 1;
              }
            }

            tokens.push({
              type: TokenType.Float,
              value,
              position: {
                row: line,
                column: characterColumn,
                character: characterIndex,
              },
              modulePath,
              inputString: input,
            });
            i = i - 1;
          } else {
            // Check if it's e-notation behind
            // such:
            // - > 1.0e-10
            // - > 1.0e10
            if (
              (input[i] === "e" || input[i] === "E") &&
              typeof input[i + 1] === "string" &&
              (input[i + 1] === "+" ||
                input[i + 1] === "-" ||
                /[0-9]/.test(input[i + 1]!))
            ) {
              value += input[i];
              i = i + 1;
              if (input[i] === "+" || input[i] === "-") {
                value += input[i];
                i = i + 1;
              }
              while (typeof input[i] === "string" && /[0-9_]/.test(input[i]!)) {
                value += input[i];
                i = i + 1;
              }
            }

            tokens.push({
              type: TokenType.Integer,
              value,
              position: {
                row: line,
                column: characterColumn,
                character: characterIndex,
              },
              modulePath,
              inputString: input,
            });
            i = i - 1;
          }
        } else if (/[_a-zA-Z\xA0-\uFFFF]/.test(char)) {
          // identifier
          let value = char;
          const startIndex = i;
          i = i + 1;

          while (
            typeof input[i] === "string" &&
            /[_a-zA-Z0-9\xA0-\uFFFF]/.test(input[i]!)
          ) {
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
            /* 
            // NOTE: We stop making '@' part of identifier.
            // It is now an operator used for the 'compt` meaning.
            if (tokens.length > 0 && tokens[tokens.length - 1].value === "@") {
              // Merge with previous token '@'
              tokens[tokens.length - 1].value += value;
              tokens[tokens.length - 1].type = TokenType.Identifier;
            } else
            */
            {
              switch (value) {
                // boolean
                case "true":
                case "false":
                  tokens.push({
                    type: TokenType.Boolean,
                    value,
                    position: {
                      row: line,
                      column: characterColumn,
                      character: characterIndex,
                    },
                    modulePath,
                    inputString: input,
                  });
                  break;
                // identifier
                default:
                  tokens.push({
                    type: TokenType.Identifier,
                    value,
                    position: {
                      row: line,
                      column: characterColumn,
                      character: characterIndex,
                    },
                    modulePath,
                    inputString: input,
                  });
                  break;
              }
            }
          } else {
            throw new MoLexerError({
              message: `Invalid identifier ${value}`,
              characterIndex: startIndex,
            });
          }
        } else {
          throw new MoLexerError({
            message: `Unexpected character ${char}`,
            characterIndex: i,
          });
        }

        break;
    }
  }

  return tokens;
}
