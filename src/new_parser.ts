/* eslint-disable no-constant-condition */
import { formatErrorMessage } from "./error";
import { tokenize } from "./lexer";
import { Token, TokenType } from "./token";

type Expr =
  | {
      type: "Atom";
      token: {
        type: TokenType;
        value: string;
      };
    }
  | {
      type: "FuncCall";
      func: Expr;
      args: Expr[];
    };

type ParserReturn = {
  expr: Expr;
  index: number;
};

enum BuiltinCollections {
  Array = "array",
  Tuple = "tuple",
  Record = "record",
  Begin = "begin",
}

export default class Parser {
  private inputString: string;
  private modulePath: string;
  private tokens: Token[];
  private program: Expr[];

  constructor({
    modulePath,
    inputString,
  }: {
    modulePath: string;
    inputString: string;
  }) {
    this.modulePath = modulePath;
    this.inputString = inputString;
    this.tokens = tokenize(inputString);
    this.program = [];

    this.parse(this.tokens);
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
  }

  private skipWhitespace(tokens: Token[], index: number): number {
    while (tokens[index] && tokens[index].type === TokenType.Whitespace) {
      index = index + 1;
    }
    return index;
  }

  private skipWhitespaceBackward(tokens: Token[], index: number): number {
    while (tokens[index] && tokens[index].type === TokenType.Whitespace) {
      index = index - 1;
    }
    return index;
  }

