/**
 * Flowability check for `ref(T)`-yielding expressions.
 *
 * Implements the structural soundness rule from `plans/ITERATOR_REDESIGN.md`:
 * an expression is "flowable" iff it roots back to a `ref`-bound
 * parameter (or another `ref`-bound local with a flowable initializer)
 * along a projection-respecting chain.
 *
 * Used at two enforcement points:
 *
 *  1. The RHS of a `ref(name) := expr;` local binding must be
 *     flowable — otherwise the binding would hand out a reference
 *     into storage that doesn't outlive the call frame.
 *  2. The return expression of a function declared `-> ref(T)` must
 *     be flowable — otherwise the function would return a borrow
 *     into its own dying frame.
 *
 * The rules (numbered to match the plan):
 *
 *  R1. A name reference is flowable iff its binding has
 *      `isRef: true` (a `ref(name) : T` parameter or a
 *      `ref(name) := ...` local).
 *  R2. `expr.field` is flowable iff `expr` is flowable.
 *  R3. `expr(args)` is flowable iff the callee's return slot is
 *      `ref(T)` AND every `ref`-typed argument it receives is
 *      itself flowable.
 *  R4. `cond` / `match` arms each return-flow independently —
 *      every arm reachable as a return value must be flowable.
 *
 * Net effect: every flowable expression's root is a `ref`-typed
 * parameter, which by definition points at storage in some active
 * caller frame above the current one. Therefore the value yielded
 * out of the current function is alive when the caller receives it.
 */

