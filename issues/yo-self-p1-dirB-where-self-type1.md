# P1 dominant cluster — `where(T<:Trait)` + `-> Self` generic method → `Type(1)`

Status: **OPEN, strongly narrowed** (root not yet located; 3 instrumentation rounds
ruled out the obvious sites). This is the single largest remaining P1 self-host-fixpoint
marker cluster after Direction A landed (445→444).

## Summary

In the full `yo-self/main.yo` self-compile, **16-22 of the 51 def-time-eval root throws**
(of 444 markers) are one error category: `Type mismatch for type member "<X>"` with
**`Got: Type(1)`** (`= TypeUni(1)`, the type-of-types meta-type — printed only by
`yo-self/types/string.yo:59-62`, NEVER by a SomeT placeholder). Thrown at
`yo-self/evaluator/calls/type.yo:275` (`are_types_compatible(arg_type, member_element.ty)`
during STRUCT/VARIANT construction). The failing argument expression evaluated to
`Type(1)` instead of a runtime value.

Failing-expr clustering (from the improved [TTERR] map, the Direction-A measurement run):
- ~16: `std/collections/hash_map.yo:82` / `hash_set.yo:74` — the `Self(... data : .Some(data_ptr) ...)`
  constructor inside `_alloc_with_capacity`. `.Some(data_ptr)` is `Option(*(Bucket(K,V))).Some(value: data_ptr)`;
  the `value` member gets `Type(1)`.
- A few: `yo-self/parser.yo:982` (`array_list(arg, arg_copy)` in `.FnCall(...)`), `parser.yo:1392`
  (`array_list(str_atom)`), `types/definitions.yo:362` (`TypeValue.Tuple(labels.clone(), types.clone())`
  in the manual `impl(TypeValue, Clone)`).

## CRITICAL: the `with_capacity` / `Bucket(K,V)` premise is DISPROVEN

The first theory (from §3 of `plans/RECURSIVE_TYPE_REPRESENTATION.md` and a root-cause
workflow) was that `*(Bucket(K,V))(data_void_ptr)` (hash_map.yo:76) degenerates the
pointer-cast to `Type(1)`. **A faithful standalone repro of that exact cast compiles
cleanly in BOTH the TS compiler and yo-self** (yo-self even emits `((Bucket*)(...))`).
The cast is NOT the bug. The `Self(...)` failure is downstream: the `data` field's
`.Some(data_ptr)` value is `Type(1)` for a different reason — see the real trigger.

## The REAL trigger (empirically bisected, minimal repro)

Minimal reproducer (reproduces `Got: Type(1)` in yo-self in **seconds**; compiles clean in TS):

```rust
open(import("std/string"));
MyList :: (fn(comptime(T) : Type) -> comptime(Type))( object(head : Option(T)) );
impl(
  forall(T : Type), where(T <: Clone), MyList(T),
  clone_list : (fn(ref(self) : Self) -> Self)( Self(head : self.head.clone()) )
);
MyTypeD :: enum( Unit, Wrap(items : MyList(Self)), Leaf(n : i32) );
impl(
  MyTypeD,
  Clone( clone : (fn(ref(self) : Self) -> Self)(
    match(self, .Unit => MyTypeD.Unit, .Leaf(n) => MyTypeD.Leaf(n),
          .Wrap(items) => MyTypeD.Wrap(items.clone_list())) ) )
);
main :: (fn() -> unit)({ v := MyTypeD.Leaf(3); w := v.clone(); () });
export(main);
```
→ `[TTERR] ...:32 Type mismatch for type member "items": Expected: <struct:...> Got: Type(1)`
at `.Wrap(items) => MyTypeD.Wrap(items.clone_list())`.

