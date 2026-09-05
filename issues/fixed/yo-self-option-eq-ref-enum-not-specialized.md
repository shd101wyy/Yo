# yo-self: `==` on `Option(T)` where T is a recursive ref-enum degrades to an FTT comment — TWO missing enum-self-shell resolutions (FIXED 2026-08-13)

> **ROOT CAUSE + FIX (2026-08-12).** Not a specialization bug at all — the title's
> original diagnosis was wrong, and so was the first producer I blamed
> (`other_fn_call.yo:1805`, which never fired). It is **EvalValue's enum
> `__self_shell` reaching two lookup boundaries that never resolved it**:
>
> 1. `evaluator/trait_checking.yo` `type_implements_trait` — the shell has a
>    distinct nominal id, so the impl lookup missed and
>    `where(T <: Eq(T))` reported "does not implement required trait".
> 2. `evaluator/calls/function.yo:2490` — the INFIX operator receiver type. The
>    dot-call receiver 2200 lines earlier (`:298`) already resolved the shell;
>    the operator path did not, so `==` found no method, fell through, and the
>    call evaluated to `unit` — colliding with the sibling match arm's `bool`.
>
> Both now call `resolve_enum_shell`. Reproducer and the std-free generic twin
> both go **rc=0 / 0 markers** (were rc=1 / 1 marker).
>
> Why a shell escapes at all: yo-self TypeValues are value-typed SNAPSHOTS, so a
> shell captured anywhere stays a shell forever — the design resolves it at each
> USE SITE (`creators.yo:605-615`). Five sites already did (method dispatch, enum
> unification, property access ×2, type keys); these were the sixth and seventh.
> A struct shell reuses the final's id, so only ENUM shells have this problem.

