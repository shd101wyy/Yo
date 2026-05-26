import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  type Expr,
  ExprTag,
  expectExprToBeFunctionCallOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import type { FunctionType } from "../../types/definitions";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { fileHasPragma } from "../memory-safety";

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

/**
 * Phase 0 of plans/FORMAL_VERIFICATION.md task #6: lower the
 * `requires(...)` clauses extracted from a function signature into
 * runtime `assert(P, msg)` / `comptime_assert(P, msg)` calls prepended
 * to the function body.
 *
 * The choice between runtime `assert` and `comptime_assert` is
 * mechanical: comptime functions (return type `comptime(...)`) use
 * `comptime_assert`; runtime functions use `assert`. See the
 * "Runtime vs comptime contracts" section in the plan.
 *
 * `ensures(...)` lowering is deferred until task #6 phase B because
 * it requires binding the `result` magic identifier to the function's
 * return value — separate concern, separate sub-PR.
 *
 * Returns the original body unchanged if there are no `requires`
 * clauses. Otherwise returns a synthetic begin-block AST node:
 *   `{ assert(P1, "..."); assert(P2, "..."); ...; <original body> }`
 *
 * The synthetic nodes borrow tokens from the predicate exprs so
 * error messages point at the user's `requires(...)` source
 * location, not at a synthetic site.
 *
 * The body is NOT cloned — the original body expression is reused as
 * the last statement of the synthetic begin block. Callers that hold
 * other references to the body should be aware that the returned
 * expression now contains it.
 */
export function wrapFunctionBodyWithContracts(
  body: Expr,
  fnType: FunctionType
): Expr {
  const requiresExprs = fnType.requiresExprs;
  if (!requiresExprs || requiresExprs.length === 0) {
    return body;
  }

  // Honor `pragma(Pragma.NoContracts);` — erase contract clauses
  // entirely. The wrap is skipped; the body runs without any
  // assert(...) call. Use the function body's modulePath since that
  // is where the function's source lives.
  if (fileHasPragma(body.token.modulePath, "NoContracts")) {
    return body;
  }

  const isComptimeFunction = fnType.return.isCompileTimeOnly;
  const assertFnName = isComptimeFunction ? "comptime_assert" : "assert";

  const assertCalls: FnCallExpr[] = requiresExprs.map((pred) => {
    const predToken = pred.token;
    const msg = `requires failed: ${exprToString(pred)}`;

    // String-literal tokens store the JSON-encoded form of their
    // value (`evaluateStringLiteral` runs `JSON.parse(token.value)`).
    // So our synthetic message must round-trip through JSON.stringify.
    const msgExpr: Expr = {
      tag: ExprTag.Atom,
      token: {
        type: TokenType.String,
        value: JSON.stringify(msg),
        position: predToken.position,
        modulePath: predToken.modulePath,
        inputString: predToken.inputString,
      },
    };

    return {
      tag: ExprTag.FnCall,
      func: {
        tag: ExprTag.Atom,
        token: {
          type: TokenType.Identifier,
          value: assertFnName,
          position: predToken.position,
          modulePath: predToken.modulePath,
          inputString: predToken.inputString,
        },
      },
      args: [pred, msgExpr],
      token: predToken,
    };
  });

  // If the body is already a begin block, prepend the asserts to its
  // statement list. Otherwise wrap into a new begin block.
  if (
    exprIsFunctionCall(body) &&
    exprIsFunctionCallOf(body, BuiltinKeywords.begin)
  ) {
    return {
      ...body,
      args: [...assertCalls, ...body.args],
      $: undefined, // re-evaluate
    };
  }

  return {
    tag: ExprTag.FnCall,
    func: {
      tag: ExprTag.Atom,
      token: {
        type: TokenType.Identifier,
        value: BuiltinKeywords.begin[0]!,
        position: body.token.position,
        modulePath: body.token.modulePath,
        inputString: body.token.inputString,
      },
    },
    args: [...assertCalls, body],
    token: body.token,
  };
}
