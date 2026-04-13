import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { EvaluatorContext } from "../context";
import { evaluateStructType } from "./struct";

/**
 * Evaluate object types:
 *
 * - object(...) - Reference semantics struct (equivalent to object)
 * - atomic object(...) - Atomic reference counted object (thread-safe, no cycle GC)
 */
export function evaluateObjectType({
  expr,
  env,
  context,
  isAtomicRc = false,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  isAtomicRc?: boolean;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.object)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "object", got:\n${exprToString(expr)}`,
    });
  }

  // Object is essentially a struct with reference semantics enabled
  // The struct evaluator now handles both 'struct' and 'object' keywords
  return evaluateStructType({
    expr,
    env,
    context,
    isAtomicRc,
  });
}
