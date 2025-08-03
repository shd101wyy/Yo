import {
  BuiltinKeywords,
  Expr,
  ExprTag,
  FuncCallExpr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  exprsAreEqual,
} from "./expr";
import { TokenType } from "./token";
import { randomId } from "./utils";

/**
 * CPS Transformer class that handles continuation-passing style transformations
 */
export class CpsTransformer {
  private usedDoExpressions: Expr[];

  constructor(usedDoExpressions: Expr[]) {
    this.usedDoExpressions = usedDoExpressions;
  }

  /**
   * Check if an expression contains a do call by comparing against usedDoExpressions
   */
  private containsDoCall(expr: Expr): boolean {
    // Check if this expression is one of the used do expressions
    for (const usedDo of this.usedDoExpressions) {
      if (exprsAreEqual(expr, usedDo)) {
        return true;
      }
    }
    if (exprIsFunctionCall(expr)) {
      // Check all arguments recursively
      return expr.args.some((arg) => this.containsDoCall(arg));
    }

    return false;
  }

  /**
   * Transform an expression containing `do` calls to CPS
   */
  transformExpressionToCps(expr: Expr, continuationVar: string): Expr {
    switch (expr.tag) {
      case ExprTag.FuncCall:
        return this.transformFuncCallToCps(expr, continuationVar);

      case ExprTag.Atom:
        // Atoms don't contain do calls, return as-is
        return expr;

      default:
        // For now, just return the expression as-is
        return expr;
    }
  }

