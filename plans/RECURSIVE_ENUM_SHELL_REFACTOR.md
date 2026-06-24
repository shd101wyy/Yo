# Recursive-enum self-shell — systematic elimination (design)

> ⚠️ **SUPERSEDED (2026-06-24) by `plans/RECURSIVE_TYPE_REPRESENTATION.md`.** This doc's
> central proposal (approach D — eliminate the enum shell via in-place finalization) was
> IMPLEMENTED and gave **+0 markers** (527→527; throw-points 295/296 byte-identical), then
> reverted: the enum-shell representation is NOT the dominant-marker root. The successor plan
> covers the un-addressed struct side, the operation-degeneration root, and warm-up-dependence.
> Kept for the ruled-out-attempts history.

**Status:** DESIGN (2026-06-23). This is the gate to the self-host fixpoint
(`plans/BOOTSTRAPPING_CODEGEN.md` Phase 6 / P1). Use-site resolution has been
proven non-convergent (below); this doc designs the systematic fix.

## Problem

A recursive enum (`TypeValue`, `AstExpr`, user `enum(... Variant(ArrayList(Self))
...)`) is self-referential. TS represents `Self` as **the same mutable object**
that later gets its variants filled in — so by the time any method runs, `Self`
IS the complete enum. yo-self's `TypeValue` is a **value-type enum** (copied, not
shared), so it cannot mutate `Self` in place. Instead (`evaluator/types/enum.yo`):

1. While evaluating the enum's variant fields, `Self` = a `prelim_ty` **shell** —
   an empty-variant `EnumT` with a DISTINCT id `${enum_id}__self_shell`.
2. After the variants are known, `_patch_self_shell` replaces the shell ONE level
   in the variant fields, and `register_enum_final(shell_id, final)` records
   `shell_id → final` so `resolve_enum_shell(shell)` can swap it at use sites.

The distinct shell id is **intentional and required**: sharing the final's id made
EXACT type comparison (the CTFE cache key) conflate `Option(shell)` with
`Option(final)`, returning stale def-time instantiations (std/encoding/json.yo).

**The bug:** the empty shell leaks into SEMANTIC operations where it has no
methods / no layout, and degenerates:
- `element.clone()` on a shell receiver → `hits=0` → the call evaluates to
  `Type(1)` (a bare type value) → "Type mismatch for type member" downstream.
- `*(shell)` / `sizeof(shell)` in a specialized `with_capacity` → degenerate.
- shell-vs-final type comparisons → "Incompatible types" / "match got unit".

## Why use-site resolution does NOT converge (proven, 2026-06-23)

`resolve_enum_shell(t)` swaps a shell→final, but it must be called at EVERY
semantic site the shell reaches, and the shell propagates through many
specialization-input paths. Attempts this session + the 8 in
`issues/yo-self-p1-transpile-tail.md`:

| attempt | site | result |
|---|---|---|
| top-level receiver resolve | `_try_find_receiver_method` | **+37 markers (564→527), COMMITTED** (`3996b5982`) |
| type-arg receiver resolve | `resolve_enum_shell_in_args` | faithful repro fixed, self-compile **+0** — reverted |
| deep field-patch | `register_enum_final` `_patch_self_shell` | repro unchanged — reverted |
| (8 prior) | self_type / forall / static-dot / .Pointer cast / destructure / … | all no-op |

The committed receiver-resolve captured the clone-on-top-level-shell facet (~7
throws); every further use-site resolve hits diminishing/zero returns because the
remaining ~95 throws (member-`"value"` mismatch ×20, enum-got-unit ×21) reach the
shell via OTHER paths. **Per-input resolution is whack-a-mole and does not
converge.** The fix must make the shell never reach semantics.

## The constraint that shapes the fix

The shell must be:
- **DISTINCT** from the final for **CTFE cache keys** (`type_key` /
  `are_types_compatible_exact` / `_ctfe_args_equal`) — else the json.yo conflation
  bug returns.
- **EQUIVALENT** to the final for **semantic ops** (method resolution, type
  comparison, type-application `*(T)`/`sizeof`, construction field checks).

So a blanket "resolve everywhere" breaks the cache; a blanket "keep distinct"
breaks semantics. The systematic fix must separate these two regimes.

## Candidate approaches

### A. Handle/RC `TypeValue` for recursive enums (most faithful to TS)
Represent a recursive enum's `Self` as a shared handle (RC/interned) that always
points at the one canonical final. No shell value is ever copied; semantics and
cache both see the same object (as in TS). **Cost:** converting the recursive
arms of `TypeValue` (and every site that pattern-matches `EnumT` by value) to a
handle type — thousands of sites; the original "multi-week" estimate. Cleanest
end state, highest cost/risk.

