/* eslint-disable no-constant-condition */
import { formatErrorMessage } from "./error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "./expr";
import { tokenize } from "./lexer";
import {
  findMatchingBracketTokenIndex,
  PlaceholderToken,
  Token,
  TokenType,
} from "./token";
import { randomId } from "./utils";

type ParserReturn = {
  expr: Expr;
  index: number;
};

export default class Parser {
  private inputString: string;
  private modulePath: string;
  private tokens: Token[];
  private program: Expr[];
  private parserError: Error | undefined;

  constructor({
    modulePath,
    inputString,
  }: {
    modulePath: string;
    inputString: string;
  }) {
    this.modulePath = modulePath;
    this.inputString = inputString;
    this.tokens = tokenize(inputString, modulePath);
    this.program = [];

    this.parse(this.tokens);
  }

  /*
  private generateTempVariableName(): string {
    return generateNewTempVariableName(this.modulePath);
  }
  */

  private skipWhitespace(tokens: Token[], index: number): number {
    while (
      tokens[index] &&
      (tokens[index]!.type === TokenType.Whitespace ||
        tokens[index]!.type === TokenType.SingleLineComment ||
        tokens[index]!.type === TokenType.MultiLineComment)
    ) {
      index = index + 1;
    }
    return index;
  }

  private skipWhitespaceBackward(tokens: Token[], index: number): number {
    while (
      tokens[index] &&
      (tokens[index]!.type === TokenType.Whitespace ||
        tokens[index]!.type === TokenType.SingleLineComment ||
        tokens[index]!.type === TokenType.MultiLineComment)
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
      Boolean(tokens[startIndex]) &&
      tokens[startIndex]!.type === TokenType.LParen &&
      Boolean(tokens[endIndex]) &&
      tokens[endIndex]!.type === TokenType.RParen &&
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
    if (tokens[index]!.type !== TokenType.LParen) {
      throw formatErrorMessage({
        token: tokens[index]!,
        errorMessage: "Expected left paren",
      });
    }
    if (tokens[index + 1]?.type === TokenType.RParen) {
      // unit type
      return {
        expr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinKeywords.tuple,
              position: tokens[index]!.position,
              modulePath: this.modulePath,
              inputString: this.inputString,
            },
          },
          args: [],
          token: tokens[index]!,
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
    /**
     * Expression like (3), (x) that wraps a single expression
     */
    if (tokens[index]!.type === TokenType.RParen) {
      return {
        expr,
        index: index + 1,
      };
    } else {
      // Parse tuple
      let separator: TokenType.Semicolon | TokenType.Comma | undefined =
        undefined;
      const args = [expr];
      while (true) {
        if (!tokens[index]) {
          throw formatErrorMessage({
            token: tokens[index - 1]!,
            errorMessage: "Expected ) or , for tuple",
          });
        }
        if (tokens[index]!.type === TokenType.Comma) {
          if (!separator || separator === TokenType.Comma) {
            separator = TokenType.Comma;
          } else {
            throw formatErrorMessage({
              token: tokens[index]!,
              errorMessage: 'Cannot mix "," with ";" as separator in (...)',
            });
          }

          index = index + 1;
        } else if (tokens[index]!.type === TokenType.Semicolon) {
          if (!separator || separator === TokenType.Semicolon) {
            separator = TokenType.Semicolon;
          } else {
            throw formatErrorMessage({
              token: tokens[index]!,
              errorMessage: 'Cannot mix ";" with "," as separator in (...)',
            });
          }
          index = index + 1;
        }

        // Skip whitespace after separator before checking for closing paren
        index = this.skipWhitespace(tokens, index);
        if (tokens[index]!.type === TokenType.RParen) {
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

      const isTupleType = separator === TokenType.Semicolon || !separator;

      return {
        expr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: isTupleType
                ? BuiltinKeywords.Tuple[0]!
                : BuiltinKeywords.tuple,
              position: tokens[startIndex]!.position,
              modulePath: this.modulePath,
              inputString: this.inputString,
            },
          },
          args,
          token: tokens[startIndex]!,
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
    if (tokens[index]!.type !== TokenType.LBracket) {
      throw formatErrorMessage({
        token: tokens[index]!,
        errorMessage: "Expected left bracket",
      });
    }
    index = index + 1;

    // Parse array
    let separator: TokenType.Semicolon | TokenType.Comma | undefined =
      undefined;
    const args: Expr[] = [];
    while (true) {
      if (!tokens[index]) {
        throw formatErrorMessage({
          token: tokens[index - 1]!,
          errorMessage: "Expected ] or , for array",
        });
      }
      if (tokens[index]!.type === TokenType.Comma) {
        if (!separator || separator === TokenType.Comma) {
          separator = TokenType.Comma;
        } else {
          throw formatErrorMessage({
            token: tokens[index]!,
            errorMessage: 'Cannot mix "," with ";" as separator in [...]',
          });
        }
        index = index + 1;
      } else if (tokens[index]!.type === TokenType.Semicolon) {
        if (!separator || separator === TokenType.Semicolon) {
          separator = TokenType.Semicolon;
        } else {
          throw formatErrorMessage({
            token: tokens[index]!,
            errorMessage: 'Cannot mix ";" with "," as separator in [...]',
          });
        }
        index = index + 1;
      }
      if (tokens[index]!.type === TokenType.RBracket) {
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

    // eg: [i32; 5] => Array
    // eg: [i32] or [i32;] => Slice
    const isArrayOrSliceType = separator === TokenType.Semicolon || !separator;
    if (isArrayOrSliceType && args.length > 2) {
      throw formatErrorMessage({
        token: tokens[startIndex]!,
        errorMessage: `Expected at 2 arguments for Array type, or 1 argument for Slice type, got ${args.length}`,
      });
    }
    const isArrayType = isArrayOrSliceType && args.length === 2;
    const isSliceType = isArrayOrSliceType && args.length === 1;

    return {
      expr: {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: isArrayType
              ? BuiltinKeywords.Array[0]!
              : isSliceType
                ? BuiltinKeywords.Slice[0]!
                : BuiltinKeywords.array,
            position: tokens[startIndex]!.position,
            modulePath: this.modulePath,
            inputString: this.inputString,
          },
        },
        args,
        token: tokens[startIndex]!,
      },
      index: index + 1,
    };
  }

  private parseCurlyBracketExpr({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): ParserReturn {
    const startIndex = index;
    if (tokens[index]!.type !== TokenType.LCurlyBracket) {
      throw formatErrorMessage({
        token: tokens[index]!,
        errorMessage: "Expected left curly bracket",
      });
    }
    const args: Expr[] = [];
    let separator: TokenType.Semicolon | TokenType.Comma | undefined =
      undefined;
    index = index + 1;
    while (true) {
      index = this.skipWhitespace(tokens, index);
      if (!tokens[index]) {
        throw formatErrorMessage({
          token: tokens[index - 1]!,
          errorMessage:
            'Unexpected end of curly bracket. Expected "}" or "," or ";"',
        });
      }
      if (tokens[index]!.type === TokenType.Comma) {
        if (!separator || separator === TokenType.Comma) {
          separator = TokenType.Comma;
        } else {
          throw formatErrorMessage({
            token: tokens[index]!,
            errorMessage: 'Cannot mix "," with ";" as separator in {...}',
          });
        }
        index = index + 1;
      } else if (tokens[index]!.type === TokenType.Semicolon) {
        if (!separator || separator === TokenType.Semicolon) {
          separator = TokenType.Semicolon;
        } else {
          throw formatErrorMessage({
            token: tokens[index]!,
            errorMessage: 'Cannot mix ";" with "," as separator in {...}',
          });
        }
        index = index + 1;
      }
      index = this.skipWhitespace(tokens, index);
      if (tokens[index]!.type === TokenType.RCurlyBracket) {
        // begin block,
        // lets check if the forwarded token is a semicolon
        const lastNonWhiteSpaceToken =
          tokens[this.skipWhitespaceBackward(tokens, index - 1)];
        if (
          separator === TokenType.Semicolon &&
          lastNonWhiteSpaceToken &&
          (lastNonWhiteSpaceToken.type === TokenType.Semicolon ||
            lastNonWhiteSpaceToken.type === TokenType.LCurlyBracket)
        ) {
          const token: Token = {
            type: TokenType.Identifier,
            value: BuiltinKeywords.tuple,
            position: lastNonWhiteSpaceToken.position,
            modulePath: this.modulePath,
            inputString: this.inputString,
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

    if (separator === TokenType.Comma || !separator) {
      // Go over the args, if it's an identifier, then convert it to (:)
      // For example:
      // { x, y: 2 }
      // get converted to
      // _( x: x, y: 2 );
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (exprIsAtom(arg)) {
          const colonToken: Token = {
            type: TokenType.Operator,
            value: ":",
            position: tokens[startIndex]!.position,
            modulePath: this.modulePath,
            inputString: this.inputString,
          };
          const newArg: FuncCallExpr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: colonToken,
            },
            isInfix: true,
            args: [arg, arg],
            token: colonToken,
          };
          args[i] = newArg;
        }
      }

      const returnExpr: FuncCallExpr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            // QUESTION: Should we take _ out as an individual token type?
            value: "_",
            position: tokens[startIndex]!.position,
            modulePath: this.modulePath,
            inputString: this.inputString,
          },
        },
        args,
        token: tokens[startIndex]!,
      };
      return {
        expr: returnExpr,
        index: index + 1,
      };
    } else {
      return {
        expr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinKeywords.begin[0]!, // begin block
              position: tokens[startIndex]!.position,
              modulePath: this.modulePath,
              inputString: this.inputString,
            },
          },
          args,
          token: tokens[startIndex]!,
        },
        index: index + 1,
      };
    }
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
      throw formatErrorMessage({
        token: PlaceholderToken,
        errorMessage: "Unexpected end of input",
      });
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
        throw formatErrorMessage({
          token: token,
          errorMessage: `Unexpected token "${token.type}"`,
        });
      }
    }

    return returnValue;
  }

  private isOperatorAtLineStart(
    tokensBeforeOperator: Token[],
    _operatorIndex: number
  ): boolean {
    // Look backwards from the operator to find the last newline
    for (let i = tokensBeforeOperator.length - 1; i >= 0; i--) {
      const token = tokensBeforeOperator[i]!;
      if (token.type === TokenType.Whitespace && token.value.includes("\n")) {
        // Found a newline, check if there are only whitespace tokens between newline and operator
        const tokensBetween = tokensBeforeOperator.slice(i + 1);
        const onlyWhitespace = tokensBetween.every(
          (t) => t.type === TokenType.Whitespace
        );
        return onlyWhitespace;
      }
      // If we hit a non-whitespace token before finding a newline, operator is not at line start
      if (token.type !== TokenType.Whitespace) {
        return false;
      }
    }
    // If we reach here, we're at the beginning of the file with only whitespace before operator
    return tokensBeforeOperator.every((t) => t.type === TokenType.Whitespace);
  }

  private parseLeftAssociativeOperator({
    primaryExpr,
    operatorToken,
    rhs,
    tokens,
    index,
  }: {
    primaryExpr: Expr;
    operatorToken: Token;
    rhs: Expr;
    tokens: Token[];
    index: number;
  }): ParserReturn {
    // For left associativity, we need to restructure chained operators
    // Input: 1 + 2 + 3 (where + are at line start)
    // Desired: (1 + 2) + 3

    if (
      rhs.tag === "FuncCall" &&
      rhs.isInfix &&
      rhs.func.tag === "Atom" &&
      rhs.func.token.type !== TokenType.Dot
    ) {
      // RHS is also an infix operator, restructure for left associativity
      // rhs = (a op b), we want: ((primaryExpr currentOp a) op b)
      const leftOperand = rhs.args[0]!;
      const rightOperand = rhs.args[1]!;
      const rhsOperator = rhs.func;

      const leftSide: Expr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: operatorToken,
        },
        args: [primaryExpr, leftOperand],
        isInfix: true,
        token: operatorToken,
      };

      return this.parsePrimaryEnd({
        primaryExpr: {
          tag: ExprTag.FuncCall,
          func: rhsOperator,
          args: [leftSide, rightOperand],
          isInfix: true,
          token: rhsOperator.token,
        },
        tokens,
        index,
      });
    } else {
      // Simple case: no chaining
      return this.parsePrimaryEnd({
        primaryExpr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: operatorToken,
          },
          args: [primaryExpr, rhs],
          isInfix: true,
          token: operatorToken,
        },
        tokens,
        index,
      });
    }
  }

  /**
   * Get the minimum column number of the expression
   * @param expr The expression to get the minimum column number
   * @returns The minimum column number of the expression
   */
  private getExprMinimumColumnNumber(expr: Expr): number {
    // Traverse all the tokens
    if (exprIsAtom(expr)) {
      return expr.token.position.column;
    } else {
      return Math.min(
        this.getExprMinimumColumnNumber(expr.func),
        ...expr.args.map((arg) => this.getExprMinimumColumnNumber(arg))
      );
    }
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
    const hasWhitespaceForward = nextIndex !== index;
    const hasWhitespaceBackward =
      tokens[index - 1]?.type === TokenType.Whitespace;
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
      (token.type === TokenType.Dot &&
        !hasWhitespaceForward &&
        !hasWhitespaceBackward &&
        tokens[nextIndex + 1]?.type !== TokenType.Whitespace)
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
      while (tokens[index] && tokens[index]!.type === TokenType.Dot) {
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
      (token.type === TokenType.Operator ||
        (token.type === TokenType.Dot && !hasWhitespaceForward) ||
        token.type === TokenType.BacktickIdentifier) &&
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
        const ambiguityErrorMessage = `Ambiguous operator precedence. 
Please use parentheses to clarify:

${exprToString(primaryExpr)} ${token.value} (${exprToString(rhs)})
// or
(${exprToString(primaryExpr)} ${token.value} ${exprToString(
          rhs.args[0]!
        )}) ${exprToString(rhs.func)} ${exprToString(rhs.args[1]!)}

Or use newline after "${token.value}" to confirm the right-associativity.
`;
        // We allow to use newline indentation to implicitly
        // skip the parenthese check.
        //
        // Right associativity (operator at end of line):
        // 1 +
        //   2 + 3
        // will be parsed as: 1 + (2 + 3)
        //
        // Left associativity (operator at start of line):
        //   1
        // + 2
        // + 3
        // will be parsed as: (1 + 2) + 3
        const tokensInBetween = tokens.slice(index + 1, startIndex);
        const hasNewLineAfterOperator = tokensInBetween.some(
          (token) =>
            token.type === TokenType.Whitespace && token.value.includes("\n")
        );

        // Check if current operator is at the start of a line (left associativity)
        const tokensBeforeOperator = tokens.slice(0, index);
        const isOperatorAtLineStart = this.isOperatorAtLineStart(
          tokensBeforeOperator,
          index
        );

        // Check if operator is alone on its own line
        const tokensAfterOperator = tokens.slice(index + 1, startIndex);
        const isOperatorAloneOnLine =
          isOperatorAtLineStart &&
          tokensAfterOperator.length > 0 &&
          tokensAfterOperator[0]?.type === TokenType.Whitespace &&
          tokensAfterOperator[0]?.value.includes("\n");

        if (hasNewLineAfterOperator && !isOperatorAtLineStart) {
          // Right associativity: operator at end of line
          // Allow: 1 + (2 + 3)
        } else if (isOperatorAloneOnLine) {
          // Special case: operator alone on its own line - prefer right associativity
          // This handles cases like:
          // a
          // =
          //   b -> c
          // Should parse as: a = (b -> c), not (a = b) -> c
        } else if (isOperatorAtLineStart) {
          // Left associativity: operator at start of line (but not alone)
          // Force left grouping by restructuring the expression
          return this.parseLeftAssociativeOperator({
            primaryExpr,
            operatorToken: token,
            rhs,
            tokens,
            index: nextIndex,
          });
        } else {
          throw formatErrorMessage({
            token: token,
            errorMessage: ambiguityErrorMessage,
          });
        }
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
    }

    // Backtick identifier function call
    // QUESTION: Should we only support this for infix operator?
    //           So only 2 arguments are allowed?
    // such as:
    // 1 `add` 2
    // 1 `add` 2, 3
    // Convert them to normal function call expr
    // such as:
    // add(1, 2)
    // add(1, 2, 3)
    // ANSWER: Yes we should only support 2 arguments
    // Having more than 2 arguments might cause confusion.
    // So basically we regard it as the infix operator.
    /*
    else if (token.type === TokenType.BacktickIdentifier) {
      const { index: nextIndex, args } = this.parseFunctionArguments({
        tokens,
        index: index + 1,
        hasWhitespace: true,
      });
      return this.parsePrimaryEnd({
        primaryExpr: {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token,
          },
          args: [primaryExpr, ...args],
          isInfix: true,
          token,
        },
        tokens,
        index: nextIndex,
      });
    }
    */
    else if (
      !hasWhitespaceForward &&
      // NOTE: We added the condition below to support parsing:
      //
      //   (-12)
      //
      token.type === TokenType.LParen
    ) {
      //if (token.type === TokenType.LParen) {
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
      //       //} else {
      //         throw formatErrorMessage({
      //           token: token,
      //           errorMessage: `Ambiguous function call ${exprToString(primaryExpr)}${token.value}
      // Please use parentheses to clarify:
      //
      // ${exprToString(primaryExpr)}(${token.value}, ...)
      // // or
      // (${exprToString(primaryExpr)} ${token.value}, ...)
      // `,
      //         });
      //       }
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
        throw formatErrorMessage(
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

  private parseFunctionArguments({
    tokens,
    index,
    hasWhitespace,
  }: {
    tokens: Token[];
    index: number;
    /**
     * If the function call has whitespace between the function name and the arguments
     * like `add 3, 4` instead of `add(3, 4)`
     */
    hasWhitespace: boolean;
  }): { args: Expr[]; index: number } {
    // Parse arguments
    const args: Expr[] = [];
    index = this.skipWhitespace(tokens, index);

    if (!hasWhitespace && tokens[index]?.type === TokenType.RParen) {
      return { args, index: index + 1 };
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
          args,
          index,
        };
      } else if (token.type === TokenType.RParen) {
        return {
          args,
          index: hasWhitespace ? index : index + 1,
        };
      } else {
        throw formatErrorMessage({
          token: token,
          errorMessage: hasWhitespace
            ? "Expected ; to end the function call"
            : `Expected , to separate arguments
or ) to end the function call`,
        });
      }
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
    const { args, index: nextIndex } = this.parseFunctionArguments({
      tokens,
      index,
      hasWhitespace,
    });
    index = nextIndex;
    return {
      expr: {
        tag: ExprTag.FuncCall,
        func,
        args,
        token: func.token,
      },
      index,
    };
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
      const token = tokens[index]!;
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
      try {
        const { expr, index: nextIndex } = this.parseExpression({
          tokens,
          index,
        });
        exprs.push(expr);
        index = nextIndex;
      } catch (error) {
        this.parserError = error;
        break;
      }
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
        value: BuiltinKeywords.tuple,
        position: lastNonWhiteSpaceToken.position,
        modulePath: this.modulePath,
        inputString: this.inputString,
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
  public getParserError() {
    return this.parserError;
  }
  public getTokens() {
    return this.tokens;
  }
}

/**
 * Generate an expression from code string
 */
export function generateExprFromCode(code: string): Expr {
  // Create a parser for the code
  const parser = new Parser({
    modulePath: `auto-generated://${randomId()}`,
    inputString: code,
  });

  if (parser.getParserError()) {
    throw parser.getParserError()!;
  }

  // Get the parsed expressions
  const program = parser.getProgram();
  if (program.length !== 1) {
    throw new Error(
      `Expected exactly one expression from parsed code, got ${program.length}: "${code}"
${program.map((expr) => exprToString(expr)).join("\n")}      
`
    );
  }

  return program[0]!;
}