import {
  BuiltinFunctions,
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  hasAnyControlFlow,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import type { FunctionType } from "../../types/definitions";
import { isFunctionType } from "../../types/guards";
import { isFunctionValue } from "../../value";
import { getVariablesFromEnv } from "../../env";

/**
 * Strip outer `begin(...)` wrappers from an expression so we can
 * inspect the value-producing inner. After evaluation, single-
 * expression bodies often appear as `begin((expr))`; the value
 * that flows out is `expr`. Recursively unwraps in case the body
 * is `begin(begin((expr)))`.
 */
function unwrapBeginBlocks(expr: Expr): Expr {
  let current = expr;
  while (
    exprIsFunctionCall(current) &&
    exprIsFunctionCallOf(current, BuiltinKeywords.begin)
  ) {
    const call = current as FnCallExpr;
    if (call.args.length === 0) return current;
    current = call.args[call.args.length - 1]!;
  }
  return current;
}

/**
 * Walk `expr` and return `true` iff it satisfies R1–R4. The
 * expression must have been evaluated already (so `expr.$` is set
 * and bindings can be looked up in `expr.$.env`).
 */
export function isFlowableExpr(expr: Expr): boolean {
  // Strip any outer `begin(...)` wrapper(s). Single-expression
  // bodies after evaluation often appear as `begin((expr))`.
  expr = unwrapBeginBlocks(expr);

  // Divergent expressions never actually yield a value to the
  // surrounding expression — `panic(...)`, `return(...)`,
  // `unwind(...)`, `break`, `continue`, or anything with a control-
  // flow flag set. Accept vacuously: a function whose return value
  // is unreachable through this path can't smuggle a dangling
  // reference out through it.
  if (hasAnyControlFlow(expr.$?.controlFlow)) {
    return true;
  }
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.panic)
  ) {
    return true;
  }

  // Trusted escape hatch: `unsafe(expr)` in privileged code is the
  // documented "trust me" marker. The Phase C structural gate
  // already restricts `unsafe(...)` to files declaring
  // `pragma(Pragma.AllowUnsafe);`, so accepting it as flowable
  // here doesn't widen the safe-code attack surface. Used by
  // `Indexable.project` impls on Array, Slice, ArrayList, String —
  // they compute the element address via `__yo_array_index` etc.
  // and wrap the result in `unsafe(...)`. See
  // plans/ITERATOR_REDESIGN.md and plans/MEMORY_SAFETY.md.
  if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.unsafe)
  ) {
    return true;
  }

  // R1: bare name → check binding flag.
  if (exprIsAtom(expr)) {
    if (!expr.$?.env || !expr.$?.variableName) return false;
    const vars = getVariablesFromEnv(expr.$.env, expr.$.variableName);
    if (vars.length === 0) return false;
    return Boolean(vars[vars.length - 1]!.isRef);
  }

  if (!exprIsFunctionCall(expr)) return false;
  const call = expr as FnCallExpr;

  // R2: `expr.field` is parsed as a `.` function call with 2 args
  //     `[base, field-name]`. Single-arg `.field` (variant ctor) and
  //     other shapes never appear in a return-position projection
  //     chain, so we ignore them here.
  if (exprIsFunctionCallOf(call, ".", 2)) {
    return isFlowableExpr(call.args[0]!);
  }

  // R4: `cond(expr1 => arm1, expr2 => arm2, ...)`.
  //     Each `=>` pair is itself a 2-arg function call; the second
  //     argument is the arm body that flows out. Every arm must be
  //     flowable.
  if (exprIsFunctionCallOf(call, "cond")) {
    for (const arm of call.args) {
      if (
        exprIsFunctionCall(arm) &&
        exprIsFunctionCallOf(arm as FnCallExpr, "=>", 2)
      ) {
        const armBody = (arm as FnCallExpr).args[1]!;
        if (!isFlowableExpr(armBody)) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  // R4 (match form): `match(scrutinee, .Variant => arm, ...)`.
  //     The scrutinee is the first arg; the remaining args are
  //     `=>` pairs whose arm body is the second.
  if (exprIsFunctionCallOf(call, "match")) {
    for (let i = 1; i < call.args.length; i++) {
      const arm = call.args[i];
      if (
        arm &&
        exprIsFunctionCall(arm) &&
        exprIsFunctionCallOf(arm as FnCallExpr, "=>", 2)
      ) {
        const armBody = (arm as FnCallExpr).args[1]!;
        if (!isFlowableExpr(armBody)) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  // R3: regular function call. The callee's return slot must be
  //     `ref(T)`, and every `ref`-typed argument must itself be
  //     flowable.
  //
  // The callee type can be resolved from one of two places:
  //   (a) `call.func.$.value` if the callee is a direct function
  //       reference (`get_ref(arg)`) — value is a FunctionValue.
  //   (b) `call.func.$.type` if the callee is a method-dispatch
  //       access (`receiver.method(arg)`) — `call.func` is a
  //       `.`-call whose `$.type` carries the method's FunctionType
  //       (the resolved method, not a wrapped value).
  // In case (b) the receiver is logically the first argument: a
  // `ref(self) : Self` parameter requires the receiver to be flowable.
  // Method calls (`receiver.method(arg)`) have `call.func` as a
  // `.`-call carrying the resolved method's FunctionType on
  // `call.func.$.type` (and often also `call.func.$.value` set to the
  // bound method's FunctionValue). For arg-matching we treat the
  // receiver as an implicit first argument.
  const isMethodCall = exprIsFunctionCallOf(call.func, ".", 2);
  let calleeType: FunctionType | undefined;
  if (isMethodCall) {
    const t = call.func.$?.type;
    if (t && isFunctionType(t)) calleeType = t;
  } else {
    const calleeValue = call.func.$?.value;
    if (calleeValue && isFunctionValue(calleeValue)) {
      const t = calleeValue.type;
      if (isFunctionType(t)) calleeType = t;
    }
  }
  if (!calleeType) return false;
  if (!calleeType.return.isRef) return false;

  // For every parameter that is `ref`-typed, the corresponding
  // argument in the call must be flowable. Parameters that aren't
  // `ref` don't constrain anything — passing a regular value to a
  // by-value parameter is fine.
  //
  // For method calls, the receiver (`call.func.args[0]`) is the
  // implicit first argument and lines up with `params[0]`; the
  // remaining `call.args` shift by one. For direct calls,
  // `call.args` aligns with `params` 1-to-1.
  const params = calleeType.parameters;
  const args: Expr[] = isMethodCall
    ? [(call.func as FnCallExpr).args[0]!, ...call.args]
    : call.args;
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (!p.isRef) continue;
    const a = args[i];
    if (!a) return false;
    if (!isFlowableExpr(a)) return false;
  }
  return true;
}
