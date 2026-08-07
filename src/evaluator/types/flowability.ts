/**
 * Flowability check for `ref(T)`-yielding expressions.
 *
 * Implements the structural soundness rule from `plans/archive/ITERATOR_REDESIGN.md`:
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
  exprToString,
  hasAnyControlFlow,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import { formatErrorMessage } from "../../error";
import { type Token, TokenType } from "../../token";
import type { FunctionType } from "../../types/definitions";
import {
  isAtomicReferenceStructType,
  isFunctionType,
  isPtrType,
  isReferenceStructType,
  isSomeType,
} from "../../types/guards";
import {
  typeContainsRcType,
  typeMayProvideSliceSource,
  typeRepresentationContainsRawPtr,
} from "../../types/utils";
import { isFunctionValue, isTypeValue } from "../../value";
import {
  type Environment,
  getVariablesFromEnv,
  type Variable,
} from "../../env";

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
 *    (`plans/archive/SLICE_FLOWABILITY.md`). Accepts a name reference whose
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
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_panic)
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
  // plans/archive/ITERATOR_REDESIGN.md and plans/MEMORY_SAFETY.md.
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
    // call. See plans/archive/SLICE_FLOWABILITY.md Phase B.
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

  // Pointer arithmetic: `base.add(offset)` / `base.sub(offset)` (only
  // legal in `pragma(Pragma.AllowUnsafe)` files; formerly the `&+`/`&-`
  // operators — plans/archive/POINTER_OPERATORS_TO_TRAITS_AND_METHODS.md) yields a
  // pointer into the SAME storage as `base`, displaced by an integer
  // index. The result is flowable iff the base pointer is flowable — the
  // offset is a plain integer and introduces no new storage root. Without
  // this, an assignment like `result = .Some(data_ptr.add(i))` in a
  // hand-written unsafe iterator (e.g. std/collections/hash_map.yo) is
  // wrongly rejected even though `data_ptr` roots back to a `ref(self)`
  // field. GATED on the receiver's evaluated type being a raw pointer —
  // `add`/`sub` are ordinary method names on other types, and those calls
  // return fresh values (not flowable through the receiver). The direct
  // builtin forms (`__yo_ptr_add`/`__yo_ptr_sub`) keep the old
  // positional-arg rule.
  if (
    exprIsFunctionCallOf(call, BuiltinFunctions.__yo_ptr_add) ||
    exprIsFunctionCallOf(call, BuiltinFunctions.__yo_ptr_sub)
  ) {
    return isFlowableExpr(call.args[0]!, options);
  }
  if (
    exprIsFunctionCall(call.func) &&
    exprIsFunctionCallOf(call.func, ".", 2) &&
    call.args.length === 1
  ) {
    const recv = (call.func as FnCallExpr).args[0]!;
    const member = (call.func as FnCallExpr).args[1]!;
    const memberName = exprIsAtom(member) ? member.token.value : "";
    if (
      (memberName === "add" || memberName === "sub") &&
      recv.$?.type &&
      isPtrType(recv.$.type)
    ) {
      return isFlowableExpr(recv, options);
    }
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
  const isTypeCtorCall = !!call.func.$?.value && isTypeValue(call.func.$.value);
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
 * Resolve the alias-group ROOT of a variable: follow
 * `isOwningTheSameRcValueAs` links to the primary owner (with a cycle
 * guard). Two variables alias the same RC object iff their roots are the
 * same variable.
 */
export function aliasGroupRoot(variable: Variable): Variable {
  let cur = variable;
  const seen = new Set<Variable>();
  while (cur.isOwningTheSameRcValueAs && !seen.has(cur)) {
    seen.add(cur);
    cur = cur.isOwningTheSameRcValueAs;
  }
  return cur;
}

/**
 * Walk a property-access chain (`h.s`, `a.b.c`) to its base atom.
 * Returns the atom expr, or undefined when the chain roots in a
 * non-atom (a call result, a literal, ...).
 */
export function findPropertyChainRootAtom(expr: Expr): Expr | undefined {
  let current = expr;
  while (exprIsFunctionCall(current) && exprIsFunctionCallOf(current, ".", 2)) {
    current = (current as FnCallExpr).args[0]!;
  }
  return exprIsAtom(current) ? current : undefined;
}

