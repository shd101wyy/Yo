import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { EvaluatorContext } from "../context";
import { evaluateEnumType } from "./enum";
import { evaluateStructType } from "./struct";

/**
 * Evaluate reference semantics types:
 *
 * - ref(struct(...)) - Reference semantics struct
 * - ref(enum(...)) - Reference semantics enum
 */
export function evaluateRefType({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected exactly one argument for "ref", got ${expr.args.length}`,
    });
  }

  const innerExpr = expr.args[0]!;

  if (exprIsFunctionCallOf(innerExpr, BuiltinKeywords.struct)) {
    // ref(struct(...)) - Reference semantics struct
    return evaluateStructType({
      expr: innerExpr as FuncCallExpr,
      env,
      context: { ...context },
      isReferenceSemantics: true,
    });
  } else if (exprIsFunctionCallOf(innerExpr, BuiltinKeywords.enum)) {
    // ref(enum(...)) - Reference semantics enum
    return evaluateEnumType({
      expr: innerExpr as FuncCallExpr,
      env,
      context: { ...context },
      isReferenceSemantics: true,
    });
  } else {
    throw formatErrorMessage({
      token: innerExpr.token,
      errorMessage: `"ref" can only be used with "struct" or "enum", got:\n${exprToString(innerExpr)}`,
    });
  }
}
