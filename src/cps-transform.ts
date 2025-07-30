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

  console.log("Original body:", exprToString(bodyExpr));

  const transformedBody = transformExpressionToCps(bodyExpr, "resume");
  console.log("\nTransformed body:", exprToString(transformedBody));

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
            continuationBody = transformExpressionToCps(allRemainingExprs[0]!, continuationVar);
          } else {
            // Multiple expressions, wrap in begin and recursively transform
            const transformedRemainingExprs = allRemainingExprs.map(expr => 
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
          const valueWithResult = replaceHoleWithVariable(expressionWithHole, resultVar, contextToken);

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
              continuationExpr = transformExpressionToCps(allRemainingExprs[0]!, continuationVar);
            } else {
              // Multiple expressions, wrap in begin and recursively transform
              const transformedRemainingExprs = allRemainingExprs.map(expr => 
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
function extractDoCall(expr: Expr): { doExpr: FuncCallExpr; expressionWithHole: Expr } | null {
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
function replaceHoleWithVariable(expr: Expr, variableName: string, contextToken: FuncCallExpr['token']): Expr {
  if (expr.tag === ExprTag.Atom && 'token' in expr && expr.token.value === "__CPS_HOLE__") {
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
    const newArgs = expr.args.map(arg => replaceHoleWithVariable(arg, variableName, contextToken));
    return {
      ...expr,
      args: newArgs,
    };
  }
  
  return expr;
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