/**
 * Call-site ref/own exclusivity (v4, plans/archive/BORROW_EXCLUSIVITY.md):
 * within ONE call, an argument bound to an `own(...)` parameter must
 * not be (or alias) the root of another argument bound to a `ref(...)`
 * parameter. `f(h.s, h)` with `f :: fn(ref(x) : String, own(victim) :
 * Holder)` moves the caller's count into the callee, which can release
 * it (e.g. by forwarding `victim` to another own-consuming call) while
 * `x` still points into the object — a use-after-free no same-scope
 * gate can see. Non-`own` (by-value) overlap is safe: a borrowed
 * handle's chain can never release the caller's count (passing it
 * onward to an `own` position dups first).
 */
export function requireRefOwnArgumentExclusivity({
  parameters,
  argExprs,
  env,
}: {
  parameters: { label: string; isRef?: boolean; isOwningTheRcValue: boolean }[];
  argExprs: Expr[];
  env: Environment;
}): void {
  const refRoots: { index: number; label: string; variable: Variable }[] = [];
  const ownRoots: {
    index: number;
    label: string;
    variable: Variable;
    token: Token;
  }[] = [];
  for (let i = 0; i < parameters.length && i < argExprs.length; i++) {
    const parameter = parameters[i]!;
    const argExpr = argExprs[i]!;
    if (argExpr.token.modulePath.startsWith("auto-generated://")) continue;
    if (!parameter.isRef && !parameter.isOwningTheRcValue) continue;
    // For Index-trait calls (xs(i)), extract the container atom from the
    // call's func expression. findPropertyChainRootAtom only walks .-chains
    // and would skip these, causing the ref/own exclusivity check to miss
    // overlaps like f(xs(0), xs).
    let rootAtom: Expr | undefined;
    if (argExpr.$?.indexTraitPtrType && exprIsFunctionCall(argExpr)) {
      rootAtom = findPropertyChainRootAtom((argExpr as FnCallExpr).func);
    } else {
      rootAtom = findPropertyChainRootAtom(argExpr);
    }
    if (!rootAtom) continue;
    const rootEnv = rootAtom.$?.env ?? env;
    const vars = getVariablesFromEnv(rootEnv, rootAtom.token.value);
    const variable = vars[vars.length - 1];
    if (!variable) continue;
    if (parameter.isRef) {
      refRoots.push({ index: i, label: parameter.label, variable });
    } else {
      ownRoots.push({
        index: i,
        label: parameter.label,
        variable,
        token: argExpr.token,
      });
    }
  }
  for (const own of ownRoots) {
    for (const ref of refRoots) {
      if (ref.index === own.index) continue;
      if (aliasGroupRoot(ref.variable) !== aliasGroupRoot(own.variable))
        continue;
      throw formatErrorMessage({
        token: own.token,
        errorMessage: `Cannot pass "${own.variable.name}" to the own parameter "${own.label}" in the same call where argument ${
          ref.index + 1
        } borrows from it (bound to the ref parameter "${ref.label}") — the callee takes ownership and may drop the object while the borrow is still in use. Copy the value out instead, or split the calls.`,
      });
    }
  }
}

/**
 * v4.1 (plans/archive/BORROW_EXCLUSIVITY.md): validate the PLACE passed to each
 * `ref` parameter. With local ref bindings removed, every borrow is an
 * argument lvalue evaluated at the call boundary; it is safe iff the
 * borrowed storage cannot be freed during the call:
 *
 *  - a whole VARIABLE (any scope) → its slot is stable storage; OK.
 *  - a field chain rooted at a LOCAL/PARAM variable with no
 *    intermediate OBJECT hop → the place lives in the root's
 *    allocation, kept alive by the caller's handle (own-overlap in the
 *    same call is rejected by requireRefOwnArgumentExclusivity); OK.
 *  - an intermediate OBJECT hop (`a.b.s` where `b` is an object field)
 *    → `b`'s handle lives in a mutable slot that a callee may be able
 *    to reach and replace, freeing the borrowed allocation; REJECTED
 *    (bind the object to a local first — the local handle keeps it
 *    alive).
 *  - a field chain rooted at a MODULE-LEVEL variable → any callee can
 *    reassign the global and free the object; REJECTED (bind to a
 *    local first).
 *
 * Call AFTER argument evaluation (the chain types must be resolved).
 */
