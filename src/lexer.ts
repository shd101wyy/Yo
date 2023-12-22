import { Token, TokenType } from "./token";

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

    switch (char) {
      case " ":
      case "\t":
        // ignore whitespace
        break;
      case "\n":
        line++; // reset the line number
        totalCharacters = i + 1; // reset the character number
        break;

      // comments
      case "/":
        if (input[i + 1] === "/") {
          // single line comment
          while (input[++i] !== "\n") {
            // ignore the rest of the line
          }
          line++;
          totalCharacters = i + 1;
        } else if (input[i + 1] === "*") {
          // multi line comment
          i = i + 2;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            // ignore the rest of the comment
            if (input[i] === "\n") {
              line++;
              totalCharacters = i + 1;
            }
            if (
              (input[i] === "*" && input[i + 1] === "/") ||
              i >= input.length - 1
            ) {
              break;
            }
            i++;
          }
          i += 1;
        } else {
          tokens.push({
            type: TokenType.Divide,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;

      // operators
      case "+":
        tokens.push({
          type: TokenType.Add,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "-":
        tokens.push({
          type: TokenType.Subtract,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "*":
        if (input[i + 1] === "*") {
          tokens.push({
            type: TokenType.Exponent,
            value: "**",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.Multiply,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;
      case "%":
        tokens.push({
          type: TokenType.Modulo,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case "&":
        if (input[i + 1] === "&") {
          tokens.push({
            type: TokenType.LogicalAnd,
            value: "&&",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.BitwiseAnd,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;
      case "|":
        if (input[i + 1] === "|") {
          tokens.push({
            type: TokenType.LogicalOr,
            value: "||",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.BitwiseOr,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;
      case "^":
        tokens.push({
          type: TokenType.BitwiseXor,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case "~":
        tokens.push({
          type: TokenType.BitwiseNot,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case "#":
        tokens.push({
          type: TokenType.Comptime,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case "<":
        if (input[i + 1] === "<") {
          tokens.push({
            type: TokenType.BitwiseShiftLeft,
            value: "<<",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.LessThanOrEqual,
            value: "<=",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.LessThan,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;
      case ">":
        if (input[i + 1] === ">") {
          tokens.push({
            type: TokenType.BitwiseShiftRight,
            value: ">>",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.GreaterThanOrEqual,
            value: ">=",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.GreaterThan,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;
      case "=": {
        if (input[i + 1] === ">") {
          tokens.push({
            type: TokenType.LambdaArrow,
            value: "=>",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.Equal,
            value: "==",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.Assign,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;
      }

      // parens
      case "(":
        tokens.push({
          type: TokenType.LParen,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case ")":
        tokens.push({
          type: TokenType.RParen,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "[":
        tokens.push({
          type: TokenType.LBracket,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "]":
        tokens.push({
          type: TokenType.RBracket,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "{":
        tokens.push({
          type: TokenType.LCurlyBracket,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "}":
        tokens.push({
          type: TokenType.RCurlyBracket,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;

      case "!":
        if (input[i + 1] === "=") {
          tokens.push({
            type: TokenType.NotEqual,
            value: "!=",
            position: { line, character: i - totalCharacters },
          });
          i++;
        } else {
          tokens.push({
            type: TokenType.LogicalNot,
            value: char,
            position: { line, character: i - totalCharacters },
          });
        }
        break;

      // char
      case "'": {
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
            position: { line, character: i - totalCharacters },
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
          position: { line, character: i - totalCharacters },
        });

        break;
      }
      // symbol @"Red"
      case "@": {
        if (input[i + 1] === '"') {
          let value = "";

          for (let j = i + 2; j < input.length; j++) {
            if (input[j] === '"') {
              i = j;
              break;
            }

            value += input[j];
          }

          tokens.push({
            type: TokenType.Symbol,
            value,
            position: { line, character: i - totalCharacters },
          });
        } else {
          throw new Error(`Unexpected character ${char}`);
        }
        break;
      }

      // other
      case ":":
        tokens.push({
          type: TokenType.Colon,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case ",":
        tokens.push({
          type: TokenType.Comma,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case ";":
        tokens.push({
          type: TokenType.Semicolon,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      case ".":
        tokens.push({
          type: TokenType.Dot,
          value: char,
          position: { line, character: i - totalCharacters },
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

          if (input[i] === "." && (input[i + 1] ?? "").match(/[0-9]/)) {
            value += input[i];

            while (/[0-9]/.test(input[++i])) {
              value += input[i];
            }

            tokens.push({
              type: TokenType.Float,
              value,
              position: { line, character: i - totalCharacters },
            });
            i--;
          } else {
            tokens.push({
              type: TokenType.Integer,
              value,
              position: { line, character: i - totalCharacters },
            });
            i--;
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
                position: { line, character: i - totalCharacters },
              });
              break;
            case "false":
              tokens.push({
                type: TokenType.Boolean,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "is":
              tokens.push({
                type: TokenType.Is,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            // string
            case "char":
              tokens.push({
                type: TokenType.Char,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            // keywords
            case "function":
              tokens.push({
                type: TokenType.Function,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "if":
              tokens.push({
                type: TokenType.If,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "else":
              tokens.push({
                type: TokenType.Else,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "for":
              tokens.push({
                type: TokenType.For,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "while":
              tokens.push({
                type: TokenType.While,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "switch":
              tokens.push({
                type: TokenType.Switch,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "case":
              tokens.push({
                type: TokenType.Case,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "default":
              tokens.push({
                type: TokenType.Default,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "match":
              tokens.push({
                type: TokenType.Match,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "return":
              tokens.push({
                type: TokenType.Return,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "break":
              tokens.push({
                type: TokenType.Break,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "continue":
              tokens.push({
                type: TokenType.Continue,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "fallthrough":
              tokens.push({
                type: TokenType.Fallthrough,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "let":
              tokens.push({
                type: TokenType.Let,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "const":
              tokens.push({
                type: TokenType.Const,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "type":
              tokens.push({
                type: TokenType.Type,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "enum":
              tokens.push({
                type: TokenType.Enum,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "class":
              tokens.push({
                type: TokenType.Class,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "instance":
              tokens.push({
                type: TokenType.Instance,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "extends":
              tokens.push({
                type: TokenType.Extends,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            /*
            case "implement":
              tokens.push({
                type: TokenType.Implement,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            */
            case "import":
              tokens.push({
                type: TokenType.Import,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "export":
              tokens.push({
                type: TokenType.Export,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "extern":
              tokens.push({
                type: TokenType.Extern,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "null":
              tokens.push({
                type: TokenType.Null,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "undefined":
              tokens.push({
                type: TokenType.Undefined,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "with":
              tokens.push({
                type: TokenType.With,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            default:
              tokens.push({
                type: TokenType.Identifier,
                value,
                position: { line, character: i - totalCharacters },
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
