import {
  BuiltinKeywords,
  Expr,
  ExprTag,
  FuncCallExpr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "./expr";
import { TokenType } from "./token";
import { randomId } from "./utils";

/**
 * Transform a function body expression to continuation-passing style
 */
export function transformFunctionBodyToCps(
  bodyExpr: Expr,
  functionName?: string
): Expr {
  console.log(
    `\n=== CPS Transformation for function: ${functionName || "anonymous"} ===`
  );

  console.log("Original body:");
  console.log(exprToString(bodyExpr, { prettyPrint: true }));

  const transformedBody = transformExpressionToCps(bodyExpr, "resume");
  console.log("\nTransformed body:");
  console.log(exprToString(transformedBody, { prettyPrint: true }));

  return transformedBody;
}

/**
 * Transform a `do` call to CPS with a specific continuation that includes remaining expressions
 */
function transformDoCallToCpsWithContinuation(
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
    // Single remaining expression, no need to wrap in begin
    continuationBody = transformExpressionToCps(
      remainingExprs[0]!,
      continuationVar
    );
  } else {
    // Multiple remaining expressions, wrap in a `begin` block
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
      args: remainingExprs.map((expr) =>
        transformExpressionToCps(expr, continuationVar)
      ),
      token: contextToken,
    };
    continuationBody = beginExpr;
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
function transformExpressionWithDoToCps(
  expr: Expr,
  remainingExprs: Expr[],
  continuationVar: string,
  contextToken: FuncCallExpr["token"]
): Expr {
  if (exprIsFunctionCall(expr)) {
    if (exprIsFunctionCallOf(expr, "do")) {
      // This is a direct `do` call
      return transformDoCallToCpsWithContinuation(
        expr,
        remainingExprs,
        continuationVar,
        contextToken
      );
    } else {
      // This is a function call that might contain a `do` call in its arguments
      // Handle assignment: `variable := expression_containing_do`
      if (exprIsFunctionCallOf(expr, ":=") && expr.args.length === 2) {
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
            continuationBody = transformExpressionToCps(
              allRemainingExprs[0]!,
              continuationVar
            );
          } else {
            // Multiple expressions, wrap in begin and recursively transform
            const transformedRemainingExprs = allRemainingExprs.map((expr) =>
              transformExpressionToCps(expr, continuationVar)
            );
            continuationBody = {
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
          containsDoCall(value)
        ) {
          // Special case: `variable := cond(...)` where cond contains do calls

          // Check if any conditions contain `do` calls
          if (condHasDoInConditions(value)) {
            // Conditions contain `do` calls - we need special handling
            // We need to transform the cond with assignment context
            return transformCondWithAssignmentToCps(
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
              return transformExpressionToCps(
                allRemainingExprs[0]!,
                continuationVar
              );
            } else {
              const transformedRemainingExprs = allRemainingExprs.map((expr) =>
                transformExpressionToCps(expr, continuationVar)
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

              if (containsDoCall(body)) {
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
                  const transformedBody = transformExpressionWithDoToCps(
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
          containsDoCall(value)
        ) {
          // Special case: `variable := match(...)` where match contains do calls
          return transformMatchWithAssignmentToCps(
            value,
            variable,
            remainingExprs,
            continuationVar,
            contextToken
          );
        } else if (containsDoCall(value)) {
          // Complex case: `variable := expression_containing_do`
          // We need to extract the `do` call and create a continuation
          const doCallInfo = extractDoCall(value);
          if (!doCallInfo) {
            throw new Error("Expected to find a do call in the expression");
          }

          const { doExpr, expressionWithHole } = doCallInfo;
          const resultVar = `cps_result_${randomId()}`;

          // Replace the "hole" in the expression with the result variable
          const valueWithResult = replaceHoleWithVariable(
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
          if (containsDoCall(valueWithResult)) {
            // The assignment still contains do calls, so we need to recursively transform it
            // with the remaining expressions as the continuation context
            continuationExpr = transformExpressionWithDoToCps(
              assignment,
              remainingExprs,
              continuationVar,
              contextToken
            );
          } else {
            // No more do calls in the assignment, create a simple continuation
            const allRemainingExprs = [assignment, ...remainingExprs];

            if (allRemainingExprs.length === 1) {
              continuationExpr = transformExpressionToCps(
                allRemainingExprs[0]!,
                continuationVar
              );
            } else {
              // Multiple expressions, wrap in begin and recursively transform
              const transformedRemainingExprs = allRemainingExprs.map((expr) =>
                transformExpressionToCps(expr, continuationVar)
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
        transformExpressionToCps(arg, continuationVar)
      );

      return {
        ...expr,
        args: transformedArgs,
      };
    }
  }

  // For non-function call expressions, just return as-is
  return expr;
}

/**
 * Extract the first `do` call from an expression and return it along with the expression with a "hole"
 */
function extractDoCall(
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
        const result = extractDoCall(arg);
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
function replaceHoleWithVariable(
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
      replaceHoleWithVariable(arg, variableName, contextToken)
    );
    return {
      ...expr,
      args: newArgs,
    };
  }

  return expr;
}

/**
 * Helper function to check if any condition in a cond expression contains a `do` call
 */
function condHasDoInConditions(condExpr: FuncCallExpr): boolean {
  return condExpr.args.some((branch) => {
    if (
      exprIsFunctionCall(branch) &&
      branch.isInfix &&
      exprIsFunctionCallOf(branch, "=>")
    ) {
      const condition = branch.args[0]!;
      return containsDoCall(condition);
    }
    return false;
  });
}

/**
 * Helper function to check if an expression contains a `do` call (recursively)
 */
function containsDoCall(expr: Expr): boolean {
  if (exprIsFunctionCall(expr)) {
    if (exprIsFunctionCallOf(expr, "do")) {
      return true;
    }
    // Check all arguments recursively
    return expr.args.some((arg) => containsDoCall(arg));
  }
  return false;
}

/**
 * Transform a `cond` expression with `do` calls in conditions, handling assignment context
 */
function transformCondWithAssignmentToCps(
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
      return transformExpressionToCps(allRemainingExprs[0]!, continuationVar);
    } else {
      const transformedRemainingExprs = allRemainingExprs.map((expr) =>
        transformExpressionToCps(expr, continuationVar)
      );

      // Don't wrap single expression in begin
      if (transformedRemainingExprs.length === 1) {
        return transformedRemainingExprs[0]!;
      }

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

  // Transform branches recursively, preserving evaluation order
  const transformBranches = (branchesToTransform: Expr[]): Expr => {
    if (branchesToTransform.length === 0) {
      // This shouldn't happen in a well-formed cond
      throw new Error("No branches to transform");
    }

    const firstBranch = branchesToTransform[0]!;
    const remainingBranches = branchesToTransform.slice(1);

    if (
      exprIsFunctionCall(firstBranch) &&
      firstBranch.isInfix &&
      exprIsFunctionCallOf(firstBranch, "=>")
    ) {
      const condition = firstBranch.args[0]!;
      const body = firstBranch.args[1]!;

      if (containsDoCall(condition)) {
        // This condition contains a `do` call - extract it and create a nested structure
        const doCallInfo = extractDoCall(condition);
        if (!doCallInfo) {
          throw new Error("Expected to find a do call in the condition");
        }

        const { doExpr, expressionWithHole } = doCallInfo;
        const resultVar = `cps_result_${randomId()}`;

        // Replace the hole with the result variable
        const conditionWithResult = replaceHoleWithVariable(
          expressionWithHole,
          resultVar,
          contextToken
        );

        // Create the updated branch with the transformed condition
        const updatedBranch: Expr = {
          ...firstBranch,
          args: [conditionWithResult, body],
        };

        // Create the inner cond with this branch and remaining branches
        const innerCondArgs = [updatedBranch];
        if (remainingBranches.length > 0) {
          innerCondArgs.push({
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
                  value: "true",
                  position: contextToken.position,
                  modulePath: contextToken.modulePath,
                  inputString: contextToken.inputString,
                },
              },
              transformBranches(remainingBranches),
            ],
            token: contextToken,
            isInfix: true,
          });
        }

        const innerCond: FuncCallExpr = {
          tag: ExprTag.FuncCall,
          func: {
            tag: ExprTag.Atom,
            token: {
              type: TokenType.Identifier,
              value: BuiltinKeywords.cond[0]!,
              position: contextToken.position,
              modulePath: contextToken.modulePath,
              inputString: contextToken.inputString,
            },
          },
          args: innerCondArgs,
          token: contextToken,
        };

        // Transform the inner cond to handle assignments in bodies
        const transformedInnerCond = transformCondExpressionForAssignment(
          innerCond,
          assignmentVariable,
          remainingExprs,
          continuationVar,
          contextToken
        );

        // Create the continuation for the extracted `do` call
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
            transformedInnerCond,
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
      } else {
        // This condition doesn't contain a `do` call - check if subsequent conditions do
        if (
          remainingBranches.some(
            (branch) =>
              exprIsFunctionCall(branch) &&
              branch.isInfix &&
              exprIsFunctionCallOf(branch, "=>") &&
              containsDoCall(branch.args[0]!)
          )
        ) {
          // Some later condition has a `do` call, so we need to create a nested structure
          const transformedRemainingBranches =
            transformBranches(remainingBranches);

          const unwrappedBody = unwrapSingleBegin(body);
          let transformedBody: Expr;

          if (containsDoCall(unwrappedBody)) {
            // Body contains do call, transform it with assignment context
            transformedBody = transformExpressionWithDoToCps(
              {
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
              } as FuncCallExpr,
              remainingExprs,
              continuationVar,
              contextToken
            );
          } else {
            // No do calls in body, just create assignment continuation
            transformedBody = createAssignmentContinuation(unwrappedBody);
          }

          // Create a cond with this clean branch and a fallback to the transformed remaining branches
          const condWithFallback: FuncCallExpr = {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Identifier,
                value: BuiltinKeywords.cond[0]!,
                position: contextToken.position,
                modulePath: contextToken.modulePath,
                inputString: contextToken.inputString,
              },
            },
            args: [
              {
                ...firstBranch,
                args: [condition, transformedBody],
              },
              {
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
                      value: "true",
                      position: contextToken.position,
                      modulePath: contextToken.modulePath,
                      inputString: contextToken.inputString,
                    },
                  },
                  transformedRemainingBranches,
                ],
                token: contextToken,
                isInfix: true,
              },
            ],
            token: contextToken,
          };

          return condWithFallback;
        } else {
          // No remaining conditions have `do` calls, so we can process all remaining branches normally
          const allBranches = [firstBranch, ...remainingBranches];

          // Special case: if we only have one branch and it's `true => body`,
          // we can simplify by just transforming the body directly
          if (allBranches.length === 1) {
            const singleBranch = allBranches[0]!;
            if (
              exprIsFunctionCall(singleBranch) &&
              singleBranch.isInfix &&
              exprIsFunctionCallOf(singleBranch, "=>") &&
              singleBranch.args[0]!.tag === ExprTag.Atom &&
              "token" in singleBranch.args[0]! &&
              singleBranch.args[0]!.token.value === "true"
            ) {
              // This is `true => body`, just transform the body directly with assignment
              const body = singleBranch.args[1]!;
              const unwrappedBody = unwrapSingleBegin(body);

              if (containsDoCall(unwrappedBody)) {
                // Transform the body with assignment context
                return transformExpressionWithDoToCps(
                  {
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
                  } as FuncCallExpr,
                  remainingExprs,
                  continuationVar,
                  contextToken
                );
              } else {
                // No do calls in body, just create assignment continuation
                return createAssignmentContinuation(unwrappedBody);
              }
            }
          }

          const transformedBranches = allBranches.map((branch) => {
            if (
              exprIsFunctionCall(branch) &&
              branch.isInfix &&
              exprIsFunctionCallOf(branch, "=>")
            ) {
              const branchCondition = branch.args[0]!;
              const branchBody = branch.args[1]!;

              const unwrappedBody = unwrapSingleBegin(branchBody);

              if (containsDoCall(unwrappedBody)) {
                // Transform the body with assignment context
                const transformedBody = transformExpressionWithDoToCps(
                  {
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
                  } as FuncCallExpr,
                  remainingExprs,
                  continuationVar,
                  contextToken
                );

                return {
                  ...branch,
                  args: [branchCondition, transformedBody],
                };
              } else {
                // No do calls in body, just create assignment continuation
                return {
                  ...branch,
                  args: [
                    branchCondition,
                    createAssignmentContinuation(unwrappedBody),
                  ],
                };
              }
            } else {
              // Not a condition => body pair, shouldn't happen
              throw new Error(
                "Expected condition => body pairs in cond expression"
              );
            }
          });

          return {
            tag: ExprTag.FuncCall,
            func: {
              tag: ExprTag.Atom,
              token: {
                type: TokenType.Identifier,
                value: BuiltinKeywords.cond[0]!,
                position: contextToken.position,
                modulePath: contextToken.modulePath,
                inputString: contextToken.inputString,
              },
            },
            args: transformedBranches,
            token: contextToken,
          } as FuncCallExpr;
        }
      }
    } else {
      throw new Error("Expected condition => body pair in cond");
    }
  };

  return transformBranches(branches);
}

/**
 * Transform a match expression in assignment context: variable := match(...)
 * This handles cases where match branches contain do calls and need to be transformed to CPS
 */
function transformMatchWithAssignmentToCps(
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
  if (containsDoCall(matchValue)) {
    // Extract the do call from the match value
    const doCallInfo = extractDoCall(matchValue);
    if (!doCallInfo) {
      throw new Error("Expected to find a do call in the match value");
    }

    const { doExpr, expressionWithHole } = doCallInfo;
    const resultVar = `cps_result_${randomId()}`;

    // Replace the hole with the result variable
    const valueWithResult = replaceHoleWithVariable(
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
        transformMatchWithAssignmentToCps(
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
      return transformExpressionToCps(allRemainingExprs[0]!, continuationVar);
    } else {
      const transformedRemainingExprs = allRemainingExprs.map((expr) =>
        transformExpressionToCps(expr, continuationVar)
      );

      // Don't wrap single expression in begin
      if (transformedRemainingExprs.length === 1) {
        return transformedRemainingExprs[0]!;
      }

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
      const unwrappedBody = unwrapSingleBegin(body);

      if (containsDoCall(unwrappedBody)) {
        // This branch contains do calls, transform it with assignment context
        const transformedBody = transformExpressionWithDoToCps(
          {
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
          } as FuncCallExpr,
          remainingExprs,
          continuationVar,
          contextToken
        );

        return {
          ...branch,
          args: [pattern, transformedBody],
        };
      } else {
        // This branch doesn't contain do calls, just assign the value
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
 * Helper function to unwrap single-expression begin blocks
 */
function unwrapSingleBegin(expr: Expr): Expr {
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin) &&
    expr.args.length === 1
  ) {
    return expr.args[0]!;
  }
  return expr;
}

/**
 * Transform a cond expression for assignment context (helper for recursive calls)
 */
function transformCondExpressionForAssignment(
  condExpr: FuncCallExpr,
  assignmentVariable: Expr,
  remainingExprs: Expr[],
  continuationVar: string,
  contextToken: FuncCallExpr["token"]
): Expr {
  // This is similar to the main transform but focuses on handling the bodies
  const branches = condExpr.args;

  const transformedBranches = branches.map((branch) => {
    if (
      exprIsFunctionCall(branch) &&
      branch.isInfix &&
      exprIsFunctionCallOf(branch, "=>")
    ) {
      const condition = branch.args[0]!;
      const body = branch.args[1]!;

      const unwrappedBody = unwrapSingleBegin(body);

      if (containsDoCall(unwrappedBody)) {
        // Special case: if this is a `true =>` branch with a single do call,
        // optimize it directly instead of creating nested assignments
        if (
          condition.tag === ExprTag.Atom &&
          "token" in condition &&
          condition.token.value === "true" &&
          exprIsFunctionCall(unwrappedBody) &&
          exprIsFunctionCallOf(unwrappedBody, "do")
        ) {
          // This is `true => do(...)`, transform it directly with assignment in continuation
          const doExpr = unwrappedBody;
          const resultVar = `cps_result_${randomId()}`;

          // Create continuation that assigns the result and continues
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
            args: [
              assignmentVariable,
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
            isInfix: true,
          };

          const allRemainingExprs = [assignment, ...remainingExprs];

          let continuationBody: Expr;
          if (allRemainingExprs.length === 1) {
            continuationBody = transformExpressionToCps(
              allRemainingExprs[0]!,
              continuationVar
            );
          } else {
            const transformedRemainingExprs = allRemainingExprs.map((expr) =>
              transformExpressionToCps(expr, continuationVar)
            );

            if (transformedRemainingExprs.length === 1) {
              continuationBody = transformedRemainingExprs[0]!;
            } else {
              continuationBody = {
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

          // Transform the do call
          const innerExpr = doExpr.args[0]!;
          if (!exprIsFunctionCall(innerExpr)) {
            throw new Error(
              `do() argument must be a function call, got: ${innerExpr.tag}`
            );
          }

          const transformedBody: FuncCallExpr = {
            ...innerExpr,
            args: [...innerExpr.args, continuation],
          };

          return {
            ...branch,
            args: [condition, transformedBody],
          };
        }

        // Special case: if this is a `true =>` branch with an already-transformed yield call,
        // we need to modify the continuation to include the assignment
        if (
          condition.tag === ExprTag.Atom &&
          "token" in condition &&
          condition.token.value === "true" &&
          exprIsFunctionCall(unwrappedBody) &&
          unwrappedBody.args.length >= 2 &&
          exprIsFunctionCall(
            unwrappedBody.args[unwrappedBody.args.length - 1]!
          ) &&
          exprIsFunctionCallOf(
            unwrappedBody.args[unwrappedBody.args.length - 1]! as FuncCallExpr,
            "=>"
          )
        ) {
          // This is a yield call with a continuation - we need to modify the continuation
          const yieldCall = unwrappedBody;
          const existingContinuation = yieldCall.args[
            yieldCall.args.length - 1
          ]! as FuncCallExpr;
          const continuationParam = existingContinuation.args[0]!;

          // Create the assignment with the continuation parameter
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
            args: [assignmentVariable, continuationParam],
            token: contextToken,
            isInfix: true,
          };

          // Combine assignment with remaining expressions
          const allRemainingExprs = [assignment, ...remainingExprs];

          let newContinuationBody: Expr;
          if (allRemainingExprs.length === 1) {
            newContinuationBody = transformExpressionToCps(
              allRemainingExprs[0]!,
              continuationVar
            );
          } else {
            const transformedRemainingExprs = allRemainingExprs.map((expr) =>
              transformExpressionToCps(expr, continuationVar)
            );

            if (transformedRemainingExprs.length === 1) {
              newContinuationBody = transformedRemainingExprs[0]!;
            } else {
              newContinuationBody = {
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
          }

          // Create the new continuation
          const newContinuation: Expr = {
            ...existingContinuation,
            args: [continuationParam, newContinuationBody],
          };

          // Create the new yield call with the modified continuation
          const newYieldCall: FuncCallExpr = {
            ...yieldCall,
            args: [...yieldCall.args.slice(0, -1), newContinuation],
          };

          return {
            ...branch,
            args: [condition, newYieldCall],
          };
        }

        // Transform the body with assignment context
        const transformedBody = transformExpressionWithDoToCps(
          {
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
          } as FuncCallExpr,
          remainingExprs,
          continuationVar,
          contextToken
        );

        return {
          ...branch,
          args: [condition, transformedBody],
        };
      } else {
        // No do calls in body, but check if it's already a transformed yield call
        if (
          exprIsFunctionCall(unwrappedBody) &&
          unwrappedBody.args.length >= 2 &&
          exprIsFunctionCall(
            unwrappedBody.args[unwrappedBody.args.length - 1]!
          ) &&
          exprIsFunctionCallOf(
            unwrappedBody.args[unwrappedBody.args.length - 1]! as FuncCallExpr,
            "=>"
          )
        ) {
          // This is already a yield call with continuation - modify the continuation to include assignment
          const yieldCall = unwrappedBody;
          const existingContinuation = yieldCall.args[
            yieldCall.args.length - 1
          ]! as FuncCallExpr;
          const continuationParam = existingContinuation.args[0]!;

          // Create the assignment with the continuation parameter
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
            args: [assignmentVariable, continuationParam],
            token: contextToken,
            isInfix: true,
          };

          // Combine assignment with remaining expressions
          const allRemainingExprs = [assignment, ...remainingExprs];

          let newContinuationBody: Expr;
          if (allRemainingExprs.length === 1) {
            newContinuationBody = transformExpressionToCps(
              allRemainingExprs[0]!,
              continuationVar
            );
          } else {
            const transformedRemainingExprs = allRemainingExprs.map((expr) =>
              transformExpressionToCps(expr, continuationVar)
            );

            if (transformedRemainingExprs.length === 1) {
              newContinuationBody = transformedRemainingExprs[0]!;
            } else {
              newContinuationBody = {
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
          }

          // Create the new continuation
          const newContinuation: Expr = {
            ...existingContinuation,
            args: [continuationParam, newContinuationBody],
          };

          // Create the new yield call with the modified continuation
          const newYieldCall: FuncCallExpr = {
            ...yieldCall,
            args: [...yieldCall.args.slice(0, -1), newContinuation],
          };

          return {
            ...branch,
            args: [condition, newYieldCall],
          };
        }

        // No do calls in body, create assignment continuation
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
          args: [assignmentVariable, unwrappedBody],
          token: contextToken,
          isInfix: true,
        };

        const allRemainingExprs = [assignment, ...remainingExprs];

        let continuationBody: Expr;
        if (allRemainingExprs.length === 1) {
          continuationBody = transformExpressionToCps(
            allRemainingExprs[0]!,
            continuationVar
          );
        } else {
          const transformedRemainingExprs = allRemainingExprs.map((expr) =>
            transformExpressionToCps(expr, continuationVar)
          );

          if (transformedRemainingExprs.length === 1) {
            continuationBody = transformedRemainingExprs[0]!;
          } else {
            continuationBody = {
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
        }

        return {
          ...branch,
          args: [condition, continuationBody],
        };
      }
    } else {
      throw new Error("Expected condition => body pairs in cond expression");
    }
  });

  return {
    ...condExpr,
    args: transformedBranches,
  };
}

/**
 * Transform a `begin` expression containing `do` calls to CPS
 */
function transformBeginToCps(
  beginExpr: FuncCallExpr,
  continuationVar: string
): Expr {
  const expressions = beginExpr.args;

  // Find the first expression that contains a `do` call
  for (let i = 0; i < expressions.length; i++) {
    const expr = expressions[i]!;

    if (containsDoCall(expr)) {
      // Found an expression with a `do` call - split the begin expression
      const beforeDo = expressions.slice(0, i);
      const exprWithDo = expr;
      const afterDo = expressions.slice(i + 1);

      // Transform the expression containing the `do` call
      const transformedExpr = transformExpressionWithDoToCps(
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
    transformExpressionToCps(arg, continuationVar)
  );

  return {
    ...beginExpr,
    args: transformedArgs,
  };
}

/**
 * Transform an expression containing `do` calls to CPS
 */
function transformExpressionToCps(expr: Expr, continuationVar: string): Expr {
  switch (expr.tag) {
    case ExprTag.FuncCall:
      if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
        return transformBeginToCps(expr, continuationVar);
      } else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
        return transformCondToCps(expr, continuationVar);
      }
      return transformFuncCallToCps(expr, continuationVar);

    case ExprTag.Atom:
      // Simple atoms don't need transformation
      return expr;

    default:
      // For now, just return the expression as-is
      console.log(
        `Warning: CPS transformation not implemented for expression type`
      );
      return expr;
  }
}

/**
 * Transform a `cond` expression containing `do` calls to CPS
 * Handle conditions with `do` calls by lifting them out and creating nested cond structures
 */
function transformCondToCps(
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

      if (containsDoCall(condition)) {
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
        const transformedBody = transformExpressionToCps(body, continuationVar);
        return {
          ...arg,
          args: [condition, transformedBody],
        };
      } else {
        return transformExpressionToCps(arg, continuationVar);
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
      const transformedBody = transformExpressionToCps(body, continuationVar);
      return {
        ...arg,
        args: [condition, transformedBody],
      };
    } else {
      return transformExpressionToCps(arg, continuationVar);
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
      const doCallInfo = extractDoCall(condition);
      if (!doCallInfo) {
        throw new Error("Expected to find a do call in the condition");
      }

      const { doExpr, expressionWithHole } = doCallInfo;
      const resultVar = `cps_result_${randomId()}`;

      // Replace the hole with the result variable
      const conditionWithResult = replaceHoleWithVariable(
        expressionWithHole,
        resultVar,
        condExpr.token
      );

      // Create the branch with the transformed condition
      const transformedBranch: Expr = {
        ...firstBranch,
        args: [
          conditionWithResult,
          transformExpressionToCps(body, continuationVar),
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
                  type: TokenType.Identifier,
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
  const nestedDoStructure = createNestedCondForDoBranches(doConditionBranches);

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
            type: TokenType.Identifier,
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

/**
 * Transform a function call expression to CPS
 */
function transformFuncCallToCps(
  expr: FuncCallExpr,
  continuationVar: string
): Expr {
  // Check if this is a `do` call
  if (exprIsFunctionCallOf(expr, "do")) {
    return transformDoCallToCps(expr, continuationVar);
  }

  // Check if this is a `cond` call - needs special handling
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return transformCondToCps(expr, continuationVar);
  }

  // For now, recursively transform arguments
  // More sophisticated nested `do` handling can be added later
  const transformedArgs = expr.args.map((arg) =>
    transformExpressionToCps(arg, continuationVar)
  );

  return {
    ...expr,
    args: transformedArgs,
  };
}

/**
 * Transform a `do` call to CPS
 * Example: `do(yield(0))` becomes `yield(0, (result) => continuation)`
 */
function transformDoCallToCps(
  doExpr: FuncCallExpr,
  continuationVar: string
): Expr {
  // Use the new function with no remaining expressions
  return transformDoCallToCpsWithContinuation(
    doExpr,
    [],
    continuationVar,
    doExpr.token
  );
}
