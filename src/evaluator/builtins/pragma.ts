import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { registerFilePragma, type PragmaKind } from "../memory-safety";

/**
 * Evaluate the `pragma(Pragma.X);` builtin.
 *
 * Used at the top of a Yo source file to declare per-file privilege
 * flags. The only flag currently supported is `Pragma.AllowUnsafe`,
 * which marks the file as permitted to use raw pointer operations
 * without explicit `unsafe(...)` wraps.
 *
 * The argument is recognized at the AST level — it must be a
 * `Pragma.AllowUnsafe` property-access expression. We don't actually
 * evaluate `Pragma` itself because the prelude needs to declare its
 * own pragma BEFORE the `Pragma` enum is in scope (chicken-and-egg).
 *
 * See plans/MEMORY_SAFETY.md.
 */
export function evaluatePragma({
  expr,
  env,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.pragma, 1);

  const argExpr = expr.args[0]!;
  const kind = parsePragmaArgument(argExpr);
  if (!kind) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `'pragma(...)' expects a 'Pragma.X' argument (e.g. 'pragma(Pragma.AllowUnsafe);'). Got: ${exprToString(argExpr)}`,
    });
  }

  const modulePath = expr.token.modulePath;
  if (modulePath) {
    registerFilePragma(modulePath, kind);
  }

  // pragma(...) is a compile-time-only declaration; returns unit.
  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

/**
 * Recognize `Pragma.AllowUnsafe` (and future variants) at the AST
 * level without requiring the `Pragma` enum to be resolved.
 *
 * Returns the matched kind, or `null` if the shape doesn't match.
 */
function parsePragmaArgument(
  argExpr: FnCallExpr["args"][number]
): PragmaKind | null {
  // Property access in Yo is parsed as a `.` function call:
  //   `Pragma.AllowUnsafe`  ==>  ".".call(Pragma, AllowUnsafe)
  if (!exprIsFunctionCall(argExpr)) return null;
  if (!exprIsFunctionCallOf(argExpr, ".", 2)) return null;
  const lhs = argExpr.args[0];
  const rhs = argExpr.args[1];
  if (!lhs || !rhs) return null;
  if (!exprIsAtom(lhs) || lhs.token.value !== "Pragma") return null;
  if (!exprIsAtom(rhs)) return null;
  switch (rhs.token.value) {
    case "AllowUnsafe":
      return "AllowUnsafe";
    default:
      return null;
  }
}