  /**
   * Transform a function call expression to CPS
   */
  private transformFuncCallToCps(
    expr: FuncCallExpr,
    continuationVar: string
  ): Expr {
    if (exprIsFunctionCallOf(expr, "do")) {
      // This is a direct `do` call
      return this.transformDoCallToCps(expr, continuationVar);
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
      // This is a `begin` expression
      return this.transformBeginToCps(expr, continuationVar);
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
      // This is a `cond` expression
      return this.transformCondToCps(expr, continuationVar);
    } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
      // This is a `match` expression
      return this.transformMatchToCps(expr, continuationVar);
    } else if (exprIsFunctionCallOf(expr, ":=") && expr.isInfix) {
      // This is an assignment - check if it contains do calls
      if (this.containsDoCall(expr)) {
        // Assignment contains do calls, but we can't handle it here because we don't have remaining expressions
        // This should have been caught by transformExpressionWithDoToCps instead
        throw new Error(
          "Assignment with do calls should be handled by transformExpressionWithDoToCps, not transformExpressionToCps"
        );
      }
      // Regular assignment without do calls
      return this.transformAssignmentToCps(expr, continuationVar);
    } else {
      // For other function calls, recursively transform arguments
      const transformedArgs = expr.args.map((arg) =>
        this.transformExpressionToCps(arg, continuationVar)
      );

      return {
        ...expr,
        args: transformedArgs,
      };
    }
  }

  /**
   * Transform a do call to CPS
   */
  private transformDoCallToCps(
    doExpr: FuncCallExpr,
    continuationVar: string
  ): Expr {
    if (doExpr.args.length !== 1) {
      throw new Error(
        `do() expects exactly 1 argument, got ${doExpr.args.length}`
      );
    }

    const innerExpr = doExpr.args[0]!;

    if (!exprIsFunctionCall(innerExpr)) {
      throw new Error(
        `do() argument must be a function call, got: ${innerExpr.tag}`
      );
    }

    // Create continuation parameter name
    const resultVar = `cps_result_${randomId()}`;

    // Create the continuation body - just call the final continuation
    const continuationBody: Expr = {
      tag: ExprTag.FuncCall,
      func: {
        tag: ExprTag.Atom,
        token: {
          type: TokenType.Identifier,
          value: continuationVar,
          position: doExpr.token.position,
          modulePath: doExpr.token.modulePath,
          inputString: doExpr.token.inputString,
        },
      },
      args: [
        {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: resultVar,
            position: doExpr.token.position,
            modulePath: doExpr.token.modulePath,
            inputString: doExpr.token.inputString,
          },
        },
      ],
      token: doExpr.token,
    };

    // Create the continuation closure: (result) => continuation_body
    const continuation: Expr = {
      tag: ExprTag.FuncCall,
      func: {
        tag: ExprTag.Atom,
        token: {
          type: TokenType.Operator,
          value: "=>",
          position: doExpr.token.position,
          modulePath: doExpr.token.modulePath,
          inputString: doExpr.token.inputString,
        },
      },
      args: [
        {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: resultVar,
            position: doExpr.token.position,
            modulePath: doExpr.token.modulePath,
            inputString: doExpr.token.inputString,
          },
        },
        continuationBody,
      ],
      token: doExpr.token,
      isInfix: true,
    };

    // Transform: do(f(args)) -> f(args, continuation)
    const transformedCall: FuncCallExpr = {
      ...innerExpr,
      args: [...innerExpr.args, continuation],
    };

    return transformedCall;
  }

  /**
   * Transform a begin expression to CPS
   */
  private transformBeginToCps(
    beginExpr: FuncCallExpr,
    continuationVar: string
  ): Expr {
    const expressions = beginExpr.args;

    // Find the first expression that contains a `do` call
    for (let i = 0; i < expressions.length; i++) {
      const expr = expressions[i]!;

      if (this.containsDoCall(expr)) {
        // Found an expression with a `do` call - split the begin expression
        const beforeDo = expressions.slice(0, i);
        const exprWithDo = expr;
        const afterDo = expressions.slice(i + 1);

        // Transform the expression containing the `do` call
        const transformedExpr = this.transformExpressionWithDoToCps(
          exprWithDo,
          afterDo,
          continuationVar,
          beginExpr.token
        );

        // If there are expressions before the `do`, wrap everything in a new `begin`
        if (beforeDo.length > 0) {
          return {
            ...beginExpr,
            args: [...beforeDo, transformedExpr],
          };
        } else {
          return transformedExpr;
        }
      }
    }

    // No `do` calls found, recursively transform all expressions
    const transformedArgs = expressions.map((arg) =>
      this.transformExpressionToCps(arg, continuationVar)
    );

    return {
      ...beginExpr,
      args: transformedArgs,
    };
  }

  /**
   * Transform an assignment expression to CPS
   */
  private transformAssignmentToCps(
    expr: FuncCallExpr,
    continuationVar: string
  ): Expr {
    const variable = expr.args[0]!;
    const value = expr.args[1]!;

    if (exprIsFunctionCall(value) && exprIsFunctionCallOf(value, "do")) {
      // Simple case: `variable := do(f(args))` -> `f(args, result => continuation)`
      const doExpr = value;

      // Use the existing do call transformation with continuation
      return this.transformDoCallToCpsWithContinuation(
        doExpr,
        [],
        continuationVar,
        expr.token
      );
    } else if (
      exprIsFunctionCall(value) &&
      exprIsFunctionCallOf(value, BuiltinKeywords.match) &&
      this.containsDoCall(value)
    ) {
      // Special case: `variable := match(...)` where match contains do calls
      return this.transformMatchWithAssignmentToCps(
        value,
        variable,
        [],
        continuationVar,
        expr.token
      );
    } else if (this.containsDoCall(value)) {
      // Complex case: `variable := expression_containing_do`
      // We need to extract the `do` call and create a continuation
      const doCallInfo = this.extractDoCall(value);
      if (!doCallInfo) {
        throw new Error("Expected to find a do call in the expression");
      }

      const { doExpr, expressionWithHole } = doCallInfo;
      const resultVar = `cps_result_${randomId()}`;

      // Replace the "hole" in the expression with the result variable
      const valueWithResult = this.replaceHoleWithVariable(
        expressionWithHole,
        resultVar,
        expr.token
      );

      // Create the assignment with the transformed value
      const assignment: FuncCallExpr = {
        tag: ExprTag.FuncCall,
        func: expr.func,
        args: [variable, valueWithResult],
        token: expr.token,
        isInfix: expr.isInfix,
      };

      // Create simple continuation that assigns and calls final continuation
      const continuationExpr: Expr = this.transformExpressionToCps(
        assignment,
        continuationVar
      );

      // Create the continuation closure
      const continuation: Expr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Operator,
            value: "=>",
            position: expr.token.position,
            modulePath: expr.token.modulePath,
            inputString: expr.token.inputString,
          },
        },
        args: [
          {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: resultVar,
              position: expr.token.position,
              modulePath: expr.token.modulePath,
              inputString: expr.token.inputString,
            },
          },
          continuationExpr,
        ],
        token: expr.token,
        isInfix: true,
      };

      // Transform the inner expression of the `do` call
      const innerExpr = doExpr.args[0]!;
      if (!exprIsFunctionCall(innerExpr)) {
        throw new Error(
          `do() argument must be a function call, got: ${innerExpr.tag}`
        );
      }

      return {
        ...innerExpr,
        args: [...innerExpr.args, continuation],
      };
    } else {
      // No do calls in the assignment, transform normally
      const transformedValue = this.transformExpressionToCps(
        value,
        continuationVar
      );
      return {
        ...expr,
        args: [variable, transformedValue],
      };
    }
  }

  /**
   * Transform a `do` call to CPS with a specific continuation that includes remaining expressions
   */
  private transformDoCallToCpsWithContinuation(
    doExpr: FuncCallExpr,
    remainingExprs: Expr[],
    continuationVar: string,
    contextToken: FuncCallExpr["token"]
  ): Expr {
    if (doExpr.args.length !== 1) {
      throw new Error(
        `do() expects exactly 1 argument, got ${doExpr.args.length}`
      );
    }

    const innerExpr = doExpr.args[0]!;

    if (!exprIsFunctionCall(innerExpr)) {
      throw new Error(
        `do() argument must be a function call, got: ${innerExpr.tag}`
      );
    }

    // Create continuation parameter name
    const resultVar = `cps_result_${randomId()}`;

    // Create the continuation body - either the remaining expressions or the final continuation call
    let continuationBody: Expr;

    if (remainingExprs.length === 0) {
      // No remaining expressions, just call the final continuation
      continuationBody = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: continuationVar,
            position: contextToken.position,
            modulePath: contextToken.modulePath,
            inputString: contextToken.inputString,
          },
        },
        args: [
          {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: resultVar,
              position: contextToken.position,
              modulePath: contextToken.modulePath,
              inputString: contextToken.inputString,
            },
          },
        ],
        token: contextToken,
      };
    } else if (remainingExprs.length === 1) {
      // Single remaining expression, transform it appropriately
      const remainingExpr = remainingExprs[0]!;
      if (this.containsDoCall(remainingExpr)) {
        // The remaining expression contains do calls, use transformExpressionWithDoToCps
        continuationBody = this.transformExpressionWithDoToCps(
          remainingExpr,
          [],
          continuationVar,
          contextToken
        );
      } else {
        // No do calls, use regular transformation
        continuationBody = this.transformExpressionToCps(
          remainingExpr,
          continuationVar
        );
      }
    } else {
      // Multiple remaining expressions, create a begin block and transform it
      const beginExpr: FuncCallExpr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: BuiltinKeywords.begin[0]!,
            position: contextToken.position,
            modulePath: contextToken.modulePath,
            inputString: contextToken.inputString,
          },
        },
        args: remainingExprs,
        token: contextToken,
      };

      // Transform the begin block, which will properly handle expressions with do calls
      continuationBody = this.transformExpressionToCps(
        beginExpr,
        continuationVar
      );
    }

    // Create the continuation closure: (result) => continuation_body
    const continuation: Expr = {
      tag: ExprTag.FuncCall,
      func: {
        tag: ExprTag.Atom,
        token: {
          type: TokenType.Operator,
          value: "=>",
          position: contextToken.position,
          modulePath: contextToken.modulePath,
          inputString: contextToken.inputString,
        },
      },
      args: [
        {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: resultVar,
            position: contextToken.position,
            modulePath: contextToken.modulePath,
            inputString: contextToken.inputString,
          },
        },
        continuationBody,
      ],
      token: contextToken,
      isInfix: true,
    };

    // Transform: do(f(args)) -> f(args, continuation)
    const transformedCall: FuncCallExpr = {
      ...innerExpr,
      args: [...innerExpr.args, continuation],
    };

    return transformedCall;
  }

  /**
   * Transform an expression that contains a `do` call, providing the remaining expressions as continuation
   */
  private transformExpressionWithDoToCps(
    expr: Expr,
    remainingExprs: Expr[],
    continuationVar: string,
    contextToken: FuncCallExpr["token"]
  ): Expr {
    if (exprIsFunctionCall(expr)) {
      if (exprIsFunctionCallOf(expr, "do")) {
        // This is a direct `do` call
        return this.transformDoCallToCpsWithContinuation(
          expr,
          remainingExprs,
          continuationVar,
          contextToken
        );
      } else if (exprIsFunctionCallOf(expr, ":=") && expr.args.length === 2) {
        // Handle assignment: `variable := expression_containing_do`
        const variable = expr.args[0]!;
        const value = expr.args[1]!;

        if (exprIsFunctionCall(value) && exprIsFunctionCallOf(value, "do")) {
          // Simple case: `variable := do(f(args))` -> `f(args, result => continuation)`
          const doExpr = value;

          // Create the continuation that assigns the result and continues with remaining expressions
          const resultVar = `cps_result_${randomId()}`;

          // Create the assignment with the result
          const assignment: FuncCallExpr = {
            tag: ExprTag.FuncCall,
            func: expr.func, // Use the same `:=` function
            args: [
              variable,
              {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Identifier,
                  value: resultVar,
                  position: contextToken.position,
                  modulePath: contextToken.modulePath,
                  inputString: contextToken.inputString,
                },
              },
            ],
            token: expr.token,
            isInfix: expr.isInfix,
          };

          // Create the continuation body that includes the assignment and remaining expressions
          let continuationBody: Expr;
          const allRemainingExprs = [assignment, ...remainingExprs];

          if (allRemainingExprs.length === 1) {
            const expr = allRemainingExprs[0]!;
            if (this.containsDoCall(expr)) {
              continuationBody = this.transformExpressionWithDoToCps(
                expr,
                [],
                continuationVar,
                contextToken
              );
            } else {
              continuationBody = this.transformExpressionToCps(
                expr,
                continuationVar
              );
            }
          } else {
            // Multiple expressions, create a begin block and transform it properly
            const beginExpr: FuncCallExpr = {
              tag: ExprTag.FuncCall,
              func: {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Identifier,
                  value: BuiltinKeywords.begin[0]!,
                  position: contextToken.position,
                  modulePath: contextToken.modulePath,
                  inputString: contextToken.inputString,
                },
              },
              args: allRemainingExprs,
              token: contextToken,
            };

            // Transform the begin block, which will handle expressions with do calls properly
            continuationBody = this.transformExpressionToCps(
              beginExpr,
              continuationVar
            );
          }

          // Create the continuation closure
          const continuation: Expr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Operator,
                value: "=>",
                position: contextToken.position,
                modulePath: contextToken.modulePath,
                inputString: contextToken.inputString,
              },
            },
            args: [
              {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Identifier,
                  value: resultVar,
                  position: contextToken.position,
                  modulePath: contextToken.modulePath,
                  inputString: contextToken.inputString,
                },
              },
              continuationBody,
            ],
            token: contextToken,
            isInfix: true,
          };

          // Transform the inner expression of the `do` call
          const innerExpr = doExpr.args[0]!;
          if (!exprIsFunctionCall(innerExpr)) {
            throw new Error(
              `do() argument must be a function call, got: ${innerExpr.tag}`
            );
          }

          // Return the transformed call with the continuation
          return {
            ...innerExpr,
            args: [...innerExpr.args, continuation],
          };
        } else if (
          exprIsFunctionCall(value) &&
          exprIsFunctionCallOf(value, BuiltinKeywords.cond) &&
          this.containsDoCall(value)
        ) {
          // Special case: `variable := cond(...)` where cond contains do calls

          // Check if any conditions contain `do` calls
          if (this.condHasDoInConditions(value)) {
            // Conditions contain `do` calls - we need special handling
            // We need to transform the cond with assignment context
            return this.transformCondWithAssignmentToCps(
              value,
              variable,
              remainingExprs,
              continuationVar,
              contextToken
            );
          }

          // Only bodies contain `do` calls, handle normally
          // Transform the cond so each branch assigns to the variable and continues
          const condExpr = value;

          // Create a continuation function that assigns the result and continues
          const assignmentContinuation = (resultValue: Expr) => {
            const assignment: FuncCallExpr = {
              tag: ExprTag.FuncCall,
              func: expr.func, // Use the same `:=` function
              args: [variable, resultValue],
              token: expr.token,
              isInfix: expr.isInfix,
            };

            const allRemainingExprs = [assignment, ...remainingExprs];

            if (allRemainingExprs.length === 1) {
              return this.transformExpressionToCps(
                allRemainingExprs[0]!,
                continuationVar
              );
            } else {
              const transformedRemainingExprs = allRemainingExprs.map((expr) =>
                this.transformExpressionToCps(expr, continuationVar)
              );
              return {
                tag: ExprTag.FuncCall,
                func: {
                  tag: ExprTag.Atom,
                  token: {
                    type: TokenType.Identifier,
                    value: BuiltinKeywords.begin[0]!,
                    position: contextToken.position,
                    modulePath: contextToken.modulePath,
                    inputString: contextToken.inputString,
                  },
                },
                args: transformedRemainingExprs,
                token: contextToken,
              } as FuncCallExpr;
            }
          };

          // Transform each branch of the cond
          const transformedBranches = condExpr.args.map((branch) => {
            if (
              exprIsFunctionCall(branch) &&
              branch.isInfix &&
              exprIsFunctionCallOf(branch, "=>")
            ) {
              const condition = branch.args[0]!;
              const body = branch.args[1]!;

              if (this.containsDoCall(body)) {
                // This branch contains do calls, transform it with the assignment continuation
                if (
                  exprIsFunctionCall(body) &&
                  exprIsFunctionCallOf(body, "do")
                ) {
                  // Direct do call: condition => do(f()) becomes condition => f(cps_result => assignment_continuation)
                  const doExpr = body;
                  const branchResultVar = `cps_result_${randomId()}`;

                  const branchContinuation: Expr = {
                    tag: ExprTag.FuncCall,
                    func: {
                      tag: ExprTag.Atom,
                      token: {
                        type: TokenType.Operator,
                        value: "=>",
                        position: contextToken.position,
                        modulePath: contextToken.modulePath,
                        inputString: contextToken.inputString,
                      },
                    },
                    args: [
                      {
                        tag: ExprTag.Atom,
                        token: {
                          type: TokenType.Identifier,
                          value: branchResultVar,
                          position: contextToken.position,
                          modulePath: contextToken.modulePath,
                          inputString: contextToken.inputString,
                        },
                      },
                      assignmentContinuation({
                        tag: ExprTag.Atom,
                        token: {
                          type: TokenType.Identifier,
                          value: branchResultVar,
                          position: contextToken.position,
                          modulePath: contextToken.modulePath,
                          inputString: contextToken.inputString,
                        },
                      }),
                    ],
                    token: contextToken,
                    isInfix: true,
                  };

                  const innerExpr = doExpr.args[0]!;
                  if (!exprIsFunctionCall(innerExpr)) {
                    throw new Error(
                      `do() argument must be a function call, got: ${innerExpr.tag}`
                    );
                  }

                  const transformedBody: FuncCallExpr = {
                    ...innerExpr,
                    args: [...innerExpr.args, branchContinuation],
                  };

                  return {
                    ...branch,
                    args: [condition, transformedBody],
                  };
                } else {
                  // Complex do call in body, recursively transform
                  const transformedBody = this.transformExpressionWithDoToCps(
                    {
                      tag: ExprTag.FuncCall,
                      func: {
                        tag: ExprTag.Atom,
                        token: {
                          type: TokenType.Identifier,
                          value: ":=",
                          position: contextToken.position,
                          modulePath: contextToken.modulePath,
                          inputString: contextToken.inputString,
                        },
                      },
                      args: [variable, body],
                      token: contextToken,
                      isInfix: true,
                    } as FuncCallExpr,
                    remainingExprs,
                    continuationVar,
                    contextToken
                  );

                  return {
                    ...branch,
                    args: [condition, transformedBody],
                  };
                }
              } else {
                // This branch doesn't contain do calls, just assign the value
                return {
                  ...branch,
                  args: [condition, assignmentContinuation(body)],
                };
              }
            } else {
              // Not a condition => body pair, shouldn't happen in a cond
              throw new Error(
                "Expected condition => body pairs in cond expression"
              );
            }
          });

          return {
            ...condExpr,
            args: transformedBranches,
          };
        } else if (
          exprIsFunctionCall(value) &&
          exprIsFunctionCallOf(value, BuiltinKeywords.match) &&
          this.containsDoCall(value)
        ) {
          // Special case: `variable := match(...)` where match contains do calls
          return this.transformMatchWithAssignmentToCps(
            value,
            variable,
            remainingExprs,
            continuationVar,
            contextToken
          );
        } else if (this.containsDoCall(value)) {
          // Complex case: `variable := expression_containing_do`
          // We need to extract the `do` call and create a continuation
          const doCallInfo = this.extractDoCall(value);
          if (!doCallInfo) {
            throw new Error("Expected to find a do call in the expression");
          }

          const { doExpr, expressionWithHole } = doCallInfo;
          const resultVar = `cps_result_${randomId()}`;

          // Replace the "hole" in the expression with the result variable
          const valueWithResult = this.replaceHoleWithVariable(
            expressionWithHole,
            resultVar,
            contextToken
          );

          // Create the assignment with the transformed value
          const assignment: FuncCallExpr = {
            tag: ExprTag.FuncCall,
            func: expr.func, // Use the same `:=` function
            args: [variable, valueWithResult],
            token: expr.token,
            isInfix: expr.isInfix,
          };

          // The key insight: when we have multiple do calls, we need to transform the assignment recursively
          // with the remaining expressions as context
          let continuationExpr: Expr;
          if (this.containsDoCall(valueWithResult)) {
            // The assignment still contains do calls, so we need to recursively transform it
            // with the remaining expressions as the continuation context
            continuationExpr = this.transformExpressionWithDoToCps(
              assignment,
              remainingExprs,
              continuationVar,
              contextToken
            );
          } else {
            // No more do calls in the assignment, create a simple continuation
            const allRemainingExprs = [assignment, ...remainingExprs];

            if (allRemainingExprs.length === 1) {
              continuationExpr = this.transformExpressionToCps(
                allRemainingExprs[0]!,
                continuationVar
              );
            } else {
              // Multiple expressions, wrap in begin and recursively transform
              const transformedRemainingExprs = allRemainingExprs.map((expr) =>
                this.transformExpressionToCps(expr, continuationVar)
              );
              continuationExpr = {
                tag: ExprTag.FuncCall,
                func: {
                  tag: ExprTag.Atom,
                  token: {
                    type: TokenType.Identifier,
                    value: BuiltinKeywords.begin[0]!,
                    position: contextToken.position,
                    modulePath: contextToken.modulePath,
                    inputString: contextToken.inputString,
                  },
                },
                args: transformedRemainingExprs,
                token: contextToken,
              };
            }
          }

          // Create the continuation closure
          const continuation: Expr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Operator,
                value: "=>",
                position: contextToken.position,
                modulePath: contextToken.modulePath,
                inputString: contextToken.inputString,
              },
            },
            args: [
              {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Identifier,
                  value: resultVar,
                  position: contextToken.position,
                  modulePath: contextToken.modulePath,
                  inputString: contextToken.inputString,
                },
              },
              continuationExpr,
            ],
            token: contextToken,
            isInfix: true,
          };

          // Transform the inner expression of the `do` call
          const innerExpr = doExpr.args[0]!;
          if (!exprIsFunctionCall(innerExpr)) {
            throw new Error(
              `do() argument must be a function call, got: ${innerExpr.tag}`
            );
          }

          // Return the transformed call with the continuation
          return {
            ...innerExpr,
            args: [...innerExpr.args, continuation],
          };
        }
      }

      // For other function calls, recursively transform arguments
      const transformedArgs = expr.args.map((arg) =>
        this.transformExpressionToCps(arg, continuationVar)
      );

      return {
        ...expr,
        args: transformedArgs,
      };
    }

    // For non-function call expressions, just return as-is
    return expr;
  }

  /**
   * Extract the first `do` call from an expression and return it along with the expression with a "hole"
   */
  private extractDoCall(
    expr: Expr
  ): { doExpr: FuncCallExpr; expressionWithHole: Expr } | null {
    if (exprIsFunctionCall(expr)) {
      if (exprIsFunctionCallOf(expr, "do")) {
        // This is the do call we're looking for
        // Return a special "hole" marker
        const hole: Expr = {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Identifier,
            value: "__CPS_HOLE__",
            position: expr.token.position,
            modulePath: expr.token.modulePath,
            inputString: expr.token.inputString,
          },
        };
        return { doExpr: expr, expressionWithHole: hole };
      } else {
        // Look for `do` calls in arguments
        for (let i = 0; i < expr.args.length; i++) {
          const arg = expr.args[i]!;
          const result = this.extractDoCall(arg);
          if (result) {
            // Found a `do` call in this argument, replace it with the hole
            const newArgs = [...expr.args];
            newArgs[i] = result.expressionWithHole;

            return {
              doExpr: result.doExpr,
              expressionWithHole: {
                ...expr,
                args: newArgs,
              },
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Replace the hole marker with a variable reference
   */
  private replaceHoleWithVariable(
    expr: Expr,
    variableName: string,
    contextToken: FuncCallExpr["token"]
  ): Expr {
    if (
      expr.tag === ExprTag.Atom &&
      "token" in expr &&
      expr.token.value === "__CPS_HOLE__"
    ) {
      return {
        tag: ExprTag.Atom,
        token: {
          type: TokenType.Identifier,
          value: variableName,
          position: contextToken.position,
          modulePath: contextToken.modulePath,
          inputString: contextToken.inputString,
        },
      };
    }

    if (exprIsFunctionCall(expr)) {
      const newArgs = expr.args.map((arg) =>
        this.replaceHoleWithVariable(arg, variableName, contextToken)
      );
      return {
        ...expr,
        args: newArgs,
      };
    }

    return expr;
  }

  /**
   * Transform a `cond` expression containing `do` calls to CPS
   * Handle conditions with `do` calls by lifting them out and creating nested cond structures
   */
  private transformCondToCps(
    condExpr: FuncCallExpr,
    continuationVar: string
  ): Expr {
    const branches = condExpr.args;

    // Separate branches based on whether their condition contains `do` calls
    const cleanBranches: Expr[] = [];
    const doConditionBranches: Expr[] = [];

    for (const branch of branches) {
      if (
        exprIsFunctionCall(branch) &&
        branch.isInfix &&
        exprIsFunctionCallOf(branch, "=>")
      ) {
        const condition = branch.args[0]!;

        if (this.containsDoCall(condition)) {
          doConditionBranches.push(branch);
        } else {
          cleanBranches.push(branch);
        }
      } else {
        // Not a condition => body pair, assume it's clean
        cleanBranches.push(branch);
      }
    }

    // If no conditions contain `do` calls, transform normally
    if (doConditionBranches.length === 0) {
      const transformedArgs = branches.map((arg) => {
        if (
          exprIsFunctionCall(arg) &&
          arg.isInfix &&
          exprIsFunctionCallOf(arg, "=>")
        ) {
          const condition = arg.args[0]!;
          const body = arg.args[1]!;
          const transformedBody = this.transformExpressionToCps(
            body,
            continuationVar
          );
          return {
            ...arg,
            args: [condition, transformedBody],
          };
        } else {
          return this.transformExpressionToCps(arg, continuationVar);
        }
      });

      return {
        ...condExpr,
        args: transformedArgs,
      };
    }

    // Handle the complex case: some conditions contain `do` calls
    // First, transform clean branches normally
    const transformedCleanBranches = cleanBranches.map((arg) => {
      if (
        exprIsFunctionCall(arg) &&
        arg.isInfix &&
        exprIsFunctionCallOf(arg, "=>")
      ) {
        const condition = arg.args[0]!;
        const body = arg.args[1]!;
        const transformedBody = this.transformExpressionToCps(
          body,
          continuationVar
        );
        return {
          ...arg,
          args: [condition, transformedBody],
        };
      } else {
        return this.transformExpressionToCps(arg, continuationVar);
      }
    });

    // Create a nested structure for branches with `do` in conditions
    const createNestedCondForDoBranches = (doBranches: Expr[]): Expr => {
      if (doBranches.length === 0) {
        // This shouldn't happen, but just in case
        throw new Error("No do branches to process");
      }

      const firstBranch = doBranches[0]!;
      const remainingBranches = doBranches.slice(1);

      if (
        exprIsFunctionCall(firstBranch) &&
        firstBranch.isInfix &&
        exprIsFunctionCallOf(firstBranch, "=>")
      ) {
        const condition = firstBranch.args[0]!;
        const body = firstBranch.args[1]!;

        // Extract the `do` call from the condition
        const doCallInfo = this.extractDoCall(condition);
        if (!doCallInfo) {
          throw new Error("Expected to find a do call in the condition");
        }

        const { doExpr, expressionWithHole } = doCallInfo;
        const resultVar = `cps_result_${randomId()}`;

        // Replace the hole with the result variable
        const conditionWithResult = this.replaceHoleWithVariable(
          expressionWithHole,
          resultVar,
          condExpr.token
        );

        // Create the branch with the transformed condition
        const transformedBranch: Expr = {
          ...firstBranch,
          args: [
            conditionWithResult,
            this.transformExpressionToCps(body, continuationVar),
          ],
        };

        // Create the nested cond for remaining branches
        let nestedCond: Expr;
        if (remainingBranches.length > 0) {
          nestedCond = createNestedCondForDoBranches(remainingBranches);
        } else {
          // No more branches, this shouldn't happen in a well-formed cond
          // but we'll create a simple continuation call
          nestedCond = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Identifier,
                value: continuationVar,
                position: condExpr.token.position,
                modulePath: condExpr.token.modulePath,
                inputString: condExpr.token.inputString,
              },
            },
            args: [
              {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Identifier,
                  value: "unit",
                  position: condExpr.token.position,
                  modulePath: condExpr.token.modulePath,
                  inputString: condExpr.token.inputString,
                },
              },
            ],
            token: condExpr.token,
          };
        }

        // Create the inner cond with the transformed branch and nested handling
        const innerCond: FuncCallExpr = {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinKeywords.cond[0]!,
              position: condExpr.token.position,
              modulePath: condExpr.token.modulePath,
              inputString: condExpr.token.inputString,
            },
          },
          args: [
            transformedBranch,
            {
              tag: ExprTag.FuncCall,
              func: {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Operator,
                  value: "=>",
                  position: condExpr.token.position,
                  modulePath: condExpr.token.modulePath,
                  inputString: condExpr.token.inputString,
                },
              },
              args: [
                {
                  tag: ExprTag.Atom,
                  token: {
                    type: TokenType.Boolean,
                    value: "true",
                    position: condExpr.token.position,
                    modulePath: condExpr.token.modulePath,
                    inputString: condExpr.token.inputString,
                  },
                },
                nestedCond,
              ],
              token: condExpr.token,
              isInfix: true,
            },
          ],
          token: condExpr.token,
        };

        // Create the continuation for the extracted `do` call
        const continuation: Expr = {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Operator,
              value: "=>",
              position: condExpr.token.position,
              modulePath: condExpr.token.modulePath,
              inputString: condExpr.token.inputString,
            },
          },
          args: [
            {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Identifier,
                value: resultVar,
                position: condExpr.token.position,
                modulePath: condExpr.token.modulePath,
                inputString: condExpr.token.inputString,
              },
            },
            innerCond,
          ],
          token: condExpr.token,
          isInfix: true,
        };

        // Extract the inner expression from the `do` call and add the continuation
        const innerExpr = doExpr.args[0]!;
        if (!exprIsFunctionCall(innerExpr)) {
          throw new Error(
            `do() argument must be a function call, got: ${innerExpr.tag}`
          );
        }

        return {
          ...innerExpr,
          args: [...innerExpr.args, continuation],
        };
      } else {
        throw new Error("Expected condition => body pair in cond");
      }
    };

    // Create the nested structure for do branches
    const nestedDoStructure =
      createNestedCondForDoBranches(doConditionBranches);

    // Combine clean branches with the nested do structure
    if (transformedCleanBranches.length > 0) {
      // Add a `true =>` branch that handles the do conditions
      const trueBranch: Expr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Operator,
            value: "=>",
            position: condExpr.token.position,
            modulePath: condExpr.token.modulePath,
            inputString: condExpr.token.inputString,
          },
        },
        args: [
          {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Boolean,
              value: "true",
              position: condExpr.token.position,
              modulePath: condExpr.token.modulePath,
              inputString: condExpr.token.inputString,
            },
          },
          nestedDoStructure,
        ],
        token: condExpr.token,
        isInfix: true,
      };

      return {
        ...condExpr,
        args: [...transformedCleanBranches, trueBranch],
      };
    } else {
      // Only do branches, return the nested structure directly
      return nestedDoStructure;
    }
  }

  private transformMatchToCps(
    expr: FuncCallExpr,
    continuationVar: string
  ): Expr {
    // For basic match expressions without assignment context
    // Transform all branches normally
    const [matchValue, ...branches] = expr.args;

    if (!matchValue) {
      throw new Error("match expression must have a value to match against");
    }

    // Transform the match value first if it contains do calls
    const transformedValue = this.transformExpressionToCps(
      matchValue,
      continuationVar
    );

    // Transform all branches
    const transformedBranches = branches.map((branch) => {
      if (
        exprIsFunctionCall(branch) &&
        branch.isInfix &&
        exprIsFunctionCallOf(branch, "=>")
      ) {
        const pattern = branch.args[0]!;
        const body = branch.args[1]!;
        const transformedBody = this.transformExpressionToCps(
          body,
          continuationVar
        );
        return {
          ...branch,
          args: [pattern, transformedBody],
        };
      } else {
        return this.transformExpressionToCps(branch, continuationVar);
      }
    });

    return {
      ...expr,
      args: [transformedValue, ...transformedBranches],
    };
  }

  /**
   * Transform a match expression in assignment context: variable := match(...)
   * This handles cases where match branches contain do calls and need to be transformed to CPS
   */
  private transformMatchWithAssignmentToCps(
    matchExpr: FuncCallExpr,
    assignmentVariable: Expr,
    remainingExprs: Expr[],
    continuationVar: string,
    contextToken: FuncCallExpr["token"]
  ): Expr {
    // match(value, pattern1 => body1, pattern2 => body2, ...)
    const [matchValue, ...branches] = matchExpr.args;

    if (!matchValue) {
      throw new Error("match expression must have a value to match against");
    }

    // Check if the match value contains do calls - handle this first
    if (this.containsDoCall(matchValue)) {
      // Extract the do call from the match value
      const doCallInfo = this.extractDoCall(matchValue);
      if (!doCallInfo) {
        throw new Error("Expected to find a do call in the match value");
      }

      const { doExpr, expressionWithHole } = doCallInfo;
      const resultVar = `cps_result_${randomId()}`;

      // Replace the hole with the result variable
      const valueWithResult = this.replaceHoleWithVariable(
        expressionWithHole,
        resultVar,
        contextToken
      );

      // Create a new match expression with the transformed value
      const newMatchExpr: FuncCallExpr = {
        ...matchExpr,
        args: [valueWithResult, ...branches],
      };

      // Create the continuation that processes the match and assigns the result
      const continuation: Expr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Operator,
            value: "=>",
            position: contextToken.position,
            modulePath: contextToken.modulePath,
            inputString: contextToken.inputString,
          },
        },
        args: [
          {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: resultVar,
              position: contextToken.position,
              modulePath: contextToken.modulePath,
              inputString: contextToken.inputString,
            },
          },
          // Recursively transform the new match expression
          // which may still have do calls in branches
          this.transformMatchWithAssignmentToCps(
            newMatchExpr,
            assignmentVariable,
            remainingExprs,
            continuationVar,
            contextToken
          ),
        ],
        token: contextToken,
        isInfix: true,
      };

      // Extract and transform the do call
      const innerExpr = doExpr.args[0]!;
      if (!exprIsFunctionCall(innerExpr)) {
        throw new Error(
          `do() argument must be a function call, got: ${innerExpr.tag}`
        );
      }

      return {
        ...innerExpr,
        args: [...innerExpr.args, continuation],
      };
    }

    // No do calls in match value, proceed with branch transformation

    // Create a continuation function that assigns the result and continues
    const createAssignmentContinuation = (matchResult: Expr) => {
      // Create the assignment
      const assignment: FuncCallExpr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Operator,
            value: ":=",
            position: contextToken.position,
            modulePath: contextToken.modulePath,
            inputString: contextToken.inputString,
          },
        },
        args: [assignmentVariable, matchResult],
        token: contextToken,
        isInfix: true,
      };

      // Combine assignment with remaining expressions
      const allRemainingExprs = [assignment, ...remainingExprs];

      if (allRemainingExprs.length === 1) {
        return this.transformExpressionToCps(
          allRemainingExprs[0]!,
          continuationVar
        );
      } else {
        const transformedRemainingExprs = allRemainingExprs.map((expr) =>
          this.transformExpressionToCps(expr, continuationVar)
        );

        // Always wrap in begin if we have multiple expressions
        return {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinKeywords.begin[0]!,
              position: contextToken.position,
              modulePath: contextToken.modulePath,
              inputString: contextToken.inputString,
            },
          },
          args: transformedRemainingExprs,
          token: contextToken,
        } as FuncCallExpr;
      }
    };

    // Transform each branch of the match
    const transformedBranches = branches.map((branch) => {
      if (
        exprIsFunctionCall(branch) &&
        branch.isInfix &&
        exprIsFunctionCallOf(branch, "=>")
      ) {
        const pattern = branch.args[0]!;
        const body = branch.args[1]!;
        const unwrappedBody = this.unwrapSingleBegin(body);

        if (this.containsDoCall(unwrappedBody)) {
          // This branch contains do calls, transform it with assignment context
          // We need to ensure that the transformation includes the assignment + remaining expressions
          const assignmentExpr: FuncCallExpr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Operator,
                value: ":=",
                position: contextToken.position,
                modulePath: contextToken.modulePath,
                inputString: contextToken.inputString,
              },
            },
            args: [assignmentVariable, unwrappedBody],
            token: contextToken,
            isInfix: true,
          };

          // Transform the assignment with remaining expressions as context
          const transformedBody = this.transformExpressionWithDoToCps(
            assignmentExpr,
            remainingExprs,
            continuationVar,
            contextToken
          );

          return {
            ...branch,
            args: [pattern, transformedBody],
          };
        } else {
          // This branch doesn't contain do calls, just assign the value and continue
          return {
            ...branch,
            args: [pattern, createAssignmentContinuation(unwrappedBody)],
          };
        }
      } else {
        // Not a pattern => body pair, shouldn't happen in a match
        throw new Error("Expected pattern => body pairs in match expression");
      }
    });

    return {
      ...matchExpr,
      args: [matchValue, ...transformedBranches],
    };
  }

  /**
   * Helper function to check if any condition in a cond expression contains a `do` call
   */
  private condHasDoInConditions(condExpr: FuncCallExpr): boolean {
    return condExpr.args.some((branch) => {
      if (
        exprIsFunctionCall(branch) &&
        branch.isInfix &&
        exprIsFunctionCallOf(branch, "=>")
      ) {
        const condition = branch.args[0]!;
        return this.containsDoCall(condition);
      }
      return false;
    });
  }

  /**
   * Transform a `cond` expression with `do` calls in conditions, handling assignment context
   */
  private transformCondWithAssignmentToCps(
    condExpr: FuncCallExpr,
    assignmentVariable: Expr,
    remainingExprs: Expr[],
    continuationVar: string,
    contextToken: FuncCallExpr["token"]
  ): Expr {
    const branches = condExpr.args;

    // Create a continuation function that assigns the result and continues
    const createAssignmentContinuation = (condResult: Expr) => {
      // Create the assignment
      const assignment: FuncCallExpr = {
        tag: ExprTag.FuncCall,
        func: {
          tag: ExprTag.Atom,
          token: {
            type: TokenType.Operator,
            value: ":=",
            position: contextToken.position,
            modulePath: contextToken.modulePath,
            inputString: contextToken.inputString,
          },
        },
        args: [assignmentVariable, condResult],
        token: contextToken,
        isInfix: true,
      };

      // Combine assignment with remaining expressions
      const allRemainingExprs = [assignment, ...remainingExprs];

      if (allRemainingExprs.length === 1) {
        const expr = allRemainingExprs[0]!;
        if (this.containsDoCall(expr)) {
          return this.transformExpressionWithDoToCps(
            expr,
            [],
            continuationVar,
            contextToken
          );
        } else {
          return this.transformExpressionToCps(expr, continuationVar);
        }
      } else {
        // Multiple expressions, create a begin block and transform it properly
        const beginExpr: FuncCallExpr = {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinKeywords.begin[0]!,
              position: contextToken.position,
              modulePath: contextToken.modulePath,
              inputString: contextToken.inputString,
            },
          },
          args: allRemainingExprs,
          token: contextToken,
        };

        // Transform the begin block, which will handle expressions with do calls properly
        return this.transformExpressionToCps(beginExpr, continuationVar);
      }
    };

    // Check if any conditions contain do calls - if so, we need to extract them first
    for (const branch of branches) {
      if (
        exprIsFunctionCall(branch) &&
        branch.isInfix &&
        exprIsFunctionCallOf(branch, "=>")
      ) {
        const condition = branch.args[0]!;
        if (this.containsDoCall(condition)) {
          // Found a condition with do calls - extract the first one
          const doCallInfo = this.extractDoCall(condition);
          if (!doCallInfo) {
            throw new Error("Expected to find a do call in the condition");
          }

          const { doExpr, expressionWithHole } = doCallInfo;
          const resultVar = `cps_result_${randomId()}`;

          // Replace the hole with the result variable
          const conditionWithResult = this.replaceHoleWithVariable(
            expressionWithHole,
            resultVar,
            contextToken
          );

          // Create a new branch with the transformed condition
          const transformedBranch: Expr = {
            ...branch,
            args: [conditionWithResult, branch.args[1]!],
          };

          // Create a new cond with this transformed branch and all other branches
          const newCondExpr: FuncCallExpr = {
            ...condExpr,
            args: branches.map((b) => (b === branch ? transformedBranch : b)),
          };

          // Create the continuation that processes the new cond
          const continuation: Expr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Operator,
                value: "=>",
                position: contextToken.position,
                modulePath: contextToken.modulePath,
                inputString: contextToken.inputString,
              },
            },
            args: [
              {
                tag: ExprTag.Atom,
                token: {
                  type: TokenType.Identifier,
                  value: resultVar,
                  position: contextToken.position,
                  modulePath: contextToken.modulePath,
                  inputString: contextToken.inputString,
                },
              },
              // Recursively transform the new cond (in case there are more do calls in conditions)
              this.transformCondWithAssignmentToCps(
                newCondExpr,
                assignmentVariable,
                remainingExprs,
                continuationVar,
                contextToken
              ),
            ],
            token: contextToken,
            isInfix: true,
          };

          // Extract and transform the do call
          const innerExpr = doExpr.args[0]!;
          if (!exprIsFunctionCall(innerExpr)) {
            throw new Error(
              `do() argument must be a function call, got: ${innerExpr.tag}`
            );
          }

          return {
            ...innerExpr,
            args: [...innerExpr.args, continuation],
          };
        }
      }
    }

    // No do calls in conditions, transform branches normally
    const transformedBranches = branches.map((branch) => {
      if (
        exprIsFunctionCall(branch) &&
        branch.isInfix &&
        exprIsFunctionCallOf(branch, "=>")
      ) {
        const condition = branch.args[0]!;
        const body = branch.args[1]!;

        if (this.containsDoCall(body)) {
          // This branch body contains do calls, transform it with the assignment continuation
          const transformedBody = createAssignmentContinuation(body);
          return {
            ...branch,
            args: [condition, transformedBody],
          };
        } else {
          // This branch doesn't contain do calls, just assign the value
          return {
            ...branch,
            args: [condition, createAssignmentContinuation(body)],
          };
        }
      } else {
        // Not a condition => body pair, shouldn't happen in a cond
        throw new Error("Expected condition => body pairs in cond expression");
      }
    });

    return {
      ...condExpr,
      args: transformedBranches,
    };
  }

  /**
   * Helper function to unwrap single-expression begin blocks
   */
  private unwrapSingleBegin(expr: Expr): Expr {
    if (
      exprIsFunctionCall(expr) &&
      exprIsFunctionCallOf(expr, BuiltinKeywords.begin) &&
      expr.args.length === 1
    ) {
      return expr.args[0]!;
    }
    return expr;
  }
}

/**
 * Transform a function body expression to continuation-passing style
 */
export function transformFunctionBodyToCps(
  bodyExpr: Expr,
  usedDoExpressions: Expr[],
  functionName?: string
): Expr {
  console.log(
    `\n=== CPS Transformation for function: ${functionName || "anonymous"} ===`
  );

  console.log("Original body:");
  console.log(exprToString(bodyExpr, { prettyPrint: true }));

  const transformer = new CpsTransformer(usedDoExpressions);
  const transformedBody = transformer.transformExpressionToCps(
    bodyExpr,
    "resume"
  );

  console.log("\nTransformed body:");
  console.log(exprToString(transformedBody, { prettyPrint: true }));

  return transformedBody;
}
