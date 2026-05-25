import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";

/**
 * Evaluate the `unsafe(expr)` builtin.
 *
 * `unsafe(expr)` is a compile-time marker that permits pointer deref
 * (`p.*`), pointer arithmetic (`&+`, `&-`, `&/`), and `consume(p.* = v)`
 * inside `expr`. Outside `unsafe(...)`, those operations are compile
 * errors.
 *
 * Semantically transparent: the value, type, and environment of
 * `unsafe(expr)` are identical to `expr` itself. Codegen lowers
 * `unsafe(expr)` to its inner expression — no runtime cost.
 *
 * See plans/MEMORY_SAFETY.md for the full design.
 */
export function evaluateUnsafe({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.unsafe, 1);

  // Privilege check: `unsafe(...)` itself is only callable inside a
  // file that has declared `pragma(Pragma.AllowUnsafe);`. Without
  // this gate, user code could trivially bypass the deref/arith
  // gates by wrapping every pointer op in `unsafe(...)`. See Phase C
  // of plans/MEMORY_SAFETY.md.
  if (!isImplicitlyUnsafeCapableFile(expr.token.modulePath)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'unsafe(...)' is not available in safe code.

To use raw pointer operations in this file, declare at the top:

    pragma(Pragma.AllowUnsafe);

This marks the file as unsafe-capable and accepts responsibility for
the raw memory operations it contains.`,
    });
  }

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      unsafeContext: true,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument of 'unsafe(...)'.`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // unsafe(...) is transparent — propagate the inner value/type AND the
  // ownership-tracking fields unchanged so that downstream bindings,
  // dup/drop scheduling, and consumption tracking see the inner
  // expression's temp variable as if `unsafe(...)` weren't there.
  //
  // In particular, **`variableName` must propagate**: without it, a
  // pattern like `k := unsafe(s1.clone())` makes the binding create a
  // fresh temp for `unsafe(...)` instead of aliasing the inner
  // `s1.clone()` temp, and the begin-block drop list ends up with BOTH
  // the inner temp and `k` — producing a double-drop (use-after-free
  // at runtime).
  expr.$ = {
    ...evaluatedArgExpr.$,
    env,
  };
  return expr;
}
