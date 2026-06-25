# P1 dominant cluster — `where(T<:Trait)` + `-> Self` generic method → `Type(1)`

Status: **ROOT FIXED but NET +3 ON THE METRIC — NOT COMMITTED (see UPDATE 7).** The
recursive-clone root was correctly identified and fixed (UPDATE 6), and the fix
demonstrably removes its targeted markers in the full compile — but removing them
**un-masks 6 previously-warm-up-masked sites**, so the full-compile count goes 440→443.
This empirically confirms the doc-wide hypothesis that the marker count is
warm-up-masked and non-monotonic under individual recursive-type fixes.

## UPDATE 7 (2026-06-25) — ⚖️ MEASURED: fix is CORRECT but NET +3 (warm-up un-masking) — NOT committed

Ran the authoritative full-compile A/B, same `yo-self/main.yo` source, both binaries built
identically (`--optimize 1`), markers counted with the canonical filter
(`grep 'Failed to transpile' | grep -v 'const uint8_t' | grep -v '\.ptr'`):

| binary | behavior | markers |
| --- | --- | --- |
| clean-HEAD (`/tmp/yo-self-bin-base`) | no forward-shell | **440** |
| fix dbg39 (`/tmp/yo-self-bin-dbg39`) | forward-shell trait-ctor methods | **443** |

Set-diff of the two marker lists (normalized; artifacts in scratchpad
`markers-NEW-in-fix.txt` / `markers-REMOVED-by-fix.txt`): **3 removed, 6 new, net +3.**

- **REMOVED (the fix working, confirmed in the FULL compile):** the entire `TypeValue.clone()`
  recursive `match(self, …(inner.clone())…)` body + a boxed-self `((self.*).clone)()` (type id 3506).
  So the keystone genuinely transpiles the deeply-recursive enum clone now.
- **NEW (the cost):** `((self.*).clone)()` on a *different* type (3562); codegen `if((entry.c_name) == c_name…)`;
  lexer `if((self.has_template_string)…)`; parser `return (self.program)`, `parse_primary`'s infix/dot `cond`,
  the struct-literal-vs-block `cond`.

**Why it is un-masking, not surfacing latent work (the decisive point):** the regressed parser/lexer
functions (`parse_primary`, etc.) are **inherent** methods (`name : (fn…)` direct colon-pairs, e.g.
parser.yo:1099) — they were ALREADY forward-shelled by the pre-existing direct-field pre-pass, *before*
this change. So the change did NOT alter their method resolution. The new markers are therefore
**indirect**: removing the `TypeValue.clone` marker changed comptime-cache population order, which flipped
6 sites from warm-up-masked-SUCCESS to FAIL. In warm-up masking a masked site *transpiles correctly* in
the full-compile context (cf. hash_map `with_capacity` = ~0 markers in full compile, fails standalone), so
this fix **broke 6 working transpilations** while fixing 3 — a real net regression for the fixpoint
(stage-2 needs ALL markers at 0; +3 is strictly worse).

**A surgical "shell only the current method, not all siblings" refinement won't help** — the regressions
aren't from my broad sibling-shelling (those functions are inherent / already pre-shelled); they're
indirect cache-order churn.

**Decision: do NOT commit.** Fix left uncommitted in the working tree (`impl.yo`) for the user to review;
fully recoverable from UPDATE 6. The clean-HEAD baseline (440) is the correct repo state.