export function requireValidRefArgumentPlaces({
  parameters,
  argExprs,
  env,
}: {
  parameters: {
    label: string;
    isRef?: boolean;
    isCompileTimeOnly: boolean;
  }[];
  argExprs: Expr[];
  env: Environment;
}): void {
  // A ref argument's place may live inside a CONTAINER's allocation: an
  // indexed element lives in the container's heap buffer, and a `box.*`
  // deref points into the boxed object. Such a place dangles if the
  // callee can reach the container and free/realloc it DURING the call.
  // The callee can reach it only when the container (or an alias) is
  // also an argument, or the container is module-level. Element-only
  // uses (the container is not otherwise reachable) are safe — the
  // callee holds only the inner pointer and has nothing to free it
  // with. `refArgExpr`/`refArgIndex` identify the ref argument under
  // scrutiny; `containerAtom` is the reachable container; `kind`
  // tailors the message.
  const rejectIfContainerReachable = (
    containerAtom: Expr,
    refArgExpr: Expr,
    refArgIndex: number,
    kind: "index" | "object-hop"
  ): void => {
    if (!exprIsAtom(containerAtom)) return;
    if (containerAtom.token.type !== TokenType.Identifier) return;
    const containerEnv = containerAtom.$?.env ?? env;
    const containerVars = getVariablesFromEnv(
      containerEnv,
      containerAtom.token.value
    );
    const containerVar = containerVars[containerVars.length - 1];
    if (!containerVar) return;
    const containerName = containerAtom.token.value;
    const fix =
      kind === "index"
        ? `Copy the element out with ".get(i)" first, or split the calls.`
        : `Bind the intermediate object to a local first ("b := …;") and pass a field of "b" instead, or split the calls.`;
    // (a) The container is reachable GLOBALLY — module-level itself, or
    // aliased to a module-level variable (`g = xs` then `f(xs(i), ...)`).
    // Any callee can name a global and grow it.
    const containerRoot = aliasGroupRoot(containerVar);
    if (containerVar.isModuleLevel || containerRoot.isModuleLevel) {
      throw formatErrorMessage({
        token: refArgExpr.token,
        errorMessage: `A 'ref' argument ("${exprToString(
          refArgExpr
        )}") borrows into the module-level container "${containerName}" — any callee could reach it and free/reallocate the storage the reference points into. ${fix}`,
      });
    }
    // (b) An ELEMENT-ONLY call is the only safe shape: every OTHER
    // argument must be incapable of holding a handle to the container.
    // A value/scalar arg cannot; an object, a closure (which may have
    // captured the container — escape analysis we deliberately avoid),
    // or any pointer-carrier COULD reach it and grow/realloc the buffer
    // the reference points into. This is conservative by design — it
    // can reject calls whose other object argument happens to be
    // unrelated — but it is sound without whole-program escape
    // analysis, and the common cases (`to_string(xs(i))`, `${xs(i)}`,
    // `bump(xs(i))`, scalar companions) pass because they have no
    // container-capable other argument.
    for (let j = 0; j < argExprs.length && j < parameters.length; j++) {
      if (j === refArgIndex) continue;
      const otherExpr = argExprs[j]!;
      const isClosure = otherExpr.$?.closureFunctionValue !== undefined;
      const otherType = otherExpr.$?.type;
      const couldReach =
        isClosure ||
        (otherType !== undefined &&
          (typeContainsRcType(otherType) ||
            typeRepresentationContainsRawPtr(otherType)));
      if (couldReach) {
        throw formatErrorMessage({
          token: refArgExpr.token,
          errorMessage: `A 'ref' argument ("${exprToString(
            refArgExpr
          )}") borrows into the container "${containerName}", but argument ${
            j + 1
          } of the same call could hold a handle to "${containerName}" and grow it, reallocating the buffer the reference points into. ${fix}`,
        });
      }
    }
  };

  for (let i = 0; i < parameters.length && i < argExprs.length; i++) {
    const parameter = parameters[i]!;
    if (!parameter.isRef || parameter.isCompileTimeOnly) continue;
    const argExpr = argExprs[i]!;
    if (argExpr.token.modulePath.startsWith("auto-generated://")) continue;
    // `xs(i)` via the Index trait yields a raw `*(T)` into the
    // container's heap buffer; binding it to a `ref` parameter keeps
    // the pointer for the call. Reject when the container is reachable.
    if (argExpr.$?.indexTraitPtrType && exprIsFunctionCall(argExpr)) {
      const containerAtom = findPropertyChainRootAtom(
        (argExpr as FnCallExpr).func
      );
      if (containerAtom) {
        rejectIfContainerReachable(containerAtom, argExpr, i, "index");
      }
      continue;
    }
    if (!exprIsFunctionCall(argExpr) || !exprIsFunctionCallOf(argExpr, ".", 2))
      continue;
    // Walk the field chain outermost-in: hops[0] = the full place,
    // hops[k] = its base chains, root = the innermost base.
    const hops: Expr[] = [];
    let cur: Expr = argExpr;
    while (exprIsFunctionCall(cur) && exprIsFunctionCallOf(cur, ".", 2)) {
      hops.push(cur);
      cur = (cur as FnCallExpr).args[0]!;
    }
    // Namespace-style access (Type.member) is not a borrow — skip when
    // the root resolves to a type value.
    if (cur.$?.value && isTypeValue(cur.$.value)) continue;
    // An INTERMEDIATE object-field hop (`a.objField.x`, and equally
    // `box.*.x` — `Box` is an ordinary object whose deref `*` is just a
    // field, so it needs no special-casing) borrows into a heap object
    // whose handle lives in a slot. A callee can free that object by
    // reassigning the slot — but only if it can REACH the chain root to
    // do so. So this is the same reachability question as the index
    // case: reject iff the root is reachable (module-level/global-alias,
    // or any other argument could hold a handle to it). Element-only
    // chains rooted in an unescaped local (`owner_box.*.id.clone()`,
    // `grow(w.inner.n)`) stay legal — nothing the callee holds can free
    // the intermediate object.
    let hasObjectHop = false;
    for (let h = 1; h < hops.length; h++) {
      const rawType = hops[h]!.$?.type;
      const hopType =
        rawType && isSomeType(rawType) && rawType.resolvedConcreteType
          ? rawType.resolvedConcreteType
          : rawType;
      if (
        hopType &&
        (isReferenceStructType(hopType) || isAtomicReferenceStructType(hopType))
      ) {
        hasObjectHop = true;
        break;
      }
    }
    if (hasObjectHop && exprIsAtom(cur)) {
      rejectIfContainerReachable(cur, argExpr, i, "object-hop");
    }
    // A field of a MODULE-LEVEL root is unsafe when overwriting it
    // through the ref could free heap storage:
    //   - OBJECT roots (`g_obj.field`): the callee can reassign the
    //     global object and free the allocation the reference points into.
    //   - Non-object roots whose ref'd element type contains an Rc type
    //     (e.g. a tuple field `GLOBAL_TUPLE.0` holding an ArrayList):
    //     overwriting the Rc handle through the ref drops the old value.
    // (A module-level VALUE struct/field of non-Rc type lives in fixed
    // static storage — those are not rejected here.)
    if (
      !hasObjectHop &&
      exprIsAtom(cur) &&
      cur.token.type === TokenType.Identifier
    ) {
      const rootEnv = cur.$?.env ?? env;
      const rootVars = getVariablesFromEnv(rootEnv, cur.token.value);
      const rootVar = rootVars[rootVars.length - 1];
      const rootType = rootVar?.type;
      const rootIsObject =
        rootType !== undefined &&
        (isReferenceStructType(rootType) ||
          isAtomicReferenceStructType(rootType));
      const refArgType = argExprs[i]?.$?.type;
      const refTypeContainsRc =
        refArgType !== undefined && typeContainsRcType(refArgType);
      if (rootVar?.isModuleLevel && (rootIsObject || refTypeContainsRc)) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `A 'ref' argument cannot borrow a field of the module-level object "${cur.token.value}" — a callee could reassign it and free the borrowed storage. Bind it to a local first:\n  h := ${cur.token.value};\nand pass the field of "h" instead.`,
        });
      }
    }
  }
}
