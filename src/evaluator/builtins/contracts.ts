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
import { type Token, TokenType } from "../../token";
import type { FunctionType } from "../../types/definitions";
import { isUnitType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { fileHasPragma } from "../memory-safety";

/**
 * Phase 0 of plans/FORMAL_VERIFICATION.md.
 *
 * Contract builtins and their Phase 0 behavior:
 *  - `requires` / `ensures` — extracted from function signatures by
 *    `src/evaluator/types/function.ts` and lowered to runtime
 *    `assert(...)` (or `comptime_assert(...)` for comptime functions)
 *    by `wrapFunctionBodyWithContracts` below. The handler functions
 *    here (`evaluateRequires` / `evaluateEnsures`) only fire when the
 *    builtins appear in EXPRESSION position rather than a signature;
 *    there they act as no-op markers that evaluate their args.
 *  - `invariant` — no-op marker (loop placement is checked in
 *    `while.ts`); SMT discharge of loop invariants is a later phase.
 *  - `ghost` / `ghost_fn` — ghost binding / ghost function marker,
 *    transparent pass-through in Phase 0.
 *  - `old` — entry-snapshot inside `ensures` (handled by
 *    `wrapFunctionBodyWithContracts`); transparent pass-through if it
 *    appears elsewhere.
 *
 * Known Phase 0 gaps (intentional, deferred to later phases):
 *  - `old(...)` is NOT scope-restricted to `ensures` clauses — it
 *    works (transparently) anywhere. Rejecting it outside `ensures`
 *    arrives with the verifier.
 *  - Type invariants (`invariant(...)` as a field-like declaration
 *    inside `object(...)` / `struct(...)`) are NOT implemented. Only
 *    loop invariants are recognized in Phase 0; type invariants are a
 *    Phase 3 item per plans/FORMAL_VERIFICATION.md.
 *  - `ghost_fn`-declared functions are callable from non-ghost code
 *    (no ghost-context tracking exists yet). Ghost-only enforcement
 *    arrives with the verifier.
 *
 * The SMT verifier (Phase 1+) is a separate, larger component.
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
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'ghost_fn(...)' takes exactly one argument: a function value to mark as ghost-only (e.g. 'ghost_fn((fn(x : i32) -> bool)(x > i32(0)))'). Got ${expr.args.length} arguments.`,
    });
  }
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
 * `old(expr)` — references a value at function entry. Inside an
 * `ensures(...)` clause, `wrapFunctionBodyWithContracts` hoists each
 * `old(expr)` into an entry-time snapshot binding so it captures the
 * pre-body value (correct for mutated `ref(name) : T` params). This
 * handler only fires for stray `old(...)` calls outside that rewrite
 * path, where it is a transparent pass-through returning the inner
 * value. Scope-restriction (rejecting `old(...)` outside `ensures`)
 * is deferred to a later phase.
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
 * The identifier bound to a function's return value inside
 * `ensures(...)` predicates. The user writes `ensures(result > 0)` and
 * the lowering binds a local `result := <body>` so the predicate
 * resolves it naturally. Documented as a magic identifier in
 * plans/FORMAL_VERIFICATION.md; in Phase 0 it is just a conventional
 * local name introduced by the ensures wrapper.
 */
const RESULT_IDENTIFIER = "result";

/**
 * Build a synthetic atom token (identifier or string) borrowing the
 * source position of `srcToken` so diagnostics point at the user's
 * contract clause rather than a synthetic site.
 */
function synthAtom(value: string, type: TokenType, srcToken: Token): Expr {
  return {
    tag: ExprTag.Atom,
    token: {
      type,
      value,
      position: srcToken.position,
      modulePath: srcToken.modulePath,
      inputString: srcToken.inputString,
    },
  };
}

/**
 * Build a synthetic `assert(predicate, "<label>: <pred-src>")` (or
 * `comptime_assert(...)`) call from a contract predicate expression.
 * `labelPred` is used only for the human-readable message; the actual
 * checked predicate is `pred` (which may have had `old(...)` rewritten
 * to snapshot references).
 */
function buildAssertCall(
  pred: Expr,
  labelPred: Expr,
  label: string,
  assertFnName: string
): FnCallExpr {
  const predToken = pred.token;
  const msg = `${label}: ${exprToString(labelPred)}`;

  // String-literal tokens store the JSON-encoded form of their value
  // (`evaluateStringLiteral` runs `JSON.parse(token.value)`), so the
  // synthetic message must round-trip through JSON.stringify.
  const msgExpr = synthAtom(JSON.stringify(msg), TokenType.String, predToken);

  return {
    tag: ExprTag.FnCall,
    func: buildAssertCallee(assertFnName, predToken),
    args: [pred, msgExpr],
    token: predToken,
  };
}

/**
 * Callee for the synthesized contract assert. `comptime_assert` is a
 * builtin keyword and resolves bare; runtime `assert` moved out of the
 * prelude into `std/assert` (explicit import), so a bare `assert`
 * identifier no longer resolves in user files that never import it.
 * Synthesize `import("std/assert").assert` instead — self-contained and
 * immune to local shadowing.
 */
function buildAssertCallee(assertFnName: string, predToken: Token): Expr {
  if (assertFnName !== "assert") {
    return synthAtom(assertFnName, TokenType.Identifier, predToken);
  }
  const importCall: FnCallExpr = {
    tag: ExprTag.FnCall,
    func: synthAtom("import", TokenType.Identifier, predToken),
    args: [
      synthAtom(JSON.stringify("std/assert"), TokenType.String, predToken),
    ],
    token: predToken,
  };
  return {
    tag: ExprTag.FnCall,
    func: synthAtom(".", TokenType.Identifier, predToken),
    args: [importCall, synthAtom("assert", TokenType.Identifier, predToken)],
    token: predToken,
  };
}

/**
 * Build a synthetic `name := value` (runtime) or `name :: value`
 * (compile-time) binding. Comptime functions need `::` because a `:=`
 * runtime binding is rejected inside a compile-time-only function body.
 */
function buildBinding(
  name: string,
  value: Expr,
  srcToken: Token,
  op: ":=" | "::"
): FnCallExpr {
  const bindToken: Token = {
    type: TokenType.Identifier,
    value: op,
    position: srcToken.position,
    modulePath: srcToken.modulePath,
    inputString: srcToken.inputString,
  };
  return {
    tag: ExprTag.FnCall,
    isInfix: true,
    func: { tag: ExprTag.Atom, token: bindToken },
    args: [synthAtom(name, TokenType.Identifier, srcToken), value],
    token: bindToken,
  };
}

/**
 * Rewrite `old(expr)` occurrences inside `ensures` predicates.
 *
 * `old(expr)` must read the value of `expr` as it was on function
 * ENTRY, not after the body ran (relevant for mutated `ref(name) : T`
 * parameters). We hoist each `old(expr)` into an entry-time snapshot
 * binding `__yo_contract_old_K := expr` and replace the `old(expr)`
 * node with a reference to that snapshot.
 *
 * Returns the snapshot bindings (to emit at the top of the wrapped
 * body) and the rewritten predicates (with `old(...)` replaced).
 */
function hoistOldExpressions(
  preds: Expr[],
  bindOp: ":=" | "::"
): {
  snapshots: FnCallExpr[];
  rewritten: Expr[];
} {
  const snapshots: FnCallExpr[] = [];
  let counter = 0;

  const rewrite = (e: Expr): Expr => {
    if (!exprIsFunctionCall(e)) return e;
    if (exprIsFunctionCallOf(e, BuiltinFunctions.old, 1)) {
      // Rewrite nested old() inside the inner expression first.
      const inner = rewrite(e.args[0]!);
      const snapName = `__yo_contract_old_${counter}`;
      counter += 1;
      snapshots.push(buildBinding(snapName, inner, e.token, bindOp));
      return synthAtom(snapName, TokenType.Identifier, e.token);
    }
    return {
      ...e,
      func: rewrite(e.func),
      args: e.args.map(rewrite),
      $: undefined,
    };
  };

  const rewritten = preds.map(rewrite);
  return { snapshots, rewritten };
}

/**
 * Phase 0 of plans/FORMAL_VERIFICATION.md task #6: lower the
 * `requires(...)` / `ensures(...)` clauses extracted from a function
 * signature into runtime `assert(P, msg)` / `comptime_assert(P, msg)`
 * calls woven into the function body.
 *
 * The choice between runtime `assert` and `comptime_assert` is
 * mechanical: comptime functions (return type `comptime(...)`) use
 * `comptime_assert`; runtime functions use `assert`. See the
 * "Runtime vs comptime contracts" section in the plan.
 *
 * Lowering shape (all four combinations):
 *
 *   no contracts     → <body> (unchanged)
 *   requires only    → { assert(R1); ...; <body> }
 *   ensures only     → { result := (<body>); assert(E1); ...; result }
 *   both             → { assert(R1); ...; result := (<body>); assert(E1); ...; result }
 *
 * `requires` runs on entry (before the body); `ensures` runs after the
 * body computes the return value, which is bound to the local
 * `result` so postcondition predicates can reference it. `old(...)` is
 * a transparent pass-through in Phase 0 (it resolves to the parameter
 * value; entry-snapshot semantics arrive with the verifier).
 *
 * The ensures wrapper only activates for functions that declare
 * `ensures(...)` clauses, so no existing stdlib code (none of which
 * uses ensures yet) changes shape.
 *
 * The body is NOT cloned — it is reused as the `result :=` initializer
 * (ensures present) or the trailing statement (requires only).
 */
export function wrapFunctionBodyWithContracts(
  body: Expr,
  fnType: FunctionType
): Expr {
  const requiresExprs = fnType.requiresExprs ?? [];
  const ensuresExprs = fnType.ensuresExprs ?? [];
  if (requiresExprs.length === 0 && ensuresExprs.length === 0) {
    return body;
  }

  // Honor `pragma(Pragma.NoContracts);` — erase contract clauses
  // entirely. The body runs without any assert(...) call.
  if (fileHasPragma(body.token.modulePath, "NoContracts")) {
    return body;
  }

  const isComptimeFunction = fnType.return.isCompileTimeOnly;
  const assertFnName = isComptimeFunction ? "comptime_assert" : "assert";
  const bindOp: ":=" | "::" = isComptimeFunction ? "::" : ":=";

  const requiresAsserts = requiresExprs.map((pred) =>
    buildAssertCall(pred, pred, "requires failed", assertFnName)
  );

  const beginAtom = (srcToken: Token): Expr =>
    synthAtom(BuiltinKeywords.begin[0]!, TokenType.Identifier, srcToken);

  // No ensures: just prepend the requires asserts to the body.
  if (ensuresExprs.length === 0) {
    if (
      exprIsFunctionCall(body) &&
      exprIsFunctionCallOf(body, BuiltinKeywords.begin)
    ) {
      return {
        ...body,
        args: [...requiresAsserts, ...body.args],
        $: undefined, // re-evaluate
      };
    }
    return {
      tag: ExprTag.FnCall,
      func: beginAtom(body.token),
      args: [...requiresAsserts, body],
      token: body.token,
    };
  }

  // Ensures present. Hoist `old(...)` snapshots from the ensures
  // predicates so they capture entry-time values, then build the
  // wrapped body.
  const { snapshots, rewritten } = hoistOldExpressions(ensuresExprs, bindOp);
  const ensuresAsserts = rewritten.map((rewrittenPred, i) =>
    // labelPred is the ORIGINAL predicate (still shows `old(...)` in
    // the message); rewrittenPred is what actually gets checked.
    buildAssertCall(
      rewrittenPred,
      ensuresExprs[i]!,
      "ensures failed",
      assertFnName
    )
  );

  const returnsUnit = isUnitType(fnType.return.type);

  if (returnsUnit) {
    // Unit return: `result` is not useful and `void result = ...` is
    // invalid C. Run the body as a statement, then the ensures
    // asserts. The block's value is unit either way.
    //
    //   { <old snapshots>; <requires>; <body>; <ensures> }
    return {
      tag: ExprTag.FnCall,
      func: beginAtom(body.token),
      args: [...snapshots, ...requiresAsserts, body, ...ensuresAsserts],
      token: body.token,
    };
  }

  // Non-unit return: bind the body's value to `result`, run the
  // ensures asserts (which may reference `result`), then return it.
  //
  //   { <old snapshots>; <requires>; result := (<body>); <ensures>; result }
  const resultBinding = buildBinding(
    RESULT_IDENTIFIER,
    body,
    body.token,
    bindOp
  );
  const resultRef = synthAtom(
    RESULT_IDENTIFIER,
    TokenType.Identifier,
    body.token
  );

  return {
    tag: ExprTag.FnCall,
    func: beginAtom(body.token),
    args: [
      ...snapshots,
      ...requiresAsserts,
      resultBinding,
      ...ensuresAsserts,
      resultRef,
    ],
    token: body.token,
  };
}
