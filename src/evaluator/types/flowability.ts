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
import { TokenType } from "../../token";
import type { FunctionType } from "../../types/definitions";
import { isFunctionType } from "../../types/guards";
import {
  typeMayProvideSliceSource,
  typeRepresentationContainsRawPtr,
} from "../../types/utils";
import { isFunctionValue, isTypeValue } from "../../value";
import { getVariablesFromEnv, type Variable } from "../../env";

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
 *
 * Options:
 *  - `allowSameFrameLocal`: passed by the `ref(name) := expr;`
 *    binding site to accept a same-frame local (the borrowing binding's
 *    lifetime is bounded by its block, which is bounded by the local's
 *    frame, so the source can't go away before the borrow does). The
 *    strict R1 (ref-bound only) still applies elsewhere.
 *  - `maxLocalFrameLevel`: refines `allowSameFrameLocal` with a scope
 *    bound. A `=` reassignment (unlike `:=`) targets a binding that may
 *    live in an *outer* block than the current one; a local source in an
 *    *inner* block would then dangle when its block exits. The assignment
 *    site passes the target binding's `frameLevel` here, and a same-frame
 *    local is accepted only when its `frameLevel <= maxLocalFrameLevel`
 *    (i.e. the source's scope encloses — outlives — the target's). When
 *    unset, `allowSameFrameLocal` accepts any non-module local (the
 *    `:=` binding-site semantics, where the new binding is innermost).
 *  - `allowParameterSource`: passed by the slice-flowability check
 *    (`plans/SLICE_FLOWABILITY.md`). Accepts a name reference whose
 *    binding is a parameter of the current function (any parameter,
 *    not just `ref(name)`) — the caller's value lives for at least
 *    the duration of the call, so handing a `Slice` rooted at it
 *    back to the caller is sound. NOT enabled for `ref(T)`-return
 *    enforcement; returning a non-`ref` parameter as a `ref(T)`
 *    borrow is meaningless.
 *  - `allowComptimeSource`: passed by the slice-flowability check.
 *    Accepts a name reference whose binding is `comptime` — the value
 *    lives in static storage and never dangles at runtime.
 */
export function isFlowableExpr(
  expr: Expr,
  options: {
    allowSameFrameLocal?: boolean;
    allowParameterSource?: boolean;
    allowComptimeSource?: boolean;
    maxLocalFrameLevel?: number;
  } = {}
): boolean {
  // Strip any outer `begin(...)` wrapper(s). Single-expression
  // bodies after evaluation often appear as `begin((expr))`.
  expr = unwrapBeginBlocks(expr);

  // Strip a `label : value` wrapper — labeled arguments (constructor
  // fields `Identifier(name : "x")`, named call args) are transparent
  // for flow purposes; the VALUE side is what flows.
  if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ":", 2)) {
    const labeledValue = expr.args[1];
    if (labeledValue) return isFlowableExpr(labeledValue, options);
  }

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
    // Literal atoms (string/char/template-string) live in static
    // storage — the runtime never holds a stack-frame-bound pointer.
    // Accept them when the slice-flowability check opts in. Numeric
    // and bool literals are unreachable here because their types
    // don't carry raw ptrs, but stringly-typed literals (str) do.
    if (
      options.allowComptimeSource &&
      (expr.token.type === TokenType.String ||
        expr.token.type === TokenType.Char ||
        expr.token.type === TokenType.TemplateString)
    ) {
      return true;
    }
    if (!expr.$?.env || !expr.$?.variableName) return false;
    const vars = getVariablesFromEnv(expr.$.env, expr.$.variableName);
    if (vars.length === 0) return false;
    const v = vars[vars.length - 1]!;
    if (v.isRef) return true;
    // R1' (binding-site only): a same-frame local also counts as
    // flowable. Soundness: the borrowing binding's lifetime is
    // bounded by its enclosing block, which is itself bounded by
    // the local's call frame — so the source can't go away before
    // the borrow does. The strict R1 (ref-bound only) still applies
    // at function-return sites; only the `ref(name) := …` binding-
    // site call from `init-assignment.ts` passes `allowSameFrameLocal`.
    //
    // `maxLocalFrameLevel` (assignment site): the source local is only
    // sound if its scope encloses the assignment target's — i.e. its
    // frame level is no deeper than the target's. A deeper (inner-block)
    // local would be freed when its block exits, dangling the slice
    // stored in the outer-scope target. Fall through (don't hard-fail)
    // so a binding that is also a parameter/comptime can still match.
    if (options.allowSameFrameLocal && !v.isModuleLevel) {
      if (
        options.maxLocalFrameLevel === undefined ||
        v.frameLevel <= options.maxLocalFrameLevel
      ) {
        return true;
      }
    }
    // R1'' (slice-flowability only): a parameter of the enclosing
    // function counts as flowable when the slice-flowability check
    // opts in. The caller's value is alive for the duration of the
    // call. See plans/SLICE_FLOWABILITY.md Phase B.
    if (options.allowParameterSource && v.isParameter) {
      return true;
    }
    // R1''' (slice-flowability only): a comptime-bound name lives in
    // static storage, so its representation never dangles at runtime.
    if (options.allowComptimeSource && v.isCompileTimeOnly) {
      return true;
    }
    return false;
  }

  if (!exprIsFunctionCall(expr)) return false;
  const call = expr as FnCallExpr;

  // R2: `expr.field` is parsed as a `.` function call with 2 args
  //     `[base, field-name]`. Single-arg `.field` (variant ctor) and
  //     other shapes never appear in a return-position projection
  //     chain, so we ignore them here.
  if (exprIsFunctionCallOf(call, ".", 2)) {
    // A `.`/2 whose receiver evaluates to a TYPE is a no-argument qualified
    // variant constructor (`Option(str).None`), NOT a field projection. It
    // carries no smuggled pointer, so it is flowable. Only a value receiver is
    // a real field projection (`value.field`), flowable iff the base is.
    const r2RecvValue = call.args[0]?.$?.value;
    if (r2RecvValue && isTypeValue(r2RecvValue)) return true;
    return isFlowableExpr(call.args[0]!, options);
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
        if (!isFlowableExpr(armBody, options)) return false;
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
        if (!isFlowableExpr(armBody, options)) return false;
      } else {
        return false;
      }
    }
    return true;
  }

  // Pointer arithmetic: `base &+ offset` / `base &- offset` (only legal
  // in `pragma(Pragma.AllowUnsafe)` files) yields a pointer into the SAME
  // storage as `base`, displaced by an integer index. The result is
  // flowable iff the base pointer is flowable — the offset is a plain
  // integer and introduces no new storage root. Without this, an
  // assignment like `result = .Some(data_ptr &+ i)` in a hand-written
  // unsafe iterator (e.g. std/collections/hash_map.yo) is wrongly rejected
  // even though `data_ptr` roots back to a `ref(self)` field.
  if (
    exprIsFunctionCallOf(call, "&+", 2) ||
    exprIsFunctionCallOf(call, "&-", 2)
  ) {
    return isFlowableExpr(call.args[0]!, options);
  }

  // Enum/variant construction: `.Variant(args...)`. The callee is the
  // variant selector `.Variant`, which is itself parsed as a 1-arg `.`
  // call (`.(Variant)`) — i.e. `call.func` is a `.`/1 function call (or,
  // defensively, a `.`-typed atom). The constructed value can only carry
  // a raw pointer through its arguments, so it is flowable iff every
  // argument whose own representation carries a raw pointer is flowable.
  // Tag-only and numeric args can't smuggle a dangling reference, so they
  // don't constrain flowability.
  // The QUALIFIED form `Enum.Variant(args...)` parses as a call whose `call.func`
  // is a `.`/2 access (`Option(str).Some`) — NOT the `.`/1 selector above. Its
  // receiver (args[0]) evaluates to a TYPE value. The selector node carries no
  // resolved constructor FunctionType, so the R3 path below cannot resolve the
  // callee and would wrongly reject (e.g. `cond(... => Option(str).Some("a"))`
  // returning a static-string Option). Treat it as a constructor: flowable iff
  // every raw-pointer-carrying argument is flowable — the same rule as the
  // shorthand `.Variant(args)` form.
  const isQualifiedVariantCtor =
    exprIsFunctionCall(call.func) &&
    exprIsFunctionCallOf(call.func as FnCallExpr, ".", 2) &&
    (() => {
      const recvValue = (call.func as FnCallExpr).args[0]?.$?.value;
      return !!recvValue && isTypeValue(recvValue);
    })();
  // Plain struct/type constructor: the CALLEE itself evaluates to a TYPE
  // value (`Identifier(name : "x")` where `Identifier :: struct(name : str)`).
  // Same reasoning as the variant-ctor forms: a freshly constructed value can
  // only carry a raw pointer through its arguments, so it is flowable iff
  // every raw-pointer-carrying argument is flowable. Without this, assigning
  // a constructed str-bearing struct (`(id : Identifier) = Identifier(name :
  // "x")`) false-positived at the assignment flow gate.
  const isTypeCtorCall =
    !!call.func.$?.value && isTypeValue(call.func.$.value);
  const isVariantCtor =
    (exprIsFunctionCall(call.func) &&
      exprIsFunctionCallOf(call.func as FnCallExpr, ".", 1)) ||
    (exprIsAtom(call.func) && call.func.token.type === TokenType.Dot) ||
    isQualifiedVariantCtor ||
    isTypeCtorCall;
  if (isVariantCtor) {
    for (let a of call.args) {
      // Look THROUGH a `label : value` wrapper: the labeled pair node may
      // carry no `$` type of its own, which would silently SKIP the check
      // and accept a constructor smuggling a local-backed slice
      // (`SliceWrapper(s : localSlice)`). The VALUE side is what flows.
      if (exprIsFunctionCall(a) && exprIsFunctionCallOf(a, ":", 2)) {
        a = (a as FnCallExpr).args[1] ?? a;
      }
      const aType = a.$?.type;
      if (
        aType &&
        typeRepresentationContainsRawPtr(aType) &&
        !isFlowableExpr(a, options)
      ) {
        return false;
      }
    }
    return true;
  }

  // Tuple construction: `(e0, e1, ...)` parses as a `tuple(...)` call. A
  // freshly built tuple can only carry a raw pointer through its elements
  // (same reasoning as struct/variant ctors), so it is flowable iff every
  // element whose own representation carries a raw pointer is flowable.
  // Needed for destructuring-assignment targets — `(a, b) = (seed, 1)` where
  // `a : Slice` — whose RHS is a tuple literal; without this the whole-tuple
  // raw-ptr gate would wrongly reject a flowable element source.
  if (exprIsFunctionCallOf(call, BuiltinKeywords.tuple)) {
    for (let a of call.args) {
      // `tuple(...)` elements may be `label : value` (named tuple fields).
      if (exprIsFunctionCall(a) && exprIsFunctionCallOf(a, ":", 2)) {
        a = (a as FnCallExpr).args[1] ?? a;
      }
      const aType = a.$?.type;
      if (
        aType &&
        typeRepresentationContainsRawPtr(aType) &&
        !isFlowableExpr(a, options)
      ) {
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

  // The callee's return slot must either be a `ref(T)` borrow into
  // one of its args (the original R3) or — in slice-flowability mode —
  // a value-typed return whose representation transitively carries a
  // raw pointer (Slice/Ptr/struct-wrapping-Slice/etc.). In the latter
  // case the callee's body, if also subject to slice-flowability,
  // can only have produced the pointer from one of its own args, so
  // checking that those args themselves are flowable suffices.
  const isRefReturn = calleeType.return.isRef;
  const isSliceReturn =
    !!options.allowParameterSource &&
    !isRefReturn &&
    typeRepresentationContainsRawPtr(calleeType.return.type);
  if (!isRefReturn && !isSliceReturn) return false;

  // For every parameter that is `ref`-typed, the corresponding
  // argument in the call must be flowable. Parameters that aren't
  // `ref` don't constrain anything in standard ref-return mode —
  // passing a regular value to a by-value parameter is fine.
  //
  // In slice-flowability mode we ALSO check non-`ref` parameters
  // whose declared type COULD provide the source storage for the
  // returned slice's pointer (`typeMayProvideSliceSource`):
  //   - A `Slice(T)` arg: the returned slice may point at the same
  //     storage the arg already references.
  //   - An `object` arg (ArrayList/HashMap/String/etc.): the callee
  //     may project a slice into the object's heap buffer; the buffer
  //     dies when the caller's Rc drops, so the arg must be flowable.
  //   - A plain struct/tuple/enum/array of either of the above.
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
    const needsCheck =
      p.isRef || (isSliceReturn && typeMayProvideSliceSource(p.type));
    if (!needsCheck) continue;
    const a = args[i];
    if (!a) return false;
    if (!isFlowableExpr(a, options)) return false;
  }
  return true;
}

/**
 * Collect the LOCAL VARIABLES a `ref(name) := rhs;` borrow roots in.
 *
 * Walks the same structure `isFlowableExpr` accepts (R1 names, R2
 * projections, R3 borrowing-call arguments incl. method receivers,
 * R4 cond/match arms, `&+`/`&-` bases, `unsafe(...)` interiors) and
 * returns every same-frame variable that can be the borrow's backing.
 * `ref`-bound parameters are NOT collected — their backing lives in a
 * caller frame and cannot be invalidated by anything this scope does.
 *
 * Used by the same-scope invalidation gate: while the `ref` binding is
 * live, reassigning or consuming any collected source would free or
 * replace the borrowed backing (e.g. `xs = ArrayList.new()` after
 * `ref(r) := xs.project(0)` frees the Rc buffer `r` points into).
 */
export function collectRefBorrowSources(expr: Expr): Variable[] {
  const out: Variable[] = [];
  const visit = (e: Expr): void => {
    e = unwrapBeginBlocks(e);
    if (exprIsFunctionCall(e) && exprIsFunctionCallOf(e, ":", 2)) {
      const labeledValue = (e as FnCallExpr).args[1];
      if (labeledValue) visit(labeledValue);
      return;
    }
    if (exprIsAtom(e)) {
      if (!e.$?.env || !e.$?.variableName) return;
      const vars = getVariablesFromEnv(e.$.env, e.$.variableName);
      if (vars.length === 0) return;
      const v = vars[vars.length - 1]!;
      // A ref-bound parameter's backing is caller-owned; same-scope
      // mutation cannot invalidate it. Everything else (same-frame
      // locals admitted by R1') is a collectable source.
      if (!v.isRef) out.push(v);
      return;
    }
    if (!exprIsFunctionCall(e)) return;
    const call = e as FnCallExpr;
    if (exprIsFunctionCallOf(call, BuiltinFunctions.unsafe)) {
      for (const a of call.args) visit(a);
      return;
    }
    // R2 projection: collect from the base.
    if (exprIsFunctionCallOf(call, ".", 2)) {
      const r2RecvValue = call.args[0]?.$?.value;
      if (r2RecvValue && isTypeValue(r2RecvValue)) return;
      visit(call.args[0]!);
      return;
    }
    // R4 cond/match: collect from every arm body.
    if (exprIsFunctionCallOf(call, "cond")) {
      for (const arm of call.args) {
        if (
          exprIsFunctionCall(arm) &&
          exprIsFunctionCallOf(arm as FnCallExpr, "=>", 2)
        ) {
          visit((arm as FnCallExpr).args[1]!);
        }
      }
      return;
    }
    if (exprIsFunctionCallOf(call, "match")) {
      for (let i = 1; i < call.args.length; i++) {
        const arm = call.args[i];
        if (
          arm &&
          exprIsFunctionCall(arm) &&
          exprIsFunctionCallOf(arm as FnCallExpr, "=>", 2)
        ) {
          visit((arm as FnCallExpr).args[1]!);
        }
      }
      return;
    }
    if (
      exprIsFunctionCallOf(call, "&+", 2) ||
      exprIsFunctionCallOf(call, "&-", 2)
    ) {
      visit(call.args[0]!);
      return;
    }
    // R3 borrowing call (incl. method dispatch): collect from every
    // argument that can source the borrow — `ref`-typed parameters and
    // (conservatively) any argument whose type may provide the backing
    // storage. The method receiver is the implicit first argument.
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
    if (!calleeType) return;
    const params = calleeType.parameters;
    const callArgs: Expr[] = isMethodCall
      ? [(call.func as FnCallExpr).args[0]!, ...call.args]
      : call.args;
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const a = callArgs[i];
      if (!a) continue;
      if (p.isRef || typeMayProvideSliceSource(p.type)) {
        visit(a);
      }
    }
  };
  visit(expr);
  return out;
}
