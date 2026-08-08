import type { Expr, FnCallExpr } from "../../expr";
import { BuiltinFunctions, BuiltinKeywords, exprIsAtom } from "../../expr";
import type { FunctionValue } from "../../function-value";
import type { Value } from "../../value";
import { isFunctionValue, isTypeValue, isUnknownValue } from "../../value";
import type { FunctionType, Type } from "../../types/definitions";
import { isFunctionType, isPtrType } from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { getModuleIdGeneration } from "../../utils";

/**
 * Aliasing Stage 1 — per-callee MUTATION SUMMARIES
 * (issues/borrowed-arg-invalidated-by-aliased-container-mutation.md, staged
 * decision 2026-08-06).
 *
 * Answers: "may a call to this function (transitively) mutate RC container
 * storage reachable from its parameters, captures, or globals?" A borrowed
 * RC PROJECTION argument only dangles when the callee reassigns the aliased
 * storage during the call — for the (vast) read-only majority of callees the
 * Stage-0 `+1` dup is pure overhead and is elided (`helper.ts` skips the
 * mark, or unmarks after specialization).
 *
 * The walk runs over EVALUATED bodies (macro heads are followed through
 * `$.macroExpansion`; nested callees are resolved through `func.$.value`,
 * which the evaluator stamps with the specialized FunctionValue). It is a
 * MAY-analysis: anything unresolvable or unrecognized answers "mutates".
 *
 * Sources of "may mutate":
 *   - `place = value` where the OLD value is RC-typed (reassignment drops
 *     it — the aliasing hole). Non-RC stores free nothing and are safe.
 *     Bare-atom rebinds of RC locals are flagged too (v1 conservatism: no
 *     local/global/freshness analysis).
 *   - extern callees with an `inout`/`ref` or pointer-typed parameter
 *     (allocator shims, memmove — the channels through which C code can
 *     free or reassign Yo-visible storage). Externs without such a channel
 *     run no Yo code and cannot reassign an aliased container.
 *   - io builtins (`io.await`/`io.spawn`/... yield to the event loop —
 *     other tasks run mid-call) and control functions / effect handlers
 *     (caller-side code runs mid-call).
 *   - unresolved callees: runtime closures, dyn dispatch, fn pointers.
 *
 * Cycle handling: a call edge back into a function currently being walked
 * contributes nothing (standard least-fixpoint optimism — sound because
 * every SCC member's complete body is walked exactly once from the entry
 * point). Verdicts that depended on an in-progress walk are NOT memoized
 * unless they found a real mutation ("mutates" is ground truth regardless
 * of optimism; "safe" is only final when no cycle was involved).
 *
 * A body that is missing or not yet evaluated (no `$`) answers "mutates"
 * WITHOUT memoizing — e.g. a function whose definition-time evaluation is
 * still in progress (mutual recursion) is conservatively kept dup'd at this
 * call site, and summarized properly once complete.
 */

/** funcId → may-mutate verdict (true = may mutate). */
const summaryByFuncId = new Map<string, boolean>();
/** funcIds whose bodies are currently being walked (cycle guard). */
const inProgressIds = new Set<string>();

/**
 * `funcId`s are per-module COUNTERS (`utils.ts randomId`), and the test and
 * build runners reset those counters between compilations in one process —
 * so the same id is handed out again to an unrelated function in the next
 * file. Left unguarded, this cache would answer "read-only" for a function
 * that actually mutates, eliding a borrow dup that was load-bearing. Drop
 * the memo whenever the id generation moves.
 */
let cacheGeneration = getModuleIdGeneration();
function invalidateSummariesIfIdsWereReset(): void {
  const generation = getModuleIdGeneration();
  if (generation !== cacheGeneration) {
    cacheGeneration = generation;
    summaryByFuncId.clear();
    inProgressIds.clear();
  }
}

const isDebugEnabled = !!process.env["YO_DEBUG_MUTATION_SUMMARY"];

/**
 * Builtin heads that are pure structure/control flow: walk their arguments,
 * the head itself mutates nothing. Anything NOT listed here and not
 * otherwise resolvable is treated as a mutation (conservative).
 */
