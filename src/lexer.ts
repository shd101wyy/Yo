import { YoLexerError } from "./error";
import {
  charIsOperator,
  IdentifierRegex,
  type Token,
  TokenType,
} from "./token";

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
      // Special case: `..=` is a single operator token (inclusive range)
      if (operator === ".." && input[j] === "=") {
        operator += input[j];
        j = j + 1;
      }
      // Special case: `...#` is a single operator token (unquote_splicing).
      if (operator === "..." && input[j] === "#") {
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
        let k = i;
        const currentLine = line;
        while (
          input[k] === " " ||
          input[k] === "\t" ||
          input[k] === "\n" ||
          input[k] === "\r"
        ) {
          whitespaces += input[k];
          if (input[k] === "\n") {
            line++; // reset the line number
            totalCharacters = k + 1; // reset the character number
          }
          k = k + 1;
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
        i = k - 1;
        break;
      }
      // comments
      case "/":
        if (input[i + 1] === "/") {
          // Determine comment type: /// (doc), //! (inner doc), or // (regular)
          let commentType: TokenType;
          if (input[i + 2] === "/" && input[i + 3] !== "/") {
            commentType = TokenType.DocLineComment;
          } else if (input[i + 2] === "!") {
            commentType = TokenType.InnerDocLineComment;
          } else {
            commentType = TokenType.SingleLineComment;
          }
          let comment = "";
          let k = i;
          while (input[k] !== "\n" && k < input.length) {
            comment += input[k];
            k = k + 1;
          }
          tokens.push({
            type: commentType,
            value: comment,
            position: {
              row: line,
              column: characterColumn,
              character: characterIndex,
            },
            modulePath,
            inputString: input,
          });
          i = k - 1;
        } else if (input[i + 1] === "*") {
          // Determine comment type: /** (doc), /*! (inner doc), or /* (regular)
          let blockCommentType: TokenType;
          if (input[i + 2] === "*" && input[i + 3] !== "/") {
            blockCommentType = TokenType.DocBlockComment;
          } else if (input[i + 2] === "!") {
            blockCommentType = TokenType.InnerDocBlockComment;
          } else {
            blockCommentType = TokenType.MultiLineComment;
          }
          let k = i;
          let comment = "";
          const currentLine = line;
          let nestingLevel = 1; // Track nesting level, starting with 1 for the opening /*

          comment += input[k]; // Add the opening '/'
          k++;
          comment += input[k]; // Add the opening '*'
          k++;

          while (nestingLevel > 0 && k < input.length) {
            if (input[k] === "\n") {
              totalCharacters = k + 1;
              line++;
            }

            // Check for nested opening comment
            if (input[k] === "/" && input[k + 1] === "*") {
              nestingLevel++;
              comment += "/*";
              k += 2;
              continue;
            }

            // Check for closing comment
            if (input[k] === "*" && input[k + 1] === "/") {
              nestingLevel--;
              comment += "*/";
              k += 2;
              continue;
            }

            comment += input[k];
            k++;
          }

          if (nestingLevel > 0) {
            throw new YoLexerError({
              message: "Unterminated multi-line comment",
              characterIndex: input.length - 1,
              row: line,
            });
          }

          tokens.push({
            type: blockCommentType,
            value: comment,
            position: {
              row: currentLine,
              column: characterColumn,
              character: characterIndex,
            },
            modulePath,
            inputString: input,
          });
          i = k - 1;
        } else {
          throw new YoLexerError({
            message: `Unexpected character ${char}`,
            characterIndex: i + 1,
            row: line,
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

        for (let k = i + 1; k < input.length; k++) {
          if (input[k] === "\\") {
            value += input[k];
            k = k + 1;
            value += input[k];
            continue;
          }
          if (input[k] === "'") {
            i = k;
            break;
          }

          value += input[k];
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
          throw new YoLexerError({
            message: `Invalid char '${value}', expected char to have length 1.`,
            characterIndex: i,
            row: line,
          });
        }

        break;
      }
      // string
      case '"': {
        let stringValue = "";

        for (let k = i + 1; k < input.length; k++) {
          if (input[k] === "\\") {
            stringValue += input[k];
            k = k + 1;
            stringValue += input[k];
            continue;
          }
          if (input[k] === '"') {
            i = k;
            break;
          }

          stringValue += input[k];
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
      // template string
      case "`": {
        let value = "";
        let braceDepth = 0;
        let k = i + 1;

        while (k < input.length) {
          // Handle escape sequences
          if (input[k] === "\\") {
            if (k + 1 < input.length) {
              const nextChar = input[k + 1];
              if (nextChar === "$") {
                // Escaped dollar sign: \$ should be stored specially for the parser
                value += "\\$";
                k = k + 2;
                continue;
              } else {
                // Other escape sequences - interpret them like JavaScript
                k = k + 1;
                switch (nextChar) {
                  case "n":
                    value += "\n";
                    break;
                  case "t":
                    value += "\t";
                    break;
                  case "r":
                    value += "\r";
                    break;
                  case "\\":
                    value += "\\";
                    break;
                  case '"':
                    value += '"';
                    break;
                  case "'":
                    value += "'";
                    break;
                  case "`":
                    value += "`";
                    break;
                  case "0":
                    value += "\0";
                    break;
                  case "b":
                    value += "\b";
                    break;
                  case "f":
                    value += "\f";
                    break;
                  case "v":
                    value += "\v";
                    break;
                  default:
                    // For unknown escapes, keep both backslash and character
                    value += "\\";
                    value += nextChar;
                    break;
                }
                k = k + 1;
                continue;
              }
            }
          }

          // Handle interpolation start: ${
          if (braceDepth === 0 && input[k] === "$" && input[k + 1] === "{") {
            value += "${";
            k = k + 2;
            braceDepth = 1;
            continue;
          }

          // Handle nested braces inside interpolation
          if (braceDepth > 0) {
            if (input[k] === "{") {
              braceDepth = braceDepth + 1;
            } else if (input[k] === "}") {
              braceDepth = braceDepth - 1;
            }
            value += input[k];
            k = k + 1;
            continue;
          }

          // Handle end of template string
          if (input[k] === "`") {
            i = k;
            break;
          }

          // Handle newlines for line tracking
          if (input[k] === "\n") {
            line++;
            totalCharacters = k + 1;
          }

          value += input[k];
          k = k + 1;
        }

        if (k >= input.length && input[k] !== "`") {
          throw new YoLexerError({
            message: `Unterminated template string`,
            characterIndex: i,
            row: line,
          });
        }

        tokens.push({
          type: TokenType.TemplateString,
          value: value,
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

          // Check if the identifier is valid using IdentifierRegex
          if (IdentifierRegex.test(value)) {
            /* 
            // NOTE: We stop making '@' part of identifier.
            // It is now an operator used for the 'comptime` meaning.
            if (tokens.length > 0 && tokens[tokens.length - 1].value === "@") {
              // Merge with previous token '@'
              tokens[tokens.length - 1].value += value;
              tokens[tokens.length - 1].type = TokenType.Identifier;
            } else
            */
            {
              switch (value) {
                // RESERVED for Dafny-style verification quantifiers
                // (plans/FORALL_TO_GENERIC.md). The type-parameter binder was
                // renamed `forall` -> `generic`; the word is held back so
                // `requires`/`ensures` can bind VALUES with a predicate later.
                // Rejected at lex time so stale code fails with the exact fix
                // instead of an "unknown identifier" cascade.
                //
                // `exists` / `∃` are deliberately NOT reserved: `exists` is a
                // live public API — `std/fs/file.yo:324` `exists(path, io)`,
                // used in 72 files — and reserving it would break the
                // filesystem API for a feature that does not exist yet. The
                // verification design must either pick another spelling or
                // rename that API in its own deliberate commit.
                case "forall":
                case "\u2200":
                  throw new YoLexerError({
                    message: `\`${value}\` is reserved for verification quantifiers. Use \`generic(T : Type)\` to declare type parameters.`,
                    characterIndex: startIndex,
                    row: line,
                  });
                // bool
                case "true":
                case "false":
                  tokens.push({
                    type: TokenType.Bool,
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
            throw new YoLexerError({
              message: `Invalid identifier ${value}`,
              characterIndex: startIndex,
              row: line,
            });
          }
        } else {
          throw new YoLexerError({
            message: `Unexpected character ${char}`,
            characterIndex: i,
            row: line,
          });
        }

        break;
    }
  }

  return tokens;
}