Bisection — the trigger is the **conjunction** (necessary AND sufficient):
| Variant | Change | Result |
|---|---|---|
| (real) | manual Clone of a recursive enum with `ArrayList(Self)`/`MyList(Self)` field | **REPRODUCES** |
| A | pattern-bound value passed WITHOUT `.clone()` | clean |
| B | non-recursive element (`ArrayList(i32).clone()`) | clean |
| C | `Box(Self).clone()` (recursive, simple/structural clone, no `where`) | clean |
| **D** | custom `MyList(T)` with **`where(T <: Clone)`**, method returns **`Self`**, field `MyList(Self)` | **REPRODUCES** |
| E | D but **remove `where(T <: Clone)`** | clean |
| F | D but method returns **`usize`** instead of `Self` (keeps `where`) | clean |

So: **(i)** a generic instance method with a **`where(T <: Trait)`** clause, **(ii)** whose
**return type is `Self`** (the generic container `MyList(T)` itself), **(iii)** dispatched on a
receiver `MyList(X)` where **`X` is a recursive enum's self-shell**, **(iv)** during def-time
body eval. F (usize return) proves the `where` constraint check PASSES and dispatch succeeds —
the bug is purely the **return-type/result computation** for a `Self`-returning where-method.

## Hypotheses RULED OUT (do not re-try)

1. **`with_capacity` / `Bucket(K,V)` / `*(T)(ptr)` cast** — disproven (compiles clean both compilers).
2. **`-> Self` evaluated to `Type(1)` at impl REGISTRATION** — instrumented the return-type eval
   in `evaluate_function_type` (function.yo:3477-3495, `[DBG-RETREG]` probe on `ret_type_val`
   being `TypeUni`): for the repro, **`retexpr=Self` NEVER fired** (only legit `-> Trait`/`-> Type`
   type-returning fns fired). Registration stores `-> Self` correctly.
