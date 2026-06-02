# Phase 3 blocker: generic method returning `Self` containing a `String` field → spurious "Cannot unify i32 and usize"

## Status

**RESOLVED (2026, commits `ebca49a3` + `9b678519`).** Two faithful `function.yo`
fixes cleared this blocker — **+6 files, 0 regressions / 560 files**: `check
./yo-self` 53/227 → **57/227**, `check ./std` 150/151 → **151/151** (html.yo),
`check ./tests` 154/182 → **155/182**. `_s := String.from("hi")` and the
`M(String).make` repro now check OK. The fix was NOT the nested-generic-identity
/ `struct_2052` memoization theory this doc originally pursued (that was a dead
end — see the ★★ ROOT CAUSE CORRECTED section). The real fixes:

1. **comptime_string→str param coercion** — `function.yo`'s FuncVal binding bound
   the param under the RAW comptime arg type instead of the DECLARED `str` type,
   so `slice.len()` dispatched `comptime_string.len()→comptime_int→i32`.
2. **don't execute runtime-return fn bodies at call time** (helper.ts:1731) — the
   call site yields `UnknownVal(returnType)`; only comptime-only returns execute.
   This stopped the over-CTFE of `str.len()`/`malloc(sizeof(T)*cap)` on unknowns
   that produced the follow-on `usize vs unit` cascade.

Historical (pre-resolution) analysis retained below for context.

## Minimal reproducer (no HashMap)

```rust
open(import("std/string"));
M :: (fn(comptime(K) : Type) -> comptime(Type))(object(x : K));
impl(forall(K : Type), M(K), make : (fn(v : K) -> Self)(Self(x : v)));
(_m : M(String)) = M(String).make(String.from("hi"));   // FAIL: Cannot unify "i32" and "usize"
```

**Discriminator (the key clue):**

| variant                                               | result                     |
| ----------------------------------------------------- | -------------------------- |
| `M(i32).make(i32(7))` (value-type arg)                | **OK**                     |
| `M(String).make(String.from("hi"))` (RC/newtype arg)  | **FAIL** ("i32 and usize") |
| `M(String).get() -> i32` (returns i32, no `Self(..)`) | **OK**                     |
| `T :: HashMap(String, ArrayList(Foo))` (type only)    | **OK**                     |
| `M.new() -> Self` (NON-generic `M :: object(...)`)    | **OK**                     |

So: pre-existing (identical on pre-session `cs11`); NOT type-instantiation, NOT
basic generic method resolution (both work after this session's
`constructor_func_id`/`type_arguments`/impl-forall fixes); specifically
**constructing/returning a `Self` whose field is a `String`** (a newtype wrapping
`Option(ArrayList(u8))`).

## Mechanism (re-derived; matches the memory)