const SAFE_RECURSE_HEADS: ReadonlySet<string> = new Set<string>([
  ...BuiltinKeywords.begin,
  ...BuiltinKeywords.cond,
  ...BuiltinKeywords.match,
  ...BuiltinKeywords.while,
  ...BuiltinKeywords.if,
  ...BuiltinKeywords.op_and,
  ...BuiltinKeywords.op_or,
  ...BuiltinKeywords.return,
  ...BuiltinKeywords.break,
  ...BuiltinKeywords.continue,
  ...BuiltinKeywords.clone,
  ...BuiltinKeywords.unwind,
  ...BuiltinKeywords.recur,
  ...BuiltinKeywords.dyn,
  ...BuiltinKeywords.runtime,
  ...BuiltinKeywords.quote,
  ...BuiltinFunctions.consume,
  ...BuiltinFunctions.the,
  ...BuiltinFunctions.as,
  // Property access and cond/match arm arrows (fn-defining arrows are
  // excluded earlier via $.isAnonymousFunctionDefinition).
  ".",
  "=>",
  "->",
  // Aggregate literals.
  "tuple",
  "array",
  // Explicit RC ops on callee-owned handles: an increment is always safe;
  // a decrement only frees storage nothing else references (a live borrow
  // is backed by the container's own counted reference).
  ...BuiltinFunctions.___dup,
  ...BuiltinFunctions.___drop,
  // The audit wrapper — the wrapped call is analyzed normally.
  ...BuiltinFunctions.unsafe,
]);

/**
 * Primitive builtin heads that are pure computations, reads, comptime-only
 * reflection, or process aborts — they cannot reassign or free Yo-visible
 * RC storage. These appear as bare heads with no resolvable FunctionValue
 * (dedicated evaluator/codegen paths). Deliberately NOT here: __yo_ptr_set,
 * __yo_array_fill (stores), __yo_drop_array_element / __yo_drop_tuple_element
 * (drop a CONTAINER-held reference — exactly the aliasing hole), the
 * random/buffer writers, __yo_iso_* (mutate Iso state), __yo_gc_collect.
 */
const PURE_BUILTIN_HEAD_PREFIXES = [
  "__yo_op_", // runtime primitive arithmetic/comparison/bitwise
  "__yo_comptime_", // CTFE helpers
  "__yo_expr_", // comptime AST reflection
  "__yo_var_", // comptime variable introspection
  "__yo_type_", // comptime type iteration
] as const;

const PURE_BUILTIN_HEADS: ReadonlySet<string> = new Set<string>([
  // Pure runtime cast (pointer/type reinterpretation).
  ...BuiltinFunctions.__yo_as,
  ...BuiltinFunctions.__yo_ptr_add,
  ...BuiltinFunctions.__yo_ptr_sub,
  ...BuiltinFunctions.__yo_ptr_diff,
  ...BuiltinFunctions.__yo_ptr_eq,
  ...BuiltinFunctions.__yo_ptr_neq,
  ...BuiltinFunctions.__yo_ptr_lt,
  ...BuiltinFunctions.__yo_ptr_lte,
  ...BuiltinFunctions.__yo_ptr_gt,
  ...BuiltinFunctions.__yo_ptr_gte,
  ...BuiltinFunctions.__yo_ptr_deref,
  ...BuiltinFunctions.__yo_str_from_raw_parts,
  ...BuiltinFunctions.__yo_str_len,
  ...BuiltinFunctions.__yo_str_ptr,
  ...BuiltinFunctions.__yo_str_byte,
  ...BuiltinFunctions.__yo_array_index,
  // Aborts the process — nothing executes afterwards, so no borrow can be
  // used after it (this keeps assert/bounds-check paths read-only).
  ...BuiltinFunctions.__yo_panic,
  BuiltinFunctions.rc,
  ...BuiltinFunctions.sizeof,
  ...BuiltinFunctions.alignof,
  ...BuiltinFunctions.typeid,
  ...BuiltinFunctions.typeof,
  ...BuiltinFunctions.downcast,
  ...BuiltinFunctions.__yo_noop,
  ...BuiltinFunctions.__yo_return_self,
  ...BuiltinFunctions.__yo_borrow_assert_unborrowed,
  ...BuiltinFunctions.__yo_incr_rc,
  ...BuiltinFunctions.__yo_decr_rc,
  ...BuiltinFunctions.__yo_rc_own,
  ...BuiltinFunctions.__yo_dyn_dup,
  ...BuiltinFunctions.__yo_dyn_drop,
  ...BuiltinFunctions.__yo_sometype_dup,
  ...BuiltinFunctions.__yo_sometype_drop,
  ...BuiltinFunctions.__yo_dup_array_element,
  ...BuiltinFunctions.__yo_dup_tuple_element,
  ...BuiltinFunctions.___dispose,
]);