**Recommended next lever (higher leverage, addresses the masking ROOT):** the #1 full-compile cluster is
`_find_capture_type_c_name` (codegen/exprs/async.yo, ~126 markers) failing on the structurally-identical
`CodegenTypeEntry` vs `CodegenExternFnEntry` collision (both `object(ty, c_name, c_include)`,
codegen/utils/index.yo:75-76). That comptime-fn/struct-identity **cache collision is plausibly the ROOT
of the warm-up masking itself** (an eval succeeds/fails by what the cache collapsed). Fixing the cache key
to distinguish same-fielded structs by NAME ([[yo-self-phase3-hashmap-new-blocker]] — "name-only struct
comparison is unsound") may both drain that cluster AND stabilize warm-up so the recursive-clone fix can
then land net-negative on top. (Risk: that area regressed std 151→17 once when changed unguarded — needs
careful scoping. Present before committing.)

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

## UPDATE 6 (2026-06-25) — ✅ ROOT FIXED: recursive-method registration order (forward-shell trait-ctor methods)

**Root cause (verified, then fixed):** a CHICKEN-AND-EGG in impl registration. A recursive enum's own
`Clone` (`impl(MyT, Clone(clone : (fn(ref(self):Self) -> Self)(… field.clone() …)))`) has its `clone`
body **def-evaluated during the impl's registration, BEFORE `clone` is registered**. That body clones a
`ArrayList(Self)`/`Box(Self)`/`Option(Self)` field, whose element `.clone()` resolves (via
`resolve_enum_shell`, which works) back to `MyT.clone` — but `MyT.clone` **isn't in the registry yet**
(`_try_find_receiver_method` → `find=None`, pinned via `[P-VC]`/`[P-LOOKUP]`). So the recursive
`value.clone()` soft-fell to the NO-METHOD arm → `unknown_val(unit)` → the `…Some(value.clone())`
construction then mismatched (`Expected=<self-shell> Got=unit`) → swallowed → surfaced upstream as
`Got: Type(1)` = `TypeVal(Comptime)`. TS never hits this — its recursive `Self` IS the real (mutated)
type object, so the in-progress method is already reachable (object identity).

yo-self HAS a `_try_create_forward_shell` pre-pass (impl.yo) that forward-declares methods so recursive/
mutual references resolve during body eval — but it only covered **direct** `name : fn` fields, NOT
methods **inside a trait constructor** `Trait(name : fn, …)` (it requires a top-level colon-pair). So
`Clone`'s `clone` was never forward-shelled.

**Fix (2 coordinated changes in `yo-self/evaluator/values/impl.yo`, both faithful to TS):**
1. **Forward-shell the trait-constructor methods** (a pre-pass over `method_exprs` before the body-eval
   loop) — symmetric to the existing direct-field pre-pass. The body loop then UPDATES the shell in
   place. So a recursive `value.clone()` during body eval finds the in-progress `clone`.
2. **Fix the shell-update path's `source_trait_id`**: it hard-coded `""` (inherent), which only suited
   the direct-field shells; trait-ctor methods must keep their **trait id** (same `current_trait_ty`
   tag the non-shell registration uses) or INHERENT-FIRST/Clone/Eq dispatch breaks. (No-op for
   direct/inherent fields, where `current_trait_ty` is None.) — caught by the corpus regression below.

**Validation:** repro_clone5 + repro_min_arrself + variants E/F → **markers 0**; previously-regressed
corpus files (derive_clone_multifield, enum_eq/ne_dispatch, derive_clone_enum_string) → **markers 0**;
`check ./std` 152/152; A/B corpus diff-test = CHANGED 0 (no regression). **BUT the full self-compile
marker delta was +3, not negative — see UPDATE 7.** The fix removes its targeted recursive-clone markers
(`TypeValue.clone`, boxed-self clone) but un-masks 6 warm-up-masked sites. NOT committed.

**Lesson:** the surfaced `TypeVal(Comptime)`/`Type(1)` was a deep CASCADE from a registration-ORDER
miss, not a type-identity or shell-resolution gap (`resolve_enum_shell`/`are_types_compatible` already
handle shells). Chase the FIRST (innermost) swallowed mismatch (`[P-MISMATCH]` ungated at the type.yo
throw), then the dispatch find-result (`[P-VC]`/`[P-LOOKUP]`), not the surfaced symptom.

## UPDATE 5 (2026-06-25) — CONFIRMED a yo-self PORT bug (TS clean); SEED pinned; 5 fix locations ruled out

**It is a yo-self port bug, NOT a TypeScript/language bug** (verified). The reference TS compiler
(`./yo-cli compile … --emit-c --skip-c-compiler`) emits **0 markers / clean C** for BOTH
`repro_clone5` and a NEW truly-minimal repro `repro_min_arrself`:
```rust
MyT :: enum(Leaf(n : i32), Node(kids : ArrayList(Self)));
impl(MyT, Clone(clone : (fn(ref(self) : Self) -> Self)(
  match(self, .Leaf(n) => MyT.Leaf(n), .Node(kids) => MyT.Node(kids.clone())) )));
```
yo-self emits **1 marker** for both. (NB `Option(Self)` directly is infinite-size — rejected by both
compilers; the field must be heap-indirected: `ArrayList(Self)` / `Box(Self)` / an object wrapper.)

**SEED (innermost mismatch, via a `[P-MISMATCH]` probe at the type.yo:280 throw, ungated):**
```
[P-MISMATCH] member="value" mod=./std/prelude.yo Expected=<enum:enum_yo_id_5466__self_shell> Got=unit
```
i.e. inside the prelude clone body's `…Some(value.clone())` construction, the `Some` field type is the
**bare unresolved self-shell** `${MyTypeD}__self_shell` (Expected) and `value.clone()` degenerated to
`unit` (Got). This throws → swallowed → cascades to `Got=Type(1)` for the outer `head`/`items`
constructions (= the surfaced `TypeVal(Comptime)`).

**The degeneration has TWO facets:**
1. **TYPE facet** — the field/element type is the unresolved shell. `[P-CTFEARG]` (probe in
   `evaluate_comptime_fn_call` for shell type-args) fired **0 times** → the container is NEVER
   re-instantiated with a shell arg in the body. So the shell is **baked into the CACHED RECEIVER
   TYPE** (`Option(shell)`/`ArrayList(shell)`, instantiated during MyTypeD's OWN definition when
   Self=shell and the final was not yet registered) and read DIRECTLY by the variant constructor —
   NOT via any forall-`T` re-binding.
2. **VALUE facet** — `value.clone()` (element clone, `value : shell`) returns `unit`. The element
   clone resolves (function.yo:213 `resolve_enum_shell` DOES resolve a bare shell → P-SHELL
   `resolved=true`) to `MyTypeD.clone`, which is **re-entrant** (MyTypeD.clone → ArrayList/Option.clone
   → element.clone() → MyTypeD.clone). The mutual-recursion/forward-ref guard likely yields the
   degenerate `unit`. (Standalone `v.clone()` on the resolved shell WORKS — `[P-SEED]` showed
   `is_comptime=false`, `RESULT=UnknownVal` — so the bare-shell dispatch itself is fine; the breakage
   is the recursive re-entry + the shell-typed field.)

**Fix locations RULED OUT this session (all left markers=1; reverted):**
- `find_methods_from_generic_impls` resolving `match_bindings` shells (impl.yo) — Option/ArrayList.clone
  are found via the **direct trait-method registry** (`get_type_trait_methods_by_name` on the
  container id), NOT this generic-impl fallback, so the resolve never applies.
- `try_to_call` Step-8 forall extraction (helper.yo) — `[P-FIX8]` fired **0 times**: the clone method's
  forall `T` is NOT in `func_type`'s forall labels (`n_forall`=0 here); it is STAMPED on the FuncVal.
- `try_to_call` Step-7c resolving the **stamped** `forall_names` bindings in `callee_env_m` — still
  markers=1 (the body's field type comes from the cached receiver type, not this `T` binding).
- `evaluate_comptime_fn_call` resolving shell type-args — `[P-CTFEARG]`=0 (no shell re-instantiation).
- (UPDATE 4) `expr_info_table_set` / `create_type_value` chokepoints — value is reused, set in-place.

**NARROWED next step:** the fix must address the CACHED RECEIVER TYPE carrying an unresolved nested
shell (resolve it SHALLOWLY — one level into the receiver's immediate type-args / variant-field /
struct-field types at dispatch, e.g. function.yo:213; a DEEP resolve regresses variant C by
materialising the cycle) **AND** the re-entrant `MyTypeD.clone` element-clone returning `unit` (the
recursion/forward-ref guard). Both must produce the real recursive type (TS gets this free via object
identity). A repro that isolates ONLY the recursion (without the shell-typed field) would separate the
two facets.

## UPDATE 4 (2026-06-25) — 22-build runtime trace: dispatch path fully mapped; UPDATE 3 inference CORRECTED

A long instrumentation session (≈22 `-O1` dev builds on `repro_clone5` = variant D) traced the
exact runtime path. **UPDATE 3's premise is WRONG**: the clone receiver is NOT a TypeVal.

### Corrected, VERIFIED facts (all from minimal probes, -O1, `YO_MAIN_STACK_MB=4096`)

- The degenerate value is **`EvalValue.TypeVal(TraitT name="Comptime")`**, type `TypeUni(1)`
  (printed "Type(1)"). Confirmed by a probe at the `type.yo:280` consumer dumping the arg's
  `value` + the TypeVal's INNER type tag → `inner:TraitT(Comptime)`.
- The **trigger is the `.clone()` call itself**, not the where-clause in isolation. The earlier
  bisection (D fails / E clean) was CONFOUNDED: variant E (repro_clone6) removed BOTH the
  `where(T<:Clone)` AND the `.clone()` call from the body (`Self(head : self.head)` vs
  `Self(head : self.head.clone())`). Variant F (repro_clone7) is clean only because it
  **discards** the `count_list()` result (`c := items.count_list(); MyTypeF.Wrap(items)`) — `items`
  (valid) is what's wrapped, so F's degeneration is hidden, not absent.
- It is **self-similar / recursive**: `items.clone_list()` returns `TypeVal(Comptime)` *because* its
  body `Self(head : self.head.clone())` evaluates `self.head.clone()` (= `Option(shell).clone()`,
  prelude `impl(forall(T), where(T<:Clone), Option(T), Clone(...))`) which ALSO returns
  `TypeVal(Comptime)`. Fix the inner `Option(shell).clone()` degeneration and the outer follows.
- **Dispatch path (P-MI trace)**: `items.clone_list` callee evaluates to `callee_value=None` (NOT a
  TypeVal) → `evaluate_function_call`'s `.None` method-dispatch branch (function.yo ~3204) →
  `_try_find_receiver_method` returns **`Some(hits=1)`** (method IS found; `find_methods_from_generic_impls`
  matches the entry, `pattern_tag=Struct`) → ENTER the `.Some(method_info)` arm → calls
  `try_to_call_function_with_arguments` (function.yo ~3300). **`try_to_call` THROWS** for the
  clone/clone_list calls (the "try_to_call RETURNED" probe printed ONLY for the working top-level
  `v.clone()`, never for the failing shell-element clones). So the degeneration is produced INSIDE
  `try_to_call_function_with_arguments`, and the throw is then swallowed by an enclosing trial-eval.
- The receiver's compile-time **value is `noval`** (an `UnknownVal`/no-value runtime receiver of type
  `Option(shell)` / `MyList(shell)`); `is_static=false`; instance dispatch.

### Production site: created in PRELUDE, copied via IN-PLACE `ExprInfo.value =` mutation

A repro-phase flag (`set_ctv_repro`, set in `_trial_eval_fn_body` AND `evaluate_module_value` for any
`module_path.contains("repro")`, set-true-only) gated probes at: `create_type_value` (any TraitT),
`expr_info_table_set` (any `TypeVal(TraitT)`), and the comptime-fn cache-hit return. **NONE fired
during the repro window.** Therefore the `TypeVal(Comptime)` value object:
  1. is **created during PRELUDE** (flag off) — it is the prelude `Comptime` marker-trait binding
     (trait names are stamped LATE / at `::`, so at creation the `TraitT` name is empty `""` — this is
     why earlier `name=="Comptime"`-gated probes all missed; widening to any-TraitT still showed zero
     creations in-window → confirms reuse, not creation);
  2. is **read** during the clone dispatch inside `try_to_call` and written onto the call expr's
     `ExprInfo.value` via an **in-place mutation** (`someInfo.value = <prelude-Comptime-binding>`),
     NOT via `expr_info_table_set` (which is why the `expr_info_table_set` chokepoint missed it).

### RULED OUT this session (do not re-try)
- `create_type_value` is NOT the producer in-window (the value is reused, not freshly wrapped).
- `expr_info_table_set` is NOT the set site (value set via in-place `.value =` mutation of a tabled/
  retrieved ExprInfo).
- The comptime-fn **cache** is NOT the source in-window (repro-gated cache-hit probe silent; the
  ungated hits were all prelude).
- The receiver is NOT a TypeVal (P-RECVK = `noval`), so the property_access TypeVal-receiver branch
  (line 565) and the HKT type-application branch (function.yo:1793) are NOT involved.
- The arg is NOT a cached prior ExprInfo (P-PRIOR = `prior:NONE`); type.yo freshly evaluates it.
- `validate_function_return_type` (helper.yo:282) only validates/throws; it does not set a TypeVal.
- `_call_result_unknown` / `create_unknown_val_with_name` promote a Type-0 slot to `TypeVal(SomeT)`,
  NOT `TypeVal(Comptime)` — so the `.None`/no-method fallback (UnknownVal) is not it either.
- **Attempted fix (REVERTED, ineffective):** resolving each `match_binding` via
  `resolve_struct_shell(resolve_enum_shell(...))` in `find_methods_from_generic_impls` (so forall `T`
  binds to the registered final, not the raw shell). Did NOT change D's outcome. Either
  `resolve_enum_shell(shell)` was a no-op at that point (shell→final redirect not yet registered, or
  the shell is reached by a path other than `match_bindings`), or the degeneration is downstream of the
  binding inside `try_to_call`. (NOTE: a blanket DEEP `resolve_shells_deep` previously regressed
  variant C by materialising the recursive cycle — keep any shell resolution SHALLOW/one-level.)

### NARROWED next step (for a fresh pass)
The degeneration is born INSIDE `try_to_call_function_with_arguments` for a `where(T<:Clone) -> Self`
clone-family method dispatched on a receiver whose type carries an unresolved recursive **self-shell**
element (`Option(shell)`, `MyList(shell)`), where the shell vacuously implements the auto-derived
`Comptime` marker but NOT `Clone`. The call expr's `ExprInfo.value` is set in-place to the prelude
`Comptime` trait binding, then `try_to_call` throws (swallowed). **To pin the exact line:** instrument
the IN-PLACE `ExprInfo.value =` writes inside `try_to_call`'s sub-operations — Step 9 return-type
resolution (`evaluate_function_return_type_again` → `_resolve_some_types_deep`, helper.yo:2620) and
Step 12b specialization (`create_specialized_function_inline`) body eval — for assignment of a
`TypeVal(TraitT)` (empty-named) value. Likely fix: in the clone dispatch / return-type resolution,
resolve the shell element to its registered final (interning model) BEFORE the `where(T<:Clone)`
check + `Self` resolution, so the element's real `Clone` impl is seen and the result is a runtime
clone — instead of the resolution falling through to the element's vacuous `Comptime` auto-marker.
GOTCHA recap: name-stamping is LATE (TraitT name empty at creation — gate probes on ANY TraitT, log the
name); the flag must be turned on for BOTH `_trial_eval_fn_body` AND `evaluate_module_value`
(impl-registration); `-O0` SIGSEGVs this repro (use `-O1`); deep-resolve regresses variant C.

## UPDATE 3 (2026-06-24) — ROOT FOUND (verified): `F(recursive-shell)` type-constructor instantiation degenerates to a type-value

VERIFIED via [P-CLASS] (minimal, -O1, stack=4096): the failing FnCall's **callee** resolves to
`func_resolved=TypeVal` for all three (member=head/items/types). property-access returns a TypeVal
ONLY when the **receiver is a TypeVal** (property_access.yo:565 "TypeVal cases" path) — so the
receiver (`items`, a destructured recursive-enum field of type `MyList(MyTypeD-shell)`) is itself a
`TypeVal`. That means **instantiating the type-constructor `MyList(<MyTypeD self-shell>)` degenerated
to a type-value** instead of the concrete `object(head: Option(...))`. This is the SAME mechanism as
the Stage-0 `Bucket(K,V) → Type(1)` finding in `with_capacity`. So the WHOLE keystone reduces to ONE
root:

> **A type-constructor application `F(arg)` (a `fn(comptime T:Type) -> comptime(Type)` call) where
> `arg` contains a recursive self-shell degenerates to a type-value (`Type(1)`/`Comptime`) instead of
> the concrete `F(resolved)`.** Downstream chain: field value → `TypeVal` → method callee → `TypeVal`
> → call routed as type-application → `TypeVal(Comptime)` → type-member mismatch at type.yo:275.

GOTCHAS that cost rounds: (a) `-O0` SIGSEGVs on this repro (deep eval recursion — see
[[no-release-during-porting]]); must use `-O1`. (b) Probes that `ast_expr_to_string`/`type_to_string`
the recursive expr/type at the DEEP throw point overflow the `-O1` stack too — keep throw-site probes
MINIMAL (variant tag only) + run at `YO_MAIN_STACK_MB=4096`. (c) The repro recurses ~2000 levels for a
trivial value — the degeneration happens deep in the recursive-type comptime-fn evaluation.

**FIX DIRECTION:** at the comptime-fn / type-constructor-application evaluation (where `F(args)` is
computed — evaluator/calls/comptime_fn.yo `evaluate_comptime_fn_call` + the type-constructor call
path), resolve a recursive self-shell type-argument to its registered final
(`resolve_enum_shell`/`resolve_struct_shell`) BEFORE instantiating, so `F(shell)` evaluates as
`F(final)` → the concrete object type, not a degenerate type-value. This is the interning model
([[yo-self-typevalue-enum-interning]]) applied at the type-application boundary (the plan's
"Direction C — central resolve at the operation boundary"). Likely also needs the
registration-timing guarantee (the shell's final must be registered before the instantiation runs).

---

**EARLIER STATUS (superseded by UPDATE 3): 6 build attempts + ~14 code-dives did not locate the production site statically.** The
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