The annotated `(_m : M(String)) = …` adds a compatibility/synthesize step. With a
`String` field, the synthesizer descends `String` vs `String` → into the nested
`Option(ArrayList(u8))` instantiations. Those **nested generic instantiations are
unstamped / not identity-matched** (empty/ mismatched `constructor_func_id`), so
`same_constructor` is false and the synthesizer **recurses into their field
type lists** — which are misaligned/mis-substituted enough that an `i32` field
meets a `usize` field → "Cannot unify i32 and usize". (`i32`/`usize` are
unrelated to `String`/`M` — pure machinery artifact of field-recursion on
non-identity-matched nested instantiations.) The `:=`-infer form "passes" only
because it binds `_m : <whatever .new()/.make() yields>` with no compat check
(silently wrong, like html.yo's original behaviour).

## Why it's hard (the Stage-4 knot)

The fix is per-instantiation **type identity** for nested generic
instantiations so synthesize matches them by constructor and never recurses into
their fields. Prior attempts that stamped nested/inline-built structs
**re-SIGBUS'd recursive generics** (imm*vec/imm_threading) because the
id-cycle-guard needs \_stable* ids — which requires routing the inline/nested
construction path through the memoized `evaluate_comptime_fn_call` (stable id +
stamp), not ad-hoc stamping. That routing was itself blocked because the
annotation/inline callee resolves to a Func whose return is a _specialized
struct_ (neither bare `Type` nor comptime-only), so no predicate classifies it
as a type-constructor return to trigger memoization.

## Precise pin (2026-06-01, instrumented synthesize_types on the minimal repro)

Logging every external `synthesize_types` call + the tag-mismatch throw on the
`M(String).make(...)` repro shows the failing sequence ends:

```
… ~25× "<struct:struct_yo_id_XXXX> VS <struct:struct_yo_id_2052>"  (impl-pattern trial matches, caught)
DBG SYN-CALL comptime_string VS comptime_string   (ok)
DBG SYN-CALL i32 VS i32                            (ok)
DBG SYN-CALL i32 VS usize                          (FATAL)
```

- `struct_yo_id_2052` is an **early-built (low-id, prelude-era) unstamped**
  nested instantiation from `String`'s representation (`Option(ArrayList(u8))`).
  Its low id confirms it was constructed before the type-constructor funcs
  existed, via a path that **bypasses the comptime-fn memoization** — so it has
  an empty `constructor_func_id` and never identity-matches.
- The `i32 VS usize` is a **direct top-level synth** (not struct-field
  recursion) — `i32`/`usize` ARE genuinely incompatible, so the bug is upstream:
  two structs that should be the same generic instantiation (matched by
  constructor) are instead **structurally compared with misaligned field lists**,
  so field-k `i32` meets field-k `usize`. Making them constructor-match (stamp /
  memoize) removes the spurious recursion.
- `M(i32)` works because `i32`'s representation has no such early-built nested
  instantiation; only `String`'s `Option(ArrayList(u8))` triggers it.

**The two conflicting requirements (why all ~8 attempts failed):** (1) the
early/prelude-built nested instantiation must get a **stable per-instantiation
id** (memoized, like `evaluate_comptime_fn_call`'s cache) so it identity-matches
the use-site instantiation; AND (2) stamping fresh-id nested structs re-breaks
the synthesize **recursive-type cycle-guard** (it keys on stable ids), causing
SIGBUS on recursive generics (`imm_vec`/`imm_threading`). A fix must satisfy
BOTH — e.g. route the prelude/inline nested-instantiation construction through
the memoized path so ids are stable AND the cycle-guard still terminates. This
needs a genuine design, not another stamp/guard tweak.

## Recommended approach for the next focused effort

1. Work against the **minimal `M(String).make()` repro above**, not HashMap —
   it isolates the nested-instantiation identity bug with no `_alloc`/`malloc`/
   `where`/`Result` noise, so iteration is fast.
2. Pin the exact throw: breadcrumb the top-level pair at `synthesizer.yo`'s
   public `synthesize_types` entry, print it at the tag-mismatch throw
   (`synthesizer.yo:~1762`). Confirm the recursing pair is a nested
   `Option`/`ArrayList` instantiation.
3. Make nested instantiations carry stable per-instantiation identity (route
   their construction through memoization) so `same_constructor` short-circuits
   the field recursion — WITHOUT re-breaking recursive-type termination
   (validate imm_vec/imm_threading/priority_queue do not SIGBUS).
4. **ALWAYS** validate with a per-file baseline-vs-fix exit-code diff (build a
   HEAD baseline binary + the fix binary, `join` per file) — the aggregate count
   has hidden "0 improved" ≥4 times. Revert on any regression/SIGBUS.

## Measurement note

`check ./yo-self` / `check ./tests` SIGSEGV in full-directory mode (cross-file
state pollution, entangled with prelude-populated registries — a harness
limitation, not an evaluator bug). Measure **per-file by exit code**; single
files and subdirs check fine. circular_deps SIGSEGV was fixed separately
(`d2732a2f`).

## ★ UNIFYING ROOT (2026): yo-self skips definition-time body type-checking

Tracing the flowability + contracts ports revealed they share the knot's root.
**TS `evaluate_function_type` (`function-type.ts:223-224, 486-499`) evaluates the
function body at DEFINITION time in type-check mode** — `isExecuting: false`,
`isValidatingFunctionDefinition: true` — then runs return-type, `ref(T)`-flow
(`isFlowableExpr`), and contract checks on the evaluated body. **yo-self's
`evaluate_function_type` does NOT evaluate the body at all** (only closures get a
definition-time body eval, via `create_function_body_evaluation_context`).

Consequences (all the same root):

- **flowability** return-flow check (`is_flowable_expr` on the body's return
  expr) has nothing to hook into at definition → cannot be activated.
- **contracts** `wrap_function_body_with_contracts` transforms the
  definition-time body → no hook.
- **the Phase-3 knot**: because there's no definition-time (type-check-only)
  body pass, body evaluation only happens at CALL time (FN-REG-BODY), where it
  _executes_ (`is_executing` true) → over-CTFE of runtime ops (`String.from`
  byte-copy, `HashMap.new` malloc) and the nested-instantiation `i32`/`usize` /
  `Self`→`unit` failures.

**The faithful root fix:** port `evaluate_function_type`'s definition-time body
evaluation (TS `function-type.ts`) — evaluate the body with `is_executing=false`

- `is_validating_function_definition=true`, then run the return-type / flow /
  contract checks on it. This is the 1-to-1 port that unblocks flowability,
  contracts, AND removes the over-CTFE pressure on the knot. It is large and
  high-risk (it newly type-checks ALL fn bodies, with abstract type params — e.g.
  `sizeof(Bucket(K,V))` with abstract `K,V` must defer, not error), so it needs a
  staged effort with the per-file baseline-vs-fix diff harness. This is the single
  highest-leverage faithful divergence to close; flowability/contracts/knot are
  facets of it.

## Experiment (2026): faithful definition-time body-eval port — measured 53→3, REVERTED

Acting on the unifying root, I attempted the faithful 1-to-1 port of TS's
definition-time body evaluation into
`try_to_implement_function_by_function_type` (function_type.yo):

- Ported `typeContainsSomeTypeForCodegenParam` (types/utils.ts) into
  `trait_checking.yo` (not utils.yo — it needs `type_implements_fn/future`,
  which live in trait_checking, and utils can't import trait_checking without a
  cycle). Adapted for yo-self's model: SomeT has no `is_extern` /
  `resolved_concrete_type` fields (resolution is via env), and struct fields
  have no `is_effect_param` flag — those TS branches were omitted (documented).
  Added a Struct/EnumT-id cycle guard (mirrors TS `checkedTypes`) to avoid
  SIGBUS on recursive generics.
- Wired `should_defer_body_evaluation` (forall>0 ‖ any param is codegen-param
  some-type ‖ `ctx.self_type` contains some-type ‖ return type is codegen-param
  some-type) + the body eval (mirroring `closure_type.yo`: push frame, bind
  params, `create_function_body_evaluation_context`, `evaluate_begin_expression`).

**Result (per-file diff vs HEAD baseline 53/227): 53 → 3.** 50 files regressed —
uniformly, because the failure is in the PRELUDE: evaluating concrete-signature
prelude bodies at definition throws on `rune.from_u32 : (fn(value : u32) ->
Option(Self))`, then the `exn.throw` aborts prelude evaluation partway, cascading
to later prelude defs (`Index` trait `-> *(Self.Output)`, `Range`
`struct(start : T, end : T)`).

**Why `should_defer` can't catch it:** at this pipeline point the return type
`Option(Self)` carries `Self` as an **unresolved atom**, NOT a `SomeT` — it
prints literally as `Self`. So neither `type_contains_some_type` nor the
codegen-param scan detects it, and the body is evaluated with `Self` unbound.
The types referenced by the body simply aren't resolved at definition time.

**Conclusion:** this is the SAME wall as the over-CTFE experiment (std 151→71)
and the knot. Definition-time body eval can't be ported incrementally — it
requires yo-self's evaluation pipeline to resolve the generic/`Self` constructs
that bodies reference (the same deep work the knot needs). Reverted both the
wiring and the (now-consumer-less) helper to keep HEAD clean at 53/227. The
helper is a correct faithful port; recover it from this commit's history or
re-port from `types/utils.ts:708` when the prerequisite (resolved-at-definition
types) is met. **Prerequisite ordering confirmed: knot → definition-time body
eval → flowability/contracts.**

## ★★ ROOT CAUSE CORRECTED (2026): NOT nested-generic identity — it is comptime-arg parameter binding

A fresh, instrumented investigation (eprintln tracing every `synthesize_types`
call + the caller of the fatal pair + property-access receiver types) **disproves
the "nested-generic-instantiation identity / struct_2052" theory above.** The
fatal `synthesize_types(i32, usize)` is a TOP-LEVEL call (its `checked` trail has
1 pair — itself), NOT struct-field recursion. Tracing its caller and source:

- It comes from `helper.yo:509` (`check_if_function_parameter_matches_argument`),
  per-parameter, synthesizing `slen == usize(0)` at **`std/string/string.yo:53`**
  inside `String.from`.
- `String.from(slice : str)` body does `slen := slice.len()`. When CTFE-evaluating
  `String.from("hi")`, the argument `"hi"` is `comptime_string`. The FuncVal call
  path **`function.yo:1207`** binds the parameter `slice` with the **raw argument
  type** (`comptime_string`) instead of the **declared parameter type** (`str`),
  skipping the comptime→runtime conversion that `helper.ts:504-568` performs.
- So inside the body `slice` is `comptime_string`-typed → `slice.len()` dispatches
  to `comptime_string.len()` (`prelude.yo:1026`, returns `comptime(comptime_int)`
  → lowered to `i32`) instead of `str.len()` (`prelude.yo:~5572`, returns `usize`).
  Then `slen(i32) == usize(0)` → the spurious `Cannot unify "i32" and "usize"`.

**This is the "two FuncVal call paths" gap (memory `yo-self-default-args-side-table`):
`function.yo`'s inline FuncVal binding never applies the comptime-arg→runtime-type
conversion that `helper.yo` does.** Confirmed by patching `function.yo:1207` to
bind the converted/declared `str` type: the `i32/usize` error **disappears**
(`slice.len()` then dispatches on `str` → `usize`). The minimal repro
`_s := String.from("hi")` reproduces it with no generics/HashMap at all — the M /
HashMap framing was incidental.

### Why a complete fix needs one more piece (the remaining layer)

After binding `slice` as `str`, the comptime_string VALUE is still carried (TS
keeps it under `forceCompileTimeBindings`), so `str.len()` / `str.ptr()` read a
non-str value → `usize`/`unit` mismatch and `Cannot create a pointer to a value`.
The faithful resolutions, in order of preference:

1. **Coerce the comptime_string VALUE to a `str` value** at the binding (TS keeps
   a _usable_ value under forceCTB). yo-self has no comptime_string→str value
   coercion yet — it must be added.
2. OR carry the **parameter `isCompileTimeOnly` flag** into the FuncVal call path
   (a func-id side-table, like default args — `Func` can't hold it) so the
   binding can faithfully mirror `helper.ts:504-512`: convert type + drop the
   comptime value ONLY for runtime params, keeping it for comptime params. A
   blanket drop regresses pointer creation (`&(comptime_param)` → prelude
   `Cannot create a pointer to a value`), and a too-broad type conversion mangles
   type-parameter args (`(?*) :: (fn(comptime(T):Type)->…)(Option(*(T)))`).

**Both fixes belong in `function.yo`'s FuncVal binding (≈ line 1207) AND
`helper.yo`'s `check_if_function_parameter_matches_argument`.** The "nested
generic instantiation identity / struct_2052 memoization" work in the sections
above is a DEAD END for this bug — do not pursue it.
