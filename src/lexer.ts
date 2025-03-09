import { SpecialOperators, charIsOperator } from "./operator";
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

    /*
    // Check if it's the builtin function
    const builtinFunction = BuiltinFunctions.find((functionName) =>
      input.startsWith(functionName, i)
    );
    if (builtinFunction) {
      tokens.push({
        type: TokenType.Identifier,
        value: builtinFunction,
        position: { line, character: i - totalCharacters },
      });
      i += builtinFunction.length - 1;
      continue;
    }
    */

    // Check if it's the special operator
    const specialOperator = SpecialOperators.find((operator) =>
      input.startsWith(operator, i)
    );
    if (specialOperator) {
      tokens.push({
        type: TokenType.Operator,
        value: specialOperator,
        position: { line, character: i - totalCharacters },
      });
      i += specialOperator.length - 1;
      continue;
    }

    // Check operators
    let operator: string = "";
    let j = i;
    while (charIsOperator(input[j])) {
      operator += input[j];
      j++;
    }

    if (
      operator &&
      // Skip comments
      !operator.startsWith("//") &&
      !operator.startsWith("/*")
    ) {
      if (operator.startsWith("&!<")) {
        tokens.push({
          type: TokenType.Operator,
          value: "&!",
          position: { line, character: i - totalCharacters },
        });
        i = i + 2 - 1; // Only keep &!
        continue;
      } else if (operator.startsWith("&<")) {
        tokens.push({
          type: TokenType.Operator,
          value: "&",
          position: { line, character: i - totalCharacters },
        });
        i = i + 1 - 1; // Only keep &
        continue;
      } else if (operator === ".") {
        tokens.push({
          type: TokenType.Dot,
          value: operator,
          position: { line, character: i - totalCharacters },
        });
      } else if (operator === ":") {
        tokens.push({
          type: TokenType.Colon,
          value: operator,
          position: { line, character: i - totalCharacters },
        });
      } else if (operator === "=") {
        tokens.push({
          type: TokenType.Assign,
          value: char,
          position: { line, character: i - totalCharacters },
        });
      } else if (operator === "=>>") {
        tokens.push({
          type: TokenType.MoveFatArrow,
          value: "=>>",
          position: { line, character: i - totalCharacters },
        });
      } else if (operator === "=>") {
        tokens.push({
          type: TokenType.FatArrow,
          value: "=>",
          position: { line, character: i - totalCharacters },
        });
      } else if (operator === "->") {
        tokens.push({
          type: TokenType.FunctionArrow,
          value: "->",
          position: { line, character: i - totalCharacters },
        });
      } else {
        tokens.push({
          type: TokenType.Operator,
          value: operator,
          position: { line, character: i - totalCharacters },
        });
      }
      i = j - 1;
      continue;
    }

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
          while (input[++i] !== "\n" && i < input.length) {
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
          throw new Error(`Unexpected character ${char}`);
        }
        break;
      /*
      case "#":
        tokens.push({
          type: TokenType.Comptime,
          value: char,
          position: { line, character: i - totalCharacters },
        });
        break;
      */
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
      // other
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

      // primary & keywords
      default:
        if (/[0-9]/.test(char)) {
          // integer
          let value = char;

          while (/[0-9]/.test(input[++i]) && input[i]) {
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

          while (/[_a-zA-Z0-9]/.test(input[++i]) && input[i]) {
            value += input[i];
          }
          i--;

          switch (value) {
            // underscore
            case "_":
              tokens.push({
                type: TokenType.Underscore,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
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
            /*
            case "function":
              tokens.push({
                type: TokenType.Function,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            */
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
            /*
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
            */
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
            /*
            case "fallthrough":
              tokens.push({
                type: TokenType.Fallthrough,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
              */
            case "let":
              tokens.push({
                type: TokenType.Let,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "var":
              tokens.push({
                type: TokenType.Var,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "mut":
              tokens.push({
                type: TokenType.Mut,
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
            case "trait":
              tokens.push({
                type: TokenType.Trait,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "impl":
              tokens.push({
                type: TokenType.Impl,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "dyn":
              tokens.push({
                type: TokenType.Dyn,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
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
            case "from":
              tokens.push({
                type: TokenType.From,
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
            case "NULL":
              tokens.push({
                type: TokenType.NULL,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "nullptr":
              tokens.push({
                type: TokenType.NullPtr,
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
            case "where":
              tokens.push({
                type: TokenType.Where,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "as":
              tokens.push({
                type: TokenType.As,
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
            case "defer":
              tokens.push({
                type: TokenType.Defer,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "recur":
              tokens.push({
                type: TokenType.Recur,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "infix":
              tokens.push({
                type: TokenType.Infix,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "infixl":
              tokens.push({
                type: TokenType.Infixl,
                value,
                position: { line, character: i - totalCharacters },
              });
              break;
            case "infixr":
              tokens.push({
                type: TokenType.Infixr,
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
