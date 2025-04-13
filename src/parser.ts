/* eslint-disable no-constant-condition */
import { formatErrorMessage } from "./error";
import { BuiltinCollections, Expr, ExprTag, exprToString } from "./expr";
import { tokenize } from "./lexer";
import { findMatchingBracketTokenIndex, Token, TokenType } from "./token";

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

  private skipWhitespace(tokens: Token[], index: number): number {
    while (
      tokens[index] &&
      (tokens[index].type === TokenType.Whitespace ||
        tokens[index].type === TokenType.SingleLineComment ||
        tokens[index].type === TokenType.MultiLineComment)
    ) {
      index = index + 1;
    }
    return index;
  }

  private skipWhitespaceBackward(tokens: Token[], index: number): number {
    while (
      tokens[index] &&
      (tokens[index].type === TokenType.Whitespace ||
        tokens[index].type === TokenType.SingleLineComment ||
        tokens[index].type === TokenType.MultiLineComment)
    ) {
      index = index - 1;
    }
    return index;
  }

  private isParenthesizedExpression(
    tokens: Token[],
    startIndex: number,
    endIndex: number
  ): boolean {
    startIndex = this.skipWhitespace(tokens, startIndex);
    endIndex = this.skipWhitespaceBackward(tokens, endIndex);
    return (
      tokens[startIndex] &&
      tokens[startIndex].type === TokenType.LParen &&
      tokens[endIndex] &&
      tokens[endIndex].type === TokenType.RParen &&
      findMatchingBracketTokenIndex(tokens, startIndex) === endIndex
    );
  }

  private parseParenExpr({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    const startIndex = index;
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    if (tokens[index + 1].type === TokenType.RParen) {
      // unit type
      return {
        expr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinCollections.Tuple,
              position: tokens[index].position,
            },
          },
          args: [],
          token: tokens[index],
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
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinCollections.Tuple,
              position: tokens[startIndex].position,
            },
          },
          args,
          token: tokens[startIndex],
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
    const startIndex = index;
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
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinCollections.Array,
              position: tokens[startIndex].position,
            },
          },
          args,
          token: tokens[startIndex],
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
    const startIndex = index;
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected left curly bracket"
      );
    }
    const args: Expr[] = [];
    index = index + 1;
    while (true) {
      index = this.skipWhitespace(tokens, index);
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index - 1],
          "Expected } or , for struct"
        );
      }
      if (tokens[index].type === TokenType.Comma) {
        throw this.formatErrorMessage(
          tokens[index],
          "Cannot use , as separator in {...}"
        );
      } else if (tokens[index].type === TokenType.Semicolon) {
        index = index + 1;
      }
      index = this.skipWhitespace(tokens, index);
      if (tokens[index].type === TokenType.RCurlyBracket) {
        // begin block,
        // lets check if the forwarded token is a semicolon
        const lastNonWhiteSpaceToken =
          tokens[this.skipWhitespaceBackward(tokens, index - 1)];
        if (
          lastNonWhiteSpaceToken &&
          (lastNonWhiteSpaceToken.type === TokenType.Semicolon ||
            lastNonWhiteSpaceToken.type === TokenType.LCurlyBracket)
        ) {
          const token: Token = {
            type: TokenType.Identifier,
            value: BuiltinCollections.Tuple,
            position: lastNonWhiteSpaceToken.position,
          };
          // Push unit
          args.push({
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token,
            },
            args: [],
            token,
          });
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
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: BuiltinCollections.Begin, // begin block
            position: tokens[startIndex].position,
          },
        },
        args,
        token: tokens[startIndex],
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
            tag: ExprTag.Atom,
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
      case TokenType.Dot: {
        // The rest will be parsed in parsePrimaryEnd
        returnValue = {
          expr: {
            tag: ExprTag.Atom,
            token,
          },
          index: index + 1,
        };
        break;
      }
      default: {
        throw this.formatErrorMessage(token, `Unexpected token: ${token.type}`);
      }
    }

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
    if (
      !token ||
      token.type === TokenType.Semicolon ||
      token.type === TokenType.Comma ||
      token.type === TokenType.RParen ||
      token.type === TokenType.RBracket ||
      token.type === TokenType.RCurlyBracket
    ) {
      return {
        expr: primaryExpr,
        index,
      };
    }

    // NOTE: "." is the special case here which has the highest operator precedence
    // .Person
    // Person.Person
    const primaryExprIsDotOperator =
      primaryExpr.tag === "Atom" && primaryExpr.token.type === TokenType.Dot;
    if (
      primaryExprIsDotOperator ||
      (token.type === TokenType.Dot && !hasWhitespace)
    ) {
      // Field access like
      // obj.field
      const { expr, index: nextIndex } = this.parsePrimary({
        tokens,
        index: primaryExprIsDotOperator ? index : index + 1,
      });
      index = nextIndex;
      let returnValue: ParserReturn = {
        expr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: primaryExprIsDotOperator ? primaryExpr.token : token,
          },
          args: primaryExprIsDotOperator ? [expr] : [primaryExpr, expr],
          isInfix: primaryExprIsDotOperator ? false : true,
          token: primaryExprIsDotOperator ? primaryExpr.token : token,
        },
        index,
      };
      // Check chaining
      while (tokens[index] && tokens[index].type === TokenType.Dot) {
        const { expr, index: nextIndex } = this.parsePrimary({
          tokens,
          index: index + 1,
        });
        returnValue = {
          expr: {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token,
            },
            args: [returnValue.expr, expr],
            isInfix: true,
            token,
          },
          index: nextIndex,
        };
        index = nextIndex;
      }

      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
      });
    } else if (
      token.type === TokenType.Operator &&
      // prevent the case
      // use &(x), a;
      // getting parsed as:
      // (use & x), a;
      // which is incorrect
      tokens[index + 1]?.type !== TokenType.LParen
    ) {
      // Infix operator
      const startIndex = this.skipWhitespace(tokens, index + 1);
      const { expr: rhs, index: nextIndex } = this.parseExpression({
        tokens,
        index: startIndex,
      });

      // Check if the RHS is already an operator expression (meaning we have chained operators)
      if (
        rhs.tag === "FuncCall" &&
        rhs.isInfix &&
        rhs.func.tag === "Atom" &&
        rhs.func.token.type !== TokenType.Dot && // Allow dot operator to chain
        !this.isParenthesizedExpression(tokens, startIndex, nextIndex - 1) // Check if the RHS is already parenthesized
      ) {
        throw this.formatErrorMessage(
          token,
          `Ambiguous operator precedence. 
Please use parentheses to clarify:

${exprToString(primaryExpr)} ${token.value} (${exprToString(rhs)})
// or
(${exprToString(primaryExpr)} ${token.value} ${exprToString(
            rhs.args[0]
          )}) ${exprToString(rhs.func)} ${exprToString(rhs.args[1])} 

`
        );
      }

      return this.parsePrimaryEnd({
        primaryExpr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token,
          },
          args: [primaryExpr, rhs],
          isInfix: true,
          token,
        },
        tokens,
        index: nextIndex,
      });
    } else if (!hasWhitespace) {
      if (token.type === TokenType.LParen) {
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
      } else {
        throw this.formatErrorMessage(
          token,
          `Ambiguous function call ${exprToString(primaryExpr)}${token.value} 
Please use parentheses to clarify:

${exprToString(primaryExpr)}(${token.value}, ...)
// or 
(${exprToString(primaryExpr)} ${token.value}, ...)
`
        );
      }
    } else {
      // Function call like
      // add 3, 4
      const returnValue = this.parseFunctionCall({
        func: primaryExpr,
        tokens,
        index: index,
        hasWhitespace: true,
      });

      /*
      if (
        primaryExpr.type === "Atom" &&
        primaryExpr.token.type === TokenType.Operator
      ) {
        throw this.formatErrorMessage(
          primaryExpr.token,
          `Ambiguous operator function call ${primaryExpr.token.value}.
Please use parentheses to clarify:
          
${exprToString(returnValue.expr)}`
        );
      }
        */

      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
      });
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
    index = this.skipWhitespace(tokens, index);

    if (!hasWhitespace && tokens[index]?.type === TokenType.RParen) {
      return {
        expr: {
          tag: ExprTag.FuncCall,
          func,
          args,
          token: func.token,
        },
        index: index + 1,
      };
    }

    while (true) {
      const { expr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
      });
      args.push(expr);
      index = nextIndex;
      const token = tokens[index];
      if (token?.type === TokenType.Comma) {
        // Continue parsing arguments
        index = index + 1;
      } else if (
        !token ||
        token.type === TokenType.Semicolon ||
        token.type === TokenType.RBracket ||
        token.type === TokenType.RCurlyBracket
      ) {
        return {
          expr: {
            tag: ExprTag.FuncCall,
            func,
            args,
            token: func.token,
          },
          index: index,
        };
      } else if (token.type === TokenType.RParen) {
        return {
          expr: {
            tag: ExprTag.FuncCall,
            func,
            args,
            token: func.token,
          },
          index: hasWhitespace ? index : index + 1,
        };
      } else {
        throw this.formatErrorMessage(
          token,

          hasWhitespace
            ? "Expected ; to end the function call"
            : `Expected , to separate arguments
or ) to end the function call`
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
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
    });

    return this.parsePrimaryEnd({
      primaryExpr: expr,
      tokens,
      index: nextIndex,
    });
  }

  public programToString() {
    const printed = this.program
      .map((expr) => {
        return exprToString(expr);
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
          continue;
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
      const token: Token = {
        type: TokenType.Identifier,
        value: BuiltinCollections.Tuple,
        position: lastNonWhiteSpaceToken.position,
      };
      // Add unit
      exprs.push({
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token,
        },
        args: [],
        token,
      });
    }

    this.program = exprs;
  }

  public getProgram() {
    return this.program;
  }
  public getTokens() {
    return this.tokens;
  }
}