**Found 2026-08-12** by the `__yo_user_main` marker gate on branch
`fix/def-eval-swallow-sizing` (PR #110), which turned a silent hollow test
batch into a hard error. **Pre-existing** — not caused by that branch.

## Impact as found

`tests/internal/expr_info.test.yo`'s batch could not be transpiled, so the
emitted `__yo_user_main` was a single `// Failed to transpile` comment. The C
compiler skips comments, so the batch binary ran **nothing** and the runner
reported all **23 tests in the batch as passing**. The CI job
`Compiler internal tests (tests/internal, self-hosted differential)` was
GREEN on develop the whole time.

The compiler's own correctness is **not** affected: of the four `== Option(...)`
sites in `yo-self/`, three are `Option(Abi)` (`target.yo:278`, `:315`, `:327` —
a plain `enum` with a derived `Eq`) and one is `Option(Token)`
(`evaluator/exprs/identifer_and_operator.yo:216`, the undefined-variable
check). All four were verified to transpile cleanly, including the
`Option(Token)` one with a runtime operand.

## Reproducer

`issues/repros/option-eq-evalvalue.yo` — three lines plus imports:

```rust
a := Option(EvalValue).None;
b := Option(EvalValue).None;
assert(a == b, "two Nones are equal");
```

| compiler                  | result                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TS (`out/cjs/yo-cli.cjs`) | rc=0, **0** markers, emits a specialized `==` (`_specialized_T_EvalValue_Self_Option_...`) and `eval_value_eq` ×9 |
| yo-self (pre-gate binary) | rc=0, **1** `// Failed to transpile assert(a == b, ...)`                                                          |
| yo-self (with the gate)   | rc=1, "Failed to transpile part of main's body"                                                                   |

## REFUTED hypothesis 1: the "callee never emitted" degrade

**This was wrong — kept because the instrumentation that killed it is the
useful part.** An `eprintln` at the site below plus one printing all four
`should_skip_function_codegen` flags showed **48 `YSKIP` lines and ZERO
`YFTT-CALL`**: this site never fires for the reproducer. The marker came from
the MISSING-ExprInfo arm in `codegen/exprs/generation.yo` instead, which is a
completely different mechanism — the evaluator never recorded info for the
statement at all (the def-eval swallow's blast radius), rather than a callee
being judged unemittable.

`yo-self/codegen/exprs/other_fn_call.yo:1805`:

```rust
if(should_skip_function_codegen(fid.clone(), c_func_name.clone(), fv, context.base) && !(is_io_async_sm_closure(fid.clone())), {
  return(Option(String).Some(`// Failed to transpile ${ast_expr_to_string(expr)}`));
});
```

The callee is judged never-emitted, so the CALL is degraded to a
statement-level comment (deliberately — a plain call to a skipped callee would
be an undeclared-function error that breaks the whole batch C). The marker text
names the enclosing `assert(...)`, not the `==`, because the degrade happens at
the call being emitted.

## What distinguishes the failing shape — measured

Each row is a separate compile of the same 3-line program with the type
swapped. "folded" = the comparison was constant-folded, so no call was emitted
and the gap is invisible.

| T                                                                      | `Eq` provenance                                                                                           | declaration                                         | result                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `EvalValue`                                                            | **manual** `impl(EvalValue, Eq(EvalValue)((==) : (fn(a : Self, b : Self) -> bool)(eval_value_eq(a, b))))` | `ref(enum)`, payloads recurse via `ArrayList(Self)` | **FTT**                                   |
| `Token`                                                                | derived                                                                                                   | `ref(struct)`                                       | clean (also clean with a runtime operand) |
| `ControlFlowFlags`                                                     | derived                                                                                                   | plain `struct`                                      | clean                                     |
| `String`                                                               | prelude                                                                                                   | —                                                   | clean                                     |
| `EvalValue`, compared directly (`EvalValue == EvalValue`, not wrapped) | manual                                                                                                    | `ref(enum)`                                         | folded                                    |

So it is not "manual impl" alone, not "ref type" alone, and not
"cross-module" alone. It needs `Eq(Option(T))` — the prelude's
`impl(generic(T : Type), where(T <: Eq(T)), Option(T), Eq(Option(T)))`, whose
`==` is an inferred-param lambda `(lhs, rhs) -> match(...)` — instantiated at a
`T` whose own `Eq` is a manual impl over a recursive ref-enum.

Note the direct `EvalValue == EvalValue` case FOLDS, so `Eq(EvalValue)` itself
is fine at CTFE; it is the `Option` wrapper's specialization that is missing.

## REFUTED hypothesis 2: the specialization family

**Also wrong.** The shape looked exactly like the generic-container-`Eq`
specialization family below, and that reading is what the original title
recorded. It is not: no specialization is missing, and the two
`resolve_enum_shell` calls fix it without touching any spec machinery. Kept
because the family IS real for other bugs, and because the warning in it still
stands — `issues/patches/spec-emission-second-half-wip.patch`'s
`_collect_specializations_of` helper looks like the obvious fix and was
**measured harmful** ("cycle_collector RC regression — it emitted extra spec
copies"). Do not re-apply it blind.

This is the family already root-caused in
[`yo-self-collections-batch-residuals.md`](../yo-self-collections-batch-residuals.md):
"spec minted with UNRESOLVED SomeTs → skipped but consumed", and its
signature-1 sibling "recursion guard vs impl instantiations", which was
`Eq(ArrayList(ArrayList(i32))).==` — the same generic-container-`Eq` shape one
level out. That fix added `SpecializingFunctionInfo.impl_bindings_sig` to both
recursion guards (`yo-self/evaluator/calls/helper.yo:1592`, `:1606`, `:6428`)
because yo-self keeps ONE shared func_id per generic-impl method and injects
bindings as `TypeVal` captures, where TS mints a unique funcId per
instantiation (`impl.ts:1551`).

The cycle here is deeper than the one that fix covered:
`Eq(Option(EvalValue)).==` → `Eq(EvalValue).==` → `eval_value_eq` →
`Eq(ArrayList(EvalValue)).==` → `Eq(EvalValue).==`. `value.yo:224` records that
the cycle is only broken because `eval_value_eq` uses `recur`, so the
`Eq(ArrayList(EvalValue))` impl is "only exercised at call time".

## Not yet determined

Whether the specialization is (a) never minted, (b) minted and then skipped by
`should_skip_function_codegen`, or (c) minted concrete but the call site is
stamped with the generic original.

`should_skip_function_codegen` (`codegen/functions/declarations.yo:510-552`) has
four branches, and the campaign record for the sibling `List.map` case
([`retired/yo-self-hollow-test-batch-main.md`](../retired/yo-self-hollow-test-batch-main.md),
"SECOND HALF LOCALIZED") found skip2 firing there — its `has_generic_return` on a
spec whose registered type still rendered `List(U)`. For `==` the return is
`bool`, so if skip2 fires here it must be via `has_generic_params`, i.e. the
spec's PARAM types stayed unresolved.

### Two candidate mechanisms, both cheap to discriminate

1. ~~**`Self`-typed params are never reconstructed for a non-`self` method.**~~
   **REFUTED 2026-08-12 (measured).** The manual impl is
   `(==) : (fn(a : Self, b : Self) -> bool)`, and both places the mint
   reconstructs `Self` gate on the FIRST PARAM BEING NAMED `self`
   (`helper.yo:2432` for param type exprs, `:2497` for the return type expr),
   which an operator method's `a`/`b` never satisfies — so this looked likely.
   But retyping `value.yo:544` to `(fn(a : EvalValue, b : EvalValue) -> bool)`
   and recompiling the reproducer leaves **FTT unchanged at 1**. `Self`
   resolution is not the mechanism.

   (Method note: that experiment needs NO compiler rebuild — the reproducer
   imports `value.yo` as a library, so an existing stage-1 binary picks the edit
   up. ~25 s per iteration instead of ~15 min. Reuse this trick for any
   hypothesis about the SHAPE of a yo-self declaration.)

2. **The call site keeps the generic original** (no spec swap), in which case
   `has_generic_params` fires trivially. Still open — this is what the
   instrumentation below settles.

**Instrumentation for both** (prepared, needs a ~15 min stage-1 build): an
`eprintln` of the four skip flags keyed by fid at the end of
`should_skip_function_codegen`, plus one at the degrade site
`other_fn_call.yo:1805` printing the fid — then correlate the two tags.

Note the `_collect_specializations_of` helper in
`issues/patches/spec-emission-second-half-wip.patch` is NOT the fix: the campaign
record measured it HARMFUL ("cycle_collector RC regression — it emitted extra
spec copies") and dropped it deliberately. Do not re-apply it blind.

## Disposition (2026-08-12)

**Fix the compiler, do not work around it.** `tests/internal/expr_info.test.yo:220`
keeps `info.value == Option(EvalValue).None` — it is the regression assertion
this bug must satisfy. (An earlier pass changed it to `info.value.is_none()` to
un-hollow the batch; that was reverted as a workaround that hides a real
codegen defect.)

## Lesson

A hollow batch is worth **23 tests**, not one. The runner compiles all the test
bodies of a file into a single `__yo_user_main`, so ONE untranspilable
expression anywhere in the file silently voids every test in its batch while
reporting them all green. That is why the `__yo_user_main` marker gate exists,
and this is the first thing it caught.
