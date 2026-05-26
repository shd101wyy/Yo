import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Phase 0 of plans/FORMAL_VERIFICATION.md.
 *
 * The contract builtins (`requires`, `ensures`, `invariant`, `ghost`,
 * `ghost_fn`, `old`) are no-op markers in Phase 0: they parse, type-
 * check, and evaluate without effect. Later phases (signature
 * extraction, codegen lowering to `assert(...)`, SMT discharge) attach
 * meaning to them.
 *
 * Contract clauses inside function-type signatures are SKIPPED by the
 * parameter-processing pipeline in `src/evaluator/types/function.ts`
 * — these handlers only fire when the builtins appear in expression
 * position (e.g., a loop body, a free statement).
 */

/**
 * Evaluate any of the no-op contract markers. Each argument is
 * evaluated (so expression-level errors surface), but the call itself
 * returns `unit`.
 */
function evaluateContractMarker({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  for (const argExpr of expr.args) {
    const evaluatedArg = evaluateExpression({
      expr: argExpr,
      env,
      context,
    });
    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate argument of contract clause.`,
      });
    }
    env = evaluatedArg.$.env;
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

export function evaluateRequires(args: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(args.expr, BuiltinFunctions.requires);
  if (args.expr.args.length === 0) {
    throw formatErrorMessage({
      token: args.expr.token,
      errorMessage: `'requires(...)' with zero arguments is a syntax error. Omit the clause entirely if there is no precondition.`,
    });
  }
  return evaluateContractMarker(args);
}

export function evaluateEnsures(args: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(args.expr, BuiltinFunctions.ensures);
  if (args.expr.args.length === 0) {
    throw formatErrorMessage({
      token: args.expr.token,
      errorMessage: `'ensures(...)' with zero arguments is a syntax error. Omit the clause entirely if there is no postcondition.`,
    });
  }
  return evaluateContractMarker(args);
}

export function evaluateInvariant(args: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(args.expr, BuiltinFunctions.invariant);
  if (args.expr.args.length === 0) {
    throw formatErrorMessage({
      token: args.expr.token,
      errorMessage: `'invariant(...)' with zero arguments is a syntax error.`,
    });
  }
  return evaluateContractMarker(args);
}

/**
 * `ghost(name := expr)` — ghost binding. Phase 0 treats it as a no-op
 * marker that evaluates the argument (which is typically an `:=`
 * binding); the binding becomes part of the surrounding environment.
 *
 * Later phases will mark the binding as ghost-only (no codegen, only
 * visible to the verifier and other ghost code).
 */
export function evaluateGhost(args: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(args.expr, BuiltinFunctions.ghost, 1);
  return evaluateContractMarker(args);
}

/**
 * `ghost_fn(fn_value)` — declares a ghost function. Distinct builtin
 * from `ghost(name := expr)` (see audit §A3). Phase 0 evaluates the
 * inner function-value expression and returns its result; later
 * phases will mark the value as ghost-only.
 */
export function evaluateGhostFn({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.ghost_fn, 1);

  const innerExpr = expr.args[0]!;
  const evaluatedInner = evaluateExpression({
    expr: innerExpr,
    env,
    context,
  });
  if (!evaluatedInner.$) {
    throw formatErrorMessage({
      token: innerExpr.token,
      errorMessage: `Failed to evaluate argument of 'ghost_fn(...)'.`,
    });
  }

  // Phase 0: transparent pass-through. Later phases attach a
  // ghost-only flag to the value/type so codegen erases it and
  // non-ghost callers are rejected.
  expr.$ = evaluatedInner.$;
  return expr;
}

/**
 * `old(expr)` — references a parameter's value at function entry.
 * Only meaningful inside `ensures(...)` clauses; for Phase 0 it is a
 * transparent pass-through that returns the inner expression's value.
 *
 * Scope restriction (only valid in ensures) is enforced in a later
 * phase along with the `result` magic identifier.
 */
export function evaluateOld({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.old, 1);

  const innerExpr = expr.args[0]!;
  const evaluatedInner = evaluateExpression({
    expr: innerExpr,
    env,
    context,
  });
  if (!evaluatedInner.$) {
    throw formatErrorMessage({
      token: innerExpr.token,
      errorMessage: `Failed to evaluate argument of 'old(...)'.`,
    });
  }

  expr.$ = evaluatedInner.$;
  return expr;
}
