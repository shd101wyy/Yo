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

  private findTokenIndexForRBracket(tokens: Token[], index: number): number {
    let endBracketType = TokenType.RParen;
    const startBracketType = tokens[index].type;
    if (startBracketType === TokenType.LCurlyBracket) {
      endBracketType = TokenType.RCurlyBracket;
    } else if (startBracketType === TokenType.LParen) {
      endBracketType = TokenType.RParen;
    } else if (startBracketType === TokenType.LBracket) {
      endBracketType = TokenType.RBracket;
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected '{', '(' or '['");
    }
    index = index + 1;
    let count = 1;
    let endIndex = -1;
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index - 1],
          `Expected '${endBracketType}'`
        );
      }

      if (tokens[index].type === endBracketType) {
        count = count - 1;
        if (count === 0) {
          endIndex = index;
          break;
        }
      } else if (tokens[index].type === startBracketType) {
        count = count + 1;
      }

      index = index + 1;
    }

    return endIndex;
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
              value: "tuple",
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
              value: "tuple",
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
              value: "array",
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
          let j = index - 1;
          while (true) {
            if (!tokens[j]) {
              throw this.formatErrorMessage(
                tokens[index - 1],
                "Expected ; to end the begin block"
              );
            }
            if (tokens[j].type === TokenType.Whitespace) {
              j = j - 1;
            } else {
              if (tokens[j].type !== TokenType.Semicolon) {
                break;
              } else {
                // Push unit
                args.push({
                  type: "FuncCall",
                  func: {
                    type: "Atom",
                    token: {
                      type: TokenType.Identifier,
                      value: "tuple",
                    },
                  },
                  args: [],
                });
              }
              break;
            }
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
                ? "begin" // begin block
                : "record", // record
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
    const token = tokens[index];
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
    let token = tokens[index];
    if (!token) {
      return {
        expr: primaryExpr,
        index,
      };
    }

    let hasWhitespace = false;
    if (token.type === TokenType.Whitespace) {
      hasWhitespace = true;
      index = index + 1;
      token = tokens[index];
    }
    if (!token) {
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
    } else if (token.type === TokenType.Semicolon) {
      return {
        expr: primaryExpr,
        index: index + 1,
      };
    } else {
      throw this.formatErrorMessage(
        token,
        "Expected ( for function call, or ; to end the expression"
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

  private parseBinaryOp({
    lhs,
    tokens,
    index,
  }: {
    lhs: Expr;
    tokens: Token[];
    index: number;
  }): ParserReturn {
    let token = tokens[index];
    if (!token) {
      return {
        expr: lhs,
        index,
      };
    }

    if (token.type === TokenType.Whitespace) {
      index = index + 1;
      token = tokens[index];
    }
    if (!token) {
      return {
        expr: lhs,
        index,
      };
    }

    if (
      token.type === TokenType.Operator ||
      token.type === TokenType.InfixIdentifier
    ) {
      const { expr: rhs, index: nextIndex } = this.parsePrimary({
        tokens,
        index: index + 1,
      });
      return this.parseBinaryOp({
        lhs: {
          type: "FuncCall",
          func: {
            type: "Atom",
            token,
          },
          args: [lhs, rhs],
        },
        tokens,
        index: nextIndex,
      });
    } else if (token.type === TokenType.Semicolon) {
      return {
        expr: lhs,
        index,
      };
    } else {
      throw this.formatErrorMessage(token, `Expected operator or ;`);
    }
  }

  private parseExpression({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
    });
    return this.parseBinaryOp({
      lhs: expr,
      tokens,
      index: nextIndex,
    });
  }

  private parse(tokens: Token[]) {
    let index = 0;
    const exprs: Expr[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = tokens[index];
      if (!token) {
        break;
      }
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

      const { expr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
      });

      exprs.push(expr);
      index = nextIndex;
    }

    this.program = exprs;
  }
}