  private parseParenExpr({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    if (tokens[index + 1].type === TokenType.RParen) {
      // unit type
      return {
        expr: {
          type: "FuncCall",
          func: {
            type: "Atom",
            token: {
              type: TokenType.Identifier,
              value: BuiltinCollections.Tuple,
            },
          },
          args: [],
        },
        index: index + 2,
      };
    }

    const returnValue = this.parseExpression({
      tokens,
      index: index + 1,
    });
    const expr = returnValue.expr;
    index = returnValue.index;
    if (tokens[index].type === TokenType.RParen) {
      return {
        expr,
        index: index + 1,
      };
    } else {
      // Parse tuple
      const args = [expr];
      while (true) {
        if (!tokens[index]) {
          throw this.formatErrorMessage(
            tokens[index - 1],
            "Expected ) or , for tuple"
          );
        }
        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
        if (tokens[index].type === TokenType.RParen) {
          break;
        }

        // Parse the expression
        const { expr: arg, index: nextIndex } = this.parseExpression({
          tokens,
          index,
        });
        args.push(arg);
        index = nextIndex;
      }

      return {
        expr: {
          type: "FuncCall",
          func: {
            type: "Atom",
            token: {
              type: TokenType.Identifier,
              value: BuiltinCollections.Tuple,
            },
          },
          args,
        },
        index: index + 1,
      };
    }
  }

  private parseArrayExpr({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LBracket) {
      throw this.formatErrorMessage(tokens[index], "Expected left bracket");
    }
    index = index + 1;
    {
      // Parse array
      const args: Expr[] = [];
      while (true) {
        if (!tokens[index]) {
          throw this.formatErrorMessage(
            tokens[index - 1],
            "Expected ] or , for array"
          );
        }
        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
        if (tokens[index].type === TokenType.RBracket) {
          break;
        }

        // Parse the expression
        const { expr: arg, index: nextIndex } = this.parseExpression({
          tokens,
          index,
        });
        args.push(arg);
        index = nextIndex;
      }

      return {
        expr: {
          type: "FuncCall",
          func: {
            type: "Atom",
            token: {
              type: TokenType.Identifier,
              value: BuiltinCollections.Array,
            },
          },
          args,
        },
        index: index + 1,
      };
    }
  }

  private parseCurlyBracketExpr({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected left curly bracket"
      );
    }

    let separator: ";" | "," | undefined = undefined;
    const args: Expr[] = [];
    index = index + 1;
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index - 1],
          "Expected } or , for struct"
        );
      }
      if (tokens[index].type === TokenType.Comma) {
        if (separator === ";") {
          throw this.formatErrorMessage(
            tokens[index],
            "Cannot mix , and ; in begin block"
          );
        }
        separator = ",";
        index = index + 1;
      } else if (tokens[index].type === TokenType.Semicolon) {
        if (separator === ",") {
          throw this.formatErrorMessage(
            tokens[index],
            "Cannot mix , and ; in record"
          );
        }
        separator = ";";
        index = index + 1;
      }
      if (tokens[index].type === TokenType.RCurlyBracket) {
        if (separator === ";") {
          // begin block,
          // lets check if the forwarded token is a semicolon
          const lastNonWhiteSpaceToken =
            tokens[this.skipWhitespaceBackward(tokens, index - 1)];
          if (
            lastNonWhiteSpaceToken &&
            lastNonWhiteSpaceToken.type === TokenType.Semicolon
          ) {
            // Push unit
            args.push({
              type: "FuncCall",
              func: {
                type: "Atom",
                token: {
                  type: TokenType.Identifier,
                  value: BuiltinCollections.Tuple,
                },
              },
              args: [],
            });
          }
        }

        break;
      }

      // Parse the expression
      const { expr: arg, index: nextIndex } = this.parseExpression({
        tokens,
        index,
      });
      args.push(arg);
      index = nextIndex;
    }

    return {
      expr: {
        type: "FuncCall",
        func: {
          type: "Atom",
          token: {
            type: TokenType.Identifier,
            value:
              separator === ";"
                ? BuiltinCollections.Begin // begin block
                : BuiltinCollections.Record, // record
          },
        },
        args,
      },
      index: index + 1,
    };
  }

  private parsePrimary({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    index = this.skipWhitespace(tokens, index);
    const token = tokens[index];
    if (!token) {
      throw this.formatErrorMessage(token, "Unexpected end of input");
    }
    let returnValue: ParserReturn | null = null;

    switch (token.type) {
      case TokenType.Identifier: // Symbol
      case TokenType.Operator:
      case TokenType.Boolean: // Literal
      case TokenType.Integer:
      case TokenType.Float:
      case TokenType.String:
      case TokenType.Char: {
        returnValue = {
          expr: {
            type: "Atom",
            token,
          },
          index: index + 1,
        };
        break;
      }
      case TokenType.LParen: {
        returnValue = this.parseParenExpr({
          tokens,
          index,
        });
        break;
      }
      case TokenType.LBracket: {
        returnValue = this.parseArrayExpr({
          tokens,
          index,
        });
        break;
      }
      case TokenType.LCurlyBracket: {
        returnValue = this.parseCurlyBracketExpr({
          tokens,
          index,
        });
        break;
      }
      default: {
        throw this.formatErrorMessage(token, `Unexpected token: ${token.type}`);
      }
    }

    returnValue = this.parsePrimaryEnd({
      primaryExpr: returnValue.expr,
      tokens,
      index: returnValue.index,
    });
    return returnValue;
  }

  private parsePrimaryEnd({
    primaryExpr,
    tokens,
    index,
  }: {
    primaryExpr: Expr;
    tokens: Token[];
    index: number;
  }): ParserReturn {
    const nextIndex = this.skipWhitespace(tokens, index);
    const hasWhitespace = nextIndex !== index;
    index = nextIndex;

    const token = tokens[nextIndex];
    if (!token || token.type === TokenType.Semicolon) {
      return {
        expr: primaryExpr,
        index,
      };
    }

    if (token.type === TokenType.Operator && token.value === ".") {
      // Field access like
      // obj.field
      const { expr, index: nextIndex } = this.parsePrimary({
        tokens,
        index: index + 1,
      });
      return this.parsePrimaryEnd({
        primaryExpr: {
          type: "FuncCall",
          func: {
            type: "Atom",
            token,
          },
          args: [primaryExpr, expr],
        },
        tokens,
        index: nextIndex,
      });
    } else if (
      token.type === TokenType.Operator ||
      token.type === TokenType.InfixIdentifier
    ) {
      // Infix operator like
      // 3 + 4
      const { expr: rhs, index: nextIndex } = this.parsePrimary({
        tokens,
        index: index + 1,
      });
      return this.parsePrimaryEnd({
        primaryExpr: {
          type: "FuncCall",
          func: {
            type: "Atom",
            token,
          },
          args: [primaryExpr, rhs],
        },
        tokens,
        index: nextIndex,
      });
    } else if (!hasWhitespace && token.type === TokenType.LParen) {
      // Function call like
      // add(3, 4)
      const returnValue = this.parseFunctionCall({
        func: primaryExpr,
        tokens,
        index: index + 1,
        hasWhitespace: false,
      });
      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
      });
    } else if (hasWhitespace) {
      // Function call like
      // add 3, 4
      const returnValue = this.parseFunctionCall({
        func: primaryExpr,
        tokens,
        index: index,
        hasWhitespace: true,
      });
      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
      });
    } else {
      throw this.formatErrorMessage(
        token,
        "Expected . or operator or ( for function call"
      );
    }
  }

  private parseFunctionCall({
    func,
    tokens,
    index,
    hasWhitespace,
  }: {
    func: Expr;
    tokens: Token[];
    index: number;
    /**
     * If the function call has whitespace between the function name and the arguments
     * like `add 3, 4` instead of `add(3, 4)`
     */
    hasWhitespace: boolean;
  }): ParserReturn {
    // Parse arguments
    const args: Expr[] = [];

    while (true) {
      const { expr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
      });
      args.push(expr);
      index = nextIndex;
      const token = tokens[index];
      if (token.type === TokenType.Comma) {
        index = index + 1;
      } else if (!hasWhitespace && token.type === TokenType.RParen) {
        return {
          expr: {
            type: "FuncCall",
            func,
            args,
          },
          index: index + 1,
        };
      } else if (hasWhitespace && token.type === TokenType.Semicolon) {
        return {
          expr: {
            type: "FuncCall",
            func,
            args,
          },
          index: index + 1,
        };
      } else {
        throw this.formatErrorMessage(
          token,

          hasWhitespace
            ? "Expected ; to end the function call"
            : "Expected , or )"
        );
      }
    }
  }

  private parseExpression({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    index = this.skipWhitespace(tokens, index);
    return this.parsePrimary({
      tokens,
      index,
    });
  }

  private exprToString(expr: Expr): string {
    switch (expr.type) {
      case "Atom": {
        return expr.token.value;
      }
      case "FuncCall": {
        if (
          expr.func.type === "Atom" &&
          expr.func.token.type === TokenType.Operator
        ) {
          if (expr.args.length === 1) {
            return `${expr.func.token.value}(${this.exprToString(
              expr.args[0]
            )})`;
          } else if (expr.args.length === 2) {
            return `(${this.exprToString(expr.args[0])} ${
              expr.func.token.value
            } ${this.exprToString(expr.args[1])})`;
          }
        }
        if (
          expr.func.type === "Atom" &&
          expr.func.token.type === TokenType.Identifier &&
          expr.func.token.value === BuiltinCollections.Tuple
        ) {
          if (expr.args.length === 1) {
            return `(${this.exprToString(expr.args[0])},)`;
          }
          return `(${expr.args
            .map((arg) => {
              return this.exprToString(arg);
            })
            .join(", ")
            .trim()})`;
        }

        const func = this.exprToString(expr.func);
        const args = expr.args
          .map((arg) => {
            return this.exprToString(arg);
          })
          .join(", ")
          .trim();
        return `${func}(${args})`;
      }
    }
  }

  public programToString() {
    const printed = this.program
      .map((expr) => {
        return this.exprToString(expr);
      })
      .join(";\n");
    return printed;
  }

  private parse(tokens: Token[]) {
    let index = 0;
    const exprs: Expr[] = [];
    // eslint-disable-next-line no-constant-condition
    while (index < tokens.length) {
      const token = tokens[index];
      // Top level expression
      switch (token.type) {
        case TokenType.Whitespace:
        case TokenType.Semicolon:
        case TokenType.SingleLineComment:
        case TokenType.MultiLineComment: {
          // ignore
          index = index + 1;
          break;
        }
      }

      if (index >= tokens.length) {
        break;
      }

      const { expr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
      });
      exprs.push(expr);
      index = nextIndex;
    }

    // Check if the last token is a semicolon
    const lastNonWhiteSpaceToken =
      tokens[this.skipWhitespaceBackward(tokens, tokens.length - 1)];
    if (
      lastNonWhiteSpaceToken &&
      lastNonWhiteSpaceToken.type === TokenType.Semicolon
    ) {
      // Add unit
      exprs.push({
        type: "FuncCall",
        func: {
          type: "Atom",
          token: {
            type: TokenType.Identifier,
            value: BuiltinCollections.Tuple,
          },
        },
        args: [],
      });
    }

    this.program = exprs;
  }
}
