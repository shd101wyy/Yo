import { Environment } from "../../env";
import {
  BuiltinFunctions,
  Expr,
  FuncCallExpr,
  expectExprToBeFunctionCallOf,
} from "../../expr";
import { VUnit } from "../../unit-value";
import { EvaluatorContext } from "../context";

/**
 * Evaluate __yo_gc_collect() builtin function
 *
 * This function manually triggers garbage collection for cycle detection.
 * It has no parameters and returns unit.
 *
 * In evaluation mode, this is a no-op since we don't have actual memory management.
 * In code generation, this will emit a call to the C runtime GC function.
 */
export function evaluateYoGcCollect({
  expr,
  env,
  // context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  // Validate that this is a call to __yo_gc_collect with 0 arguments
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect, 0);

  // In the evaluator, we don't have actual memory management,
  // so this is effectively a no-op that just returns unit.
  // The actual GC functionality will be handled in the C code generation.

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}
