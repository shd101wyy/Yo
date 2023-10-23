import { Token, TokenType } from "./token";

/**
 * Lexer
 * @param input
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    switch (char) {
      case " ":
      case "\t":
      case "\n":
        // ignore whitespace
        break;

      // operators
      case "+":
        tokens.push({
          type: TokenType.Add,
          value: char,
        });
        break;

      case "-":
        tokens.push({
          type: TokenType.Minus,
          value: char,
        });
        break;

      case "*":
        tokens.push({
          type: TokenType.Multiply,
          value: char,
        });
        break;

      case "/":
        tokens.push({
          type: TokenType.Divide,
          value: char,
        });
        break;

      // parens
      case "(":
        tokens.push({
          type: TokenType.LParen,
          value: char,
        });
        break;

      case ")":
        tokens.push({
          type: TokenType.RParen,
          value: char,
        });
        break;

      case "[":
        tokens.push({
          type: TokenType.LBracket,
          value: char,
        });
        break;

      case "]":
        tokens.push({
          type: TokenType.RBracket,
          value: char,
        });
        break;

      case "{":
        tokens.push({
          type: TokenType.LCurlyBracket,
          value: char,
        });
        break;

      case "}":
        tokens.push({
          type: TokenType.RCurlyBracket,
          value: char,
        });
        break;

      // comparison & assignment
      case "=":
        if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.Equal,
            value: "==",
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.Assign,
            value: char,
          });
        }
        break;

      case "!":
        if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.NotEqual,
            value: "!=",
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.Negate,
            value: char,
          });
        }
        break;

      case "<":
        if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.LessThanOrEqual,
            value: "<=",
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.LessThan,
            value: char,
          });
        }
        break;

      case ">":
        if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.GreaterThanOrEqual,
            value: ">=",
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.GreaterThan,
            value: char,
          });
        }
        break;

      // string
      case "'":
        let value = "";

        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "\\") {
            value += input[j];
            value += input[++j];
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
          });
        } else {
          throw new Error(`Invalid char ${value}`);
        }

        break;

      case '"':
        let stringValue = "";

        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "\\") {
            stringValue += input[j];
            stringValue += input[++j];
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
        });

        break;

      // other
      case ":":
        tokens.push({
          type: TokenType.Colon,
          value: char,
        });
        break;
      case ",":
        tokens.push({
          type: TokenType.Comma,
          value: char,
        });
        break;
      case ";":
        tokens.push({
          type: TokenType.Semicolon,
          value: char,
        });
        break;

      // primary & keywords
      default:
        if (/[0-9]/.test(char)) {
          // integer
          let value = char;

          while (/[0-9]/.test(input[++i])) {
            value += input[i];
          }
          i--;

          if (input[i] === ".") {
            value += input[i];

            while (/[0-9]/.test(input[++i])) {
              value += input[i];
            }

            tokens.push({
              type: TokenType.Float,
              value,
            });
          } else {
            tokens.push({
              type: TokenType.Integer,
              value,
            });
          }
        } else if (/[_a-zA-Z]/.test(char)) {
          // TODO: add support for unicode
          // identifier
          let value = char;

          while (/[_a-zA-Z0-9]/.test(input[++i])) {
            value += input[i];
          }
          i--;

          switch (value) {
            // boolean
            case "true":
              tokens.push({
                type: TokenType.Boolean,
                value,
              });
              break;
            case "false":
              tokens.push({
                type: TokenType.Boolean,
                value,
              });
              break;

            // keywords
            case "function":
              tokens.push({
                type: TokenType.Function,
                value,
              });
              break;
            case "if":
              tokens.push({
                type: TokenType.If,
                value,
              });
              break;
            case "for":
              tokens.push({
                type: TokenType.For,
                value,
              });
              break;
            case "while":
              tokens.push({
                type: TokenType.While,
                value,
              });
              break;
            case "switch":
              tokens.push({
                type: TokenType.Switch,
                value,
              });
              break;
            case "case":
              tokens.push({
                type: TokenType.Case,
                value,
              });
              break;
            case "match":
              tokens.push({
                type: TokenType.Match,
                value,
              });
              break;
            case "return":
              tokens.push({
                type: TokenType.Return,
                value,
              });
              break;
            case "break":
              tokens.push({
                type: TokenType.Break,
                value,
              });
              break;
            case "continue":
              tokens.push({
                type: TokenType.Continue,
                value,
              });
              break;
            case "let":
              tokens.push({
                type: TokenType.Let,
                value,
              });
              break;
            case "const":
              tokens.push({
                type: TokenType.Const,
                value,
              });
              break;
            case "type":
              tokens.push({
                type: TokenType.Type,
                value,
              });
              break;
            case "alias":
              tokens.push({
                type: TokenType.Alias,
                value,
              });
              break;
            case "interface":
              tokens.push({
                type: TokenType.Interface,
                value,
              });
              break;
            case "implement":
              tokens.push({
                type: TokenType.Implement,
                value,
              });
              break;
            case "import":
              tokens.push({
                type: TokenType.Import,
                value,
              });
              break;
            case "export":
              tokens.push({
                type: TokenType.Export,
                value,
              });
              break;
            default:
              tokens.push({
                type: TokenType.Identifier,
                value,
              });
              break;
          }
        } else {
          throw new Error(`Unexpected character ${char}`);
        }

        break;
    }
  }

  return tokens;
}