3. **`_resolve_some_types_deep`** (function.yo:3801, the call-time return-type resolution
   chokepoint that both helper.yo:1506/1109/2620 and function.yo:1040 funnel through):
   instrumented to print non-`TypeUni`→`TypeUni` collapse — **never fired** for the repro.
   (NB it early-returns at function.yo:3808 for SomeT-free inputs, so an already-`Type(1)`
   input would be missed — but combined with #2, the func result is NOT already `Type(1)`.)
4. **helper.yo:1506** (`create_specialized_function_inline`'s func-TYPE registration return) —
   patched it with the function.yo:998-1028 name-keyed forall substitution; **INERT** (repro
   still failed). Likely because `arg_values.forall_args` is EMPTY for an INFERRED-forall method
   call (`items.clone_list()`, T inferred from the receiver, not supplied), so the subst didn't fire.
5. **function.yo:997-1040** (the create_specialized FuncVal-arm `resolved_ret` path) — would set
   `out_rt` (function.yo:1041) = `MyList(self_shell)` (correct), so this path is NOT taken for the repro.

## Where to look next (narrowed)

The `Type(1)` is produced in a **return-type/result computation specific to where-constrained,
`Self`-returning generic-impl instance methods** that is NEITHER the registration eval NOR
`_resolve_some_types_deep` NOR the two helper.yo specialization sites already checked. Candidates:
- The generic-impl instance-method DISPATCH result computation (property-access method resolution
  for generic impls → `try_match_generic_impl` / the funcId-keyed path, [[yo-self-phase3-generic-impl-funcid]]).
- A `where`-clause-driven specialization branch that recomputes the result type (the `where` clause
  is the gate — find the code path that ONLY runs when `where_types` is non-empty and recomputes
  or re-instantiates the `Self`/`MyList(T)` return).
- `substitute` (types/substitution.yo:93) re-instantiating a stored `MyList(SomeT)` →
  re-evaluating the `MyList` comptime-fn-call → `Type(1)` (the comptime-fn returns the meta-type
  instead of executing). This is the only un-instrumented chokepoint.

**Decisive next probe:** instrument where a FnCall/method-call RESULT `ExprInfo.ty` is SET to a
`TypeUni` (gated to `TypeUni` + the call's function name, to isolate `clone_list`). That pins the
exact site the standard-path probes missed. Then port the function.yo:998-1028 name-keyed
substitution (or the TS `evaluateFunctionReturnTypeAgain` + `resolvedConcreteType` handling,
src/evaluator/calls/helper.ts:2369) to THAT site, sourcing the bound `T` from the receiver's
type-arg (NOT `arg_values.forall_args`, which is empty for inferred-forall calls).

## Validation loop (fast)

- Repro reproduces in **seconds**: `YO_MAIN_STACK_MB=2048 <bin> compile <repro>.yo --emit-c
  --skip-c-compiler -o /tmp/r`; check emitted `/tmp/r.c` for `Failed to transpile`, or use the
  [TTERR] swallow instrumentation (function_type.yo `_trial_eval_fn_body`, see
  [[yo-self-fixpoint-tail-run-compile]] for the technique) for the precise error.
- Dev binary rebuild ≈ **11 min** (`./yo-cli compile yo-self/main.yo -o /tmp/bin --optimize 1`),
  NOT the 65-min full self-compile. Per-fix gate: re-run variants A-F (D must go clean,
  A/B/C/E/F stay clean) → `check ./std` 152/152 → corpus 83/83 → full self-compile marker delta.
- Estimated drain if fixed: ~16-22 throws → likely ~100+ markers (codegen fns with large cascades).

Related: [[yo-self-fixpoint-tail-run-compile]], [[yo-self-specialization-self-type]],
[[yo-self-parametric-trait-impl-self-subst]], [[yo-self-phase3-generic-impl-funcid]].

## UPDATE 2 (2026-06-24) — the degenerate value is `TypeVal(Comptime)`; 6 attempts exhausted

Round-5 probe at the throw (type.yo:275, dumping `arg_info.value`) revealed the **exact
degenerate value**: all three failing calls produce **`TypeVal(Comptime)`** (a type-value
wrapping the auto-derived `Comptime` marker trait; its `.ty` is `Type(1)`):
```
member=head  argexpr=((self.head).clone)()  argval=TypeVal(Comptime)
member=items argexpr=(items.clone_list)()   argval=TypeVal(Comptime)
member=types argexpr=(types.clone)()        argval=TypeVal(Comptime)
```
So the mechanism is: **a `.clone()`-family CALL on a recursive-type receiver returns
`TypeVal(Comptime)`** instead of a runtime clone. `Comptime` is the marker auto-derived for
types whose fields all implement Comptime (evaluator/types/utils.yo:144/204; pushed at
trait_checking.yo:220).

**Ruled out (now 6 attempts):**
- Return-type resolution: a chokepoint probe at `evaluate_function_return_type_again`
  ([P-EFRTA]) was **completely silent** for the repro — the result type is NOT computed via
  the return-type machinery at all.
- Receiver shell-resolution: added `resolve_shells_deep` (depth-bounded deep enum+struct shell
  resolve) at function.yo:213. Result: **did NOT fix D, and REGRESSED variant C** (Box(Self).clone(),
  previously clean — the deep walk rebuilds the receiver type even when nothing resolves,
  corrupting a working case). Reverted. So the receiver-resolve path is NOT where the
  `TypeVal(Comptime)` is born (and deep-rebuilding receiver types is harmful).
- `hits=0`: NOT the cause — `clone_list` IS found (variant F dispatches it fine); `hits>0`,
  so `TypeVal(Comptime)` is the **result of CALLING** the method, not a lookup miss.

**Narrowed to:** the `TypeVal(Comptime)` is the **call RESULT** of a `.clone()`-family method
on a recursive-type receiver, set on a path that is neither return-type-resolution nor the
hits=0 fallback. Strong hypothesis: either (a) the method LOOKUP
(`get_type_trait_methods_by_name`/generic-impl fallback) returns the `Comptime` marker member
instead of `clone` when the receiver/element is a shell, or (b) the call is CTFE'd and the
comptime path yields the marker.

**SHARPEST LEAD — it's the where + Self-return COMBINATION (not the lookup).** The bisection
is decisive: D (where(T<:Clone) + `-> Self`) FAILS; E (D minus the where clause) CLEAN; F (D with
where but `-> usize`) CLEAN. And the method IS found (hits>0; F dispatches the same method fine).
So `TypeVal(Comptime)` is produced ONLY when a **where-constrained** method returning **Self**
(the recursive container) is called on a recursive-shell receiver. All three real failing calls
(Option.clone, ArrayList.clone, the custom clone_list) are where-constrained `-> Self`-family
clones. So the production site is the **where-bearing call/specialization path**, where the
combination of (where-clause evaluation for T=recursive-shell) + (Self return) yields the marker.

**SHARPEST HYPOTHESIS (test FIRST in a fresh pass):** since `evaluate_function_return_type_again`
was SILENT, `items.clone_list()` is likely **not evaluated as a normal method call at all** —
instead `items.clone_list` (the callee sub-expr) probably evaluates to a `TypeVal`, so `(...)` is
handled as a **TYPE APPLICATION**, whose result is `TypeVal(<applied type>)` = `TypeVal(Comptime)`.
That single hypothesis explains ALL the evidence: the value is a `TypeVal` (P-THROW), the
return-type machinery is bypassed (P-EFRTA silent), and resolving the receiver shells changed
nothing (the callee, not the receiver, is the TypeVal). **PROBE the property-access evaluation of
`items.clone_list` / `(self.head).clone` (the FnCall's func sub-expr): log its result value-kind
when the method name is clone/clone_list and the receiver type carries a recursive shell. If it's
a `TypeVal` → confirmed: property-access mis-resolves a where-constrained `-> Self` method on a
shell-bearing receiver to a type-value (instead of a callable method), making the call a
type-application.** Likely fix: in property-access method resolution, when the method's return is
`Self`/a recursive container and the receiver carries a shell, return the method as a callable (not
a TypeVal) — or resolve the shell so the method resolves to its real (callable) form.
(Alternative, if the callee is callable: probe the where-bearing dispatch
`validate_where_constraints_for_call` helper.yo:1891.)

**STATUS: 6 build attempts + ~14 code-dives did not locate the production site statically.** The
chain is now precisely traced: `items.clone_list` (the CALLEE) evaluates to `TypeVal(Comptime)` →
`()` is handled NOT as a normal method call (efrta silent) → the result is that `TypeVal(Comptime)`
(its `.ty` is `Type(1)` because a type-value's type is `TypeUni`). `Comptime` is the auto-derived
marker TraitT; the Comptime-trait-FETCH sites (trait_checking.yo:485/952/1512) are trait CHECKS
(return bool/Option), NOT value producers — so the `TypeVal(Comptime)` is born at some
`create_type_value(<Comptime TraitT>)` that static reading can't pinpoint, and the property-access
branches that set a TypeVal value (399 enum-variant; 672 working-trait, scoped to literal `Self` —
neither matches `items.clone_list`) don't obviously cover it either.

**DEFINITIVE NEXT STEP (runtime probe, best done fresh with full context budget):** instrument
`create_type_value` (value.yo) to log when its argument is a `TraitT` named "Comptime" (i.e. a
`TypeVal(Comptime)` is being constructed), with a coarse phase hint set as a module global at the
major dispatch entry points (property_access entry, the method-dispatch in function.yo, the
where-clause check). Run ONLY the minimal repro (few hits). That GUARANTEES catching the
production site (wherever the marker TypeVal is born), which 6 print-probes on the
return-type/receiver/hits paths missed. Then fix at that site: a where-constrained `-> Self`
clone-family method on a recursive-shell receiver must resolve to a CALLABLE method, not a
`TypeVal` of an auto-derived marker. **Cracking this keystone likely drains ~40 of the 48 remaining
throws (the Type(1) cluster + the Frame-level/Incompatible clusters that trace to the same
recursive-type def-time-eval root) — it is the gating fix for finishing P1's marker tail.**
