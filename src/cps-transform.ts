import {
  Expr,
  ExprTag,
  FuncCallExpr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "./expr";
import { TokenType } from "./token";

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
  console.log("Transformed body:", exprToString(transformedBody));

  return transformedBody;
}

/**
 * Transform an expression containing `do` calls to CPS
 */
function transformExpressionToCps(expr: Expr, continuationVar: string): Expr {
  switch (expr.tag) {
    case ExprTag.FuncCall:
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
  const resultVar = "cps_result";

  // Create continuation closure: (result) => resume(result)
  const continuationCall: FuncCallExpr = {
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
      continuationCall,
    ],
    token: doExpr.token,
  };

  // Transform: do(f(args)) -> f(args, continuation)
  const transformedCall: FuncCallExpr = {
    ...innerExpr,
    args: [...innerExpr.args, continuation],
  };

  return transformedCall;
}