### B. Two-regime resolution (recommended first) — keep the value shell, resolve at a SMALL fixed set of SEMANTIC chokepoints, with the CACHE path left shell-distinct
Make `resolve_enum_shell` **deep** (cycle-guarded; recurses struct fields /
type-args / pointer / array / non-self enum variant fields, resolving every
registered shell — the design is in this session's reverted `_patch_self_shell_v`
+ `resolve_enum_shell_in_args`), then apply it at the *complete* set of semantic
chokepoints, NOT per-bug:
  1. method dispatch receiver — `_try_find_receiver_method` (done, top-level; make deep).
  2. type comparison — the LENIENT `are_types_compatible` ONLY (NOT
     `are_types_compatible_exact`, which the cache uses — verify `_ctfe_args_equal`
     calls the exact path so this doesn't conflate).
  3. type-application — `sizeof` (`builtins/sizeof.yo`) and `*(T)`
     (`calls/pointer.yo`) resolve their type argument.
  4. construction field check — `calls/type.yo` resolve the arg + member type
     before `are_types_compatible`.
Each is a single, identifiable chokepoint; doing ALL of them in one pass (rather
than reacting to individual markers) is the difference from the failed
whack-a-mole. **Risk:** (a) the lenient/exact split must be airtight (cache
correctness); (b) deep resolve is hot — guard with a cheap `type_contains_shell`
pre-check so non-shell types skip the rebuild. **Validate:** the ~10s fast repro
(below) + corpus 83/83 + self-compile marker delta; if it converges toward 0,
done; if it plateaus, escalate to A.

### C. Eliminate at `register_enum_final` (rejected)
Patch every cached instantiation that captured the shell. The shell is
value-copied into the CTFE cache + ExprInfo across the program; finding/rewriting
them all is as invasive as A without the clean end state.

## Recommended plan

1. Build the **deep cycle-guarded `resolve_enum_shell`** (path-tracking visited
   set; the session's `_patch_self_shell_v` is a working template) + a cheap
   `type_contains_shell` guard. Land it as a pure helper (no behavior change yet).
2. Apply it at the 4 semantic chokepoints in approach B, **all in one change**,
   keeping `are_types_compatible_exact` / `type_key` shell-distinct.
3. Validate against the fast repro + corpus + self-compile after EACH chokepoint
   addition; watch the marker count converge (not per-marker fixes).
4. If B plateaus well above 0, commit B's gains and escalate to A (handle
   representation) as a dedicated multi-session effort.

## Fast repro (≈10s, validated this session)

```rust
open(import("std/string"));
{ ArrayList } :: import("std/collections/array_list");
RecT :: enum(
  Leaf(value : i32),
  Tuple(labels : ArrayList(String), types : ArrayList(Self))
);
impl(RecT, clone : (fn(self : Self) -> Self)(
  match(self,
    .Leaf({ value }) => RecT.Leaf(value : value),
    .Tuple({ labels, types }) => RecT.Tuple(labels : labels.clone(), types : types.clone()))));
main :: (fn() -> unit)({ x := RecT.Tuple(labels : ArrayList(String).new(), types : ArrayList(RecT).new()); _ := x.clone(); () });
export(main);
```
Compile with `yo-self-bin compile <file> --emit-c --skip-c-compiler`; a
`// Failed to transpile` marker on `RecT.clone`'s match = unfixed. Diagnostic
technique: a `[CLONE_DBG]` `eprintln` of receiver-type / is_static / hits in
`_try_find_receiver_method` pins which dispatch sees a `__self_shell` receiver.

## Approach D — in-place ArrayList population (IMPLEMENTED + REVERTED 2026-06-23) ❌ shell is NOT the P1 bottleneck

> **DECISIVE NEGATIVE RESULT.** Approach D fully eliminates the shell and is
> validated green (fast repro 0 markers, corpus 83/83, `check ./std` 152/152,
> self-compile COMPLETES). But the self-compile marker count is **527 → 527 (+0)**,
> and a throw-point diff vs. the committed (shell) base is **295/296 byte-identical**.
> The recursive-enum shell is therefore **orthogonal to the 527-marker P1 tail** —
> it accounted for only the ~37 markers already captured by the committed
> shell-receiver-resolve fix (`3996b5982`). This **invalidates the premise of this
> entire document and the 8+ prior use-site attempts.** Approach D was REVERTED
> (zero measured benefit + added RC-share/cycle-guard risk). The real P1 root is
> **def-time body-eval typing** (the trial wrapper `_trial_eval_fn_body` evaluates
> ~93 of yo-self's own function bodies with mistyped params/locals, so ordinary
> `if`/`match` statements throw "got unit"/"incompatible types"/"member mismatch").
> 246/296 throw-points are plain `if(...)`. See `issues/yo-self-p1-transpile-tail.md`.
> The mechanism below is kept as a correct, revivable cleanup (it removes a
> yo-self-only divergence from TS's mutable `EnumType`) should the shell ever need
> eliminating for faithfulness — but it is NOT a P1 fix.

The mechanism implemented — neither A's full handle rewrite nor B's use-site
resolution, but a **faithful value-type mirror of TS's in-place mutation**.

**Mechanism.** `evaluate_enum_type` (evaluator/types/enum.yo) now builds the
variant accumulator arrays FIRST and constructs the `Self` placeholder
(`prelim_ty`) **sharing those same arrays**, with the SAME id as the final (no
`__self_shell`). Populating the accumulators during field evaluation therefore
populates `Self` itself — because `TypeValue`'s `Clone` RC-shares every variant
array (a `Self` captured mid-definition — a method sig, a cached `ArrayList(Self)`
— sees the variants pushed afterwards). This required extending the `EnumT` clone
(types/definitions.yo) to RC-share ALL four parallel variant arrays
(`variant_names`/`variant_fields`/`variant_field_labels`/`variant_discriminants`),
not just `variant_fields`. The empty shell, `_patch_self_shell`, the distinct
shell id, and `register_enum_final`'s role all GO AWAY. By the time any method
runs, `Self` IS the populated enum — exactly as TS.

**Why no cache conflation** (the constraint that killed shared-id before): the
prior distinct-id workaround existed only because the shell's OWN arrays stayed
empty, so a def-time `Option(shell)` could be returned (stale, 0-variant) for a
post-definition `Option(final)` lookup. Here the placeholder's arrays ARE the
populated ones — no separate empty value is ever cached. Validated: `check ./std`
152/152 (json.yo clean), corpus 83/83.

**The catch — the shell was silently a CYCLE TERMINATOR.** Pre-D, a recursive
enum's variant fields held `ArrayList(shell)` and the empty shell ended recursion,
making the type graph a finite DAG. Post-D, they hold `ArrayList(final)` = the enum
itself: a genuine cycle (`EnumT → Struct.type_arguments → same EnumT`). Every
traversal that recurses into `variant_fields` must now be cycle-guarded. AUDIT
(2026-06-23): most already are — `are_types_compatible` has its own `visited` set,
codegen `collection.yo`/`generation.yo` track a collected-set, `type_to_string`
doesn't recurse into fields, `auto_derive`/`type_of_type` (run at finalization,
exercised by the fast repro) only walk one level. The LONE gap was `substitute`
(types/substitution.yo), which had only the `visited_trait_ids` guard — the
self-compile's heavily-generic methods drove `_substitute_self_in_method_ty →
substitute` into an infinite loop (SIGBUS, stack-guard overflow at ~16 s). FIX:
added `visited_enum_ids` + a **path-based** (push-on-enter / pop-on-exit) EnumT
guard — push/pop, NOT the push-only trait guard, so sibling occurrences of the
same enum (two `List(T)` params) each substitute while only true back-edges cut.
Diagnose this class: SIGBUS "Could not determine thread index for stack guard
region" + a backtrace of one function calling itself = unguarded recursion on a
now-cyclic type.

**Status:** IMPLEMENTED + REVERTED. Self-compile completed at 527 markers (+0;
295/296 throw-points identical to the shell base) → shell is orthogonal to the P1
tail (see the decisive-negative-result box at the top). The mechanism is correct
and revivable as a standalone faithfulness cleanup; it is not a P1 fix. All P1
effort now redirects to the def-time body-eval typing root.

## References
- `issues/yo-self-p1-transpile-tail.md` — full evidence, throw distribution,
  the 8+ ruled-out use-site attempts, this session's 3 attempts.
- `plans/BOOTSTRAPPING_CODEGEN.md` — P1 (this is the lead blocker for the fixpoint).
- `yo-self/evaluator/types/enum.yo` — shell creation + `_patch_self_shell` +
  `register_enum_final`. `yo-self/types/creators.yo` — `resolve_enum_shell`.