function isPureBuiltinHead(head: string): boolean {
  if (PURE_BUILTIN_HEADS.has(head)) {
    return true;
  }
  for (const prefix of PURE_BUILTIN_HEAD_PREFIXES) {
    if (head.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Public entry: may `fv` (transitively) mutate RC container storage
 * reachable from its parameters, captures, or globals?
 */
export function functionMayMutateRcStorage(fv: FunctionValue): boolean {
  invalidateSummariesIfIdsWereReset();
  const touched = new Set<string>();
  const reason = summaryFor(fv, touched);
  if (isDebugEnabled) {
    // eslint-disable-next-line no-console
    console.log(
      `[mutation-summary] ${fv.funcName ?? fv.funcId}: ${
        reason ? `MUTATES (${reason})` : "read-only"
      }`
    );
  }
  return reason !== undefined;
}

/**
 * Returns a human-readable reason when `fv` may mutate, undefined when it
 * is read-only. `touched` accumulates in-progress funcIds this verdict
 * depended on (poisons "safe" memoization).
 */
function summaryFor(
  fv: FunctionValue,
  touched: Set<string>
): string | undefined {
  const id = fv.funcId;
  const cached = summaryByFuncId.get(id);
  if (cached !== undefined) {
    return cached ? "memoized" : undefined;
  }
  if (inProgressIds.has(id)) {
    touched.add(id);
    return undefined;
  }
  const body = fv.body;
  if (!body || !body.$) {
    // Unevaluated body (generic original / definition in progress):
    // conservative, and NOT memoized — it may be summarizable later.
    return "body not evaluated";
  }
  inProgressIds.add(id);
  const localTouched = new Set<string>();
  let reason: string | undefined;
  try {
    reason = walkExpr(body, localTouched);
  } finally {
    inProgressIds.delete(id);
  }
  localTouched.delete(id);
  if (reason !== undefined) {
    summaryByFuncId.set(id, true);
  } else if (localTouched.size === 0) {
    summaryByFuncId.set(id, false);
  }
  for (const t of localTouched) {
    touched.add(t);
  }
  return reason;
}

function headAtomName(fn: FnCallExpr): string | undefined {
  return exprIsAtom(fn.func) ? fn.func.token.value : undefined;
}

function walkExprs(
  exprs: readonly (Expr | undefined)[],
  touched: Set<string>
): string | undefined {
  for (const e of exprs) {
    const r = walkExpr(e, touched);
    if (r !== undefined) {
      return r;
    }
  }
  return undefined;
}

function walkExpr(
  expr: Expr | undefined,
  touched: Set<string>
): string | undefined {
  if (!expr) {
    return undefined;
  }
  const info = expr.$;
  // A macro call's raw arguments are not what executes — the expansion is.
  if (info?.macroExpansion) {
    return walkExpr(info.macroExpansion, touched);
  }
  // A cond/match arm the evaluator proved unexecuted is never emitted.
  if (info?.caseExecuted === false) {
    return undefined;
  }
  // A function/closure DEFINITION does not run its body here; any call of
  // it is analyzed at the call site (resolved callee or conservative).
  if (info?.isAnonymousFunctionDefinition || info?.closureFunctionValue) {
    return undefined;
  }
  if (exprIsAtom(expr)) {
    return undefined;
  }

  const fn = expr as FnCallExpr;
  const head = headAtomName(fn);

  // Assignment: the aliasing hole is a store that DROPS an RC-typed old
  // value. Non-RC stores free nothing; their place/value computations may
  // still call things, so recurse both sides.
  if (head === "=" && fn.args.length === 2) {
    const lhs = fn.args[0]!;
    if (!lhs.$?.type) {
      return "assignment with untyped LHS";
    }
    if (typeContainsRcType(lhs.$.type)) {
      return `assignment to RC-typed place \`${lhs.$?.variableName ?? "?"}\``;
    }
    return walkExprs(fn.args, touched);
  }
  // Declarations create a fresh local — only the initializer runs.
  if ((head === ":=" || head === "::") && fn.args.length === 2) {
    return walkExpr(fn.args[1], touched);
  }
  // match arms are `pattern => body`: the pattern side binds, it never
  // executes runtime calls (Yo has no match guards), and its variant
  // constructors (`.Some(x)`) have no resolvable callee — walking it would
  // flag a false "unresolved callee". Walk the scrutinee and arm BODIES.
  if (
    head !== undefined &&
    (BuiltinKeywords.match as readonly string[]).includes(head)
  ) {
    const r = walkExpr(fn.args[0], touched);
    if (r !== undefined) {
      return r;
    }
    for (let i = 1; i < fn.args.length; i++) {
      const arm = fn.args[i]!;
      if (arm.$?.caseExecuted === false) {
        continue;
      }
      if (
        !exprIsAtom(arm) &&
        exprIsAtom((arm as FnCallExpr).func) &&
        ((arm as FnCallExpr).func.token.value === "=>" ||
          (arm as FnCallExpr).func.token.value === "->") &&
        (arm as FnCallExpr).args.length === 2
      ) {
        const rb = walkExpr((arm as FnCallExpr).args[1], touched);
        if (rb !== undefined) {
          return rb;
        }
      } else {
        const ra = walkExpr(arm, touched);
        if (ra !== undefined) {
          return ra;
        }
      }
    }
    return undefined;
  }
  if (head !== undefined && SAFE_RECURSE_HEADS.has(head)) {
    return walkExprs(fn.args, touched);
  }

  // A compile-time-known result is inlined by codegen — the call never runs
  // at runtime, so nothing inside it can mutate.
  //
  // This MUST stay BELOW the structural forms above. A declaration
  // (`t := f(x)`) carries a compile-time value of its own, and every
  // statement-shaped expression is unit-typed — neither means "this was
  // folded away". Checking here first made the walk skip the declaration
  // whole, never visit the mutating call on its right-hand side, and report
  // a mutating function as read-only: a real use-after-free (the borrowed
  // projection read recycled memory, returning 2 instead of 42).
  if (info?.value && !isUnknownValue(info.value)) {
    return undefined;
  }

  // General call: classify the callee.
  let calleeVal: unknown = fn.func.$?.value;
  if (Array.isArray(calleeVal)) {
    calleeVal = calleeVal[0];
  }
  const calleeValue = calleeVal as Value | undefined;

  if (calleeValue && isTypeValue(calleeValue)) {
    // Type application: a cast or a struct/enum construction — allocates a
    // fresh value, mutates nothing pre-existing.
    const r = walkExpr(fn.func, touched);
    if (r !== undefined) {
      return r;
    }
    return walkExprs(fn.args, touched);
  }

  if (calleeValue && isFunctionValue(calleeValue)) {
    const callee = calleeValue;
    const calleeType: FunctionType | undefined = isFunctionType(
      callee.specializedType ?? callee.type
    )
      ? (callee.specializedType ?? callee.type)
      : undefined;
    if (!calleeType) {
      return "callee without function type";
    }
    if (calleeType.ioBuiltin) {
      // Yields to the event loop — other tasks run mid-call.
      return `io builtin ${calleeType.ioBuiltin}`;
    }
    if (callee.isControlFunction) {
      // Effect handler / ctl body — caller-side code runs mid-call, and
      // handler bodies may be deferred (not summarizable).
      return `ctl function ${callee.funcName ?? callee.funcId}`;
    }
    if (calleeType.externName) {
      const externReason = externMayMutate(calleeType);
      if (externReason !== undefined) {
        return externReason;
      }
    } else {
      const calleeReason = summaryFor(callee, touched);
      if (calleeReason !== undefined) {
        return `callee ${callee.funcName ?? callee.funcId} → ${calleeReason}`;
      }
    }
    const r = walkExpr(fn.func, touched);
    if (r !== undefined) {
      return r;
    }
    return walkExprs(fn.args, touched);
  }

  // Primitive builtins with dedicated evaluator paths (no resolvable
  // FunctionValue): pure computations, reads, and aborts are safe.
  if (head !== undefined && isPureBuiltinHead(head)) {
    return walkExprs(fn.args, touched);
  }

  // Callee value unresolved but the callee TYPE is stamped: extern C
  // declarations (memcmp, printf) resolve this way.
  const calleeTypeOnly = fn.func.$?.type;
  if (
    calleeTypeOnly &&
    isFunctionType(calleeTypeOnly) &&
    calleeTypeOnly.externName
  ) {
    if (calleeTypeOnly.ioBuiltin) {
      return `io builtin ${calleeTypeOnly.ioBuiltin}`;
    }
    const externReason = externMayMutate(calleeTypeOnly);
    if (externReason !== undefined) {
      return externReason;
    }
    const r = walkExpr(fn.func, touched);
    if (r !== undefined) {
      return r;
    }
    return walkExprs(fn.args, touched);
  }

  // Unresolved callee: runtime closure, dyn dispatch, fn pointer, ctl
  // parameter — arbitrary code may run.
  return `unresolved callee \`${head ?? "(expr)"}\``;
}

/**
 * Extern non-runtime C names that free memory Yo values may live in.
 * The runtime/allocator family is `__yo_`-prefixed (caught by the prefix
 * rule); these cover direct libc bindings.
 */
const FREEING_EXTERN_NAMES: ReadonlySet<string> = new Set<string>([
  "free",
  "realloc",
  "reallocf",
  "aligned_alloc_free",
]);

function typeIsFunctionLike(t: Type | undefined): boolean {
  if (!t) {
    return false;
  }
  if (isFunctionType(t)) {
    return true;
  }
  if (isPtrType(t) && isFunctionType(t.childType)) {
    return true;
  }
  return false;
}

/**
 * An extern runs no Yo code, and C code outside the Yo runtime never
 * manipulates RC counts — a borrow only dangles when its box is FREED, and
 * frees of RC storage come exclusively from (a) the runtime/allocator
 * family (all `__yo_`-prefixed externs), (b) direct libc free/realloc
 * bindings, or (c) callback parameters re-entering Yo code (qsort-style).
 * Everything else — memcmp, printf, snprintf, libc math — performs at most
 * raw byte reads/writes, which cannot decrement a reference count and
 * therefore cannot invalidate an RC borrow.
 */
function externMayMutate(ft: FunctionType): string | undefined {
  const name = ft.externName!;
  // Runtime helpers that are explicitly known pure (rc reads, ptr math,
  // str views) stay safe even when they resolve as extern FunctionValues.
  if (isPureBuiltinHead(name)) {
    return undefined;
  }
  if (name.startsWith("__yo_")) {
    return `runtime extern ${name}`;
  }
  if (FREEING_EXTERN_NAMES.has(name)) {
    return `freeing extern ${name}`;
  }
  for (const p of ft.parameters) {
    if (typeIsFunctionLike(p.type)) {
      return `extern ${name}: callback param \`${p.label}\``;
    }
  }
  const vp = ft.variadicParameter;
  if (vp && typeIsFunctionLike(vp.type)) {
    return `extern ${name}: callback variadic param`;
  }
  return undefined;
}
