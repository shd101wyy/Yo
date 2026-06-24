# Recursive-Type Representation — design plan (P1 dominant-marker frontier)

Status: DESIGN (execution-ready). Supersedes `RECURSIVE_ENUM_SHELL_REFACTOR.md`
(which proposed approach D — disproven below).

**DESIGN DECISION (2026-06-24): `TypeValue` STAYS a value-semantics enum.** Do NOT refactor it
to an `object`/`Rc` (reference semantics) to dodge recursive `Self`. An enum is the correct
SHAPE for a type (a closed sum of cases); IDENTITY is an orthogonal concern carried by the `id`
field and resolved through a central registry = **interning** — exactly the rustc model
(`TyKind` is an `enum`, interned as `Ty`). Yo is no-GC, so reference-by-default ADTs (GC'd
MoonBit's choice) would force RC/GC on every type. Consequence for the directions below: ALL of
them operate WITHIN the value-enum model — frame every fix as "carry/resolve the `id` through the
registry," never as a shape change. Direction D (id-indirect `Self`) is the principled end-state
of this model, not an alternative to it.

## 0. Goal

Drain the dominant remaining P1 self-host-fixpoint markers (~445 `Failed to
transpile` in the full `yo-self/main.yo` self-compile, after the 527→445 convergent
fixes). These markers are **def-time-eval typing degenerations on recursive/generic
types**: a value resolves to `Type(1)` / `unit` / `fn(T:Type)->Type` during
definition-time body evaluation, losing ExprInfo for the rest of the function.

## 1. The two representation models

**TS (the reference) — mutable object, no shell.** `evaluateEnumType` /
`evaluateStructType` create the `EnumType`/`StructType` OBJECT first (empty
variants/fields), set `context.SelfType = thatObject` (the SAME reference) during
field evaluation, then PUSH variants/fields into the object's own arrays in place
(`const variants = enumType.variants; variants.push(...)`, enum.ts:56,118). Because
every `Self` reference points to the one mutable object, they all see the final
variants automatically. No shell, no patch, no resolution. (src/evaluator/types/enum.ts,
struct construction in src/types/definitions.ts:222 `StructType.functionValue`.)

**yo-self — value-type TypeValue, "self-shell" workaround.** `TypeValue` is a value
enum (`field_types : ArrayList(Self)`, definitions.yo:159-208) — copied, never mutated
in place. So a recursive `Self` cannot point at "the object being built". yo-self uses:
- A PRELIMINARY empty shell as `ctx.self_type` during field eval
  (enum: `${enum_id}__self_shell`, enum.yo:240; struct: `prelim_ty`, struct.yo:77,93).
- **Enums only:** after field eval, `_patch_self_shell` rewrites field types to replace
  the empty shell with the final (enum.yo:180-211,690), and `register_enum_final(shell_id,
  final)` (creators.yo:327) so `resolve_enum_shell(t)` (creators.yo:334) can map a leaked
  empty-variant EnumT back to its final at use sites.
- **Structs:** set the prelim shell as SelfType (struct.yo:93) but **do NOT** `_patch`,
  `register`, or `resolve` it (struct.yo:203 builds the final but leaves field types
  carrying the shell; no `resolve_struct_shell` exists). ← **un-addressed gap.**

## 2. What has been TRIED and FAILED (do NOT repeat)

- **Approach D — eliminate the enum shell** via in-place enum finalization (the `Self`
  placeholder shares the variant accumulator arrays, populated in place; clone RC-shares;
  substitute gets a `visited_enum_ids` cycle guard). Fully implemented + validated green
  (corpus 83/83, std 152/152, self-compile completes) → **marker count 527 → 527 (+0)**;
  a throw-point diff was 295/296 byte-identical. **The enum-shell representation is NOT
  the marker root.** Reverted. (commit b8a189e77 documents the disproof.)
- **9+ operation-site `resolve_enum_shell` insertions** (try_to_call self_type, substitute
  Self, create_specialized type_args, the `.Pointer` cast pointee, `type_id_or_empty`
  chokepoint, …) — ALL no-ops. Root: either the operand isn't the shell at that point, or
  the final isn't yet in `g_enum_finals` (registration TIMING).
- **6 single fixes this session** (recur×2, _apply_ref_amp, cfid struct-nominal, tuple-label,
  property_access Type(0)) — all +0 in the full compile. They fixed REAL divergences but on
  paths the dominant markers don't take (warm-up/context-dependent).

**Lesson:** the dominant markers are NOT a single representation bug, and NOT a localized
line-divergence. They are warm-up/context-dependent operation degenerations.

## 3. The actual root (precise, from full-compile instrumentation)

Instrumenting the swallow (`_trial_eval_fn_body`, function_type.yo) + the innermost-expr
tracker (evaluate_expression) on the FULL self-compile shows the dominant throw sites:
- **`(*(T))(ptr)` / `sizeof(T)` pointer-cast type-application** inside `with_capacity`
  (std hash_map.yo:82-83 / hash_set.yo:74-75, ArrayList) → `Type(1)`, when `T` is a
  recursive/generic bucket element. The cast degenerates because `T` has no resolvable layout.
- **`clone()` / method-resolution on recursive-type receivers** (value.yo `types.clone()`,
  parser `args.clone()`) → a `TypeVal` (`fn(T:Type)->Type`) instead of a runtime clone.
- **`box.*.field` on recursive STRUCTS** (env.yo:925 `boxed.*.name`, await_analysis.yo:248
  `owner_box.*.id`, suspension_analysis.yo:227 `owner_var.id`) → `unit`. `Variable` is a
  recursive struct (`is_owning_the_same_rc_value_as : Option(Box(Variable))`); the leaked
  empty struct-shell has no fields → `.field` → unit. CONTEXT-DEPENDENT (a minimal
  `RecS{name, other: Option(Box(RecS))}` repro compiles to 0 markers — it forms only with
  Variable's full definition + env.yo's module type-definition order).

⚠️ **CRITICAL VALIDATION CAVEAT:** the per-module **standalone** compile reproduces
DIFFERENT throws than the full compile (warm-up changes which throw fires first). A fix that
drains standalone markers can be +0 in the full compile (proven: cfid drained async.yo
standalone 108→73 but +0 full). **Only the full ~54-min self-compile is the source of truth
for drains.** The standalone fast loop is for diagnosis + regression gates only.

## 4. Design directions (ranked)

### Direction A — Complete the STRUCT-side shell handling (NEW, un-tried, lowest-risk)
Mirror the enum mechanism for structs: after struct field eval, `_patch_self_shell` the
struct field types (replace the empty-field struct shell with the final), `register_struct_final`,
and add `resolve_struct_shell` at struct-field-access (property_access.yo) + the TypeValue
traversals that already call `resolve_enum_shell`. First verify whether the struct prelim
shell uses a DISTINCT id (like enums) or the SAME `struct_id` (struct.yo:77) — if same id,
either switch to a distinct `__self_shell` id (and resolve by it) or resolve same-id-empty-fields.
Targets: the `box.*.field`→unit cluster. RISK: low-medium (structs currently have ZERO shell
handling, so this is strictly more complete than today). The enum analogue is incomplete (§2),
so this is necessary-not-sufficient.

### Direction B — Specialization warm-up at def-time call sites
The `(*(T))(ptr)`→Type(1) + `clone()`→TypeVal are WARM-UP-MASKED (issue doc: warmed by direct
calls in std). Full-compile markers are functions whose def-time eval reaches a NOT-YET-WARMED
generic specialization (with_capacity, clone). Direction: when a function's def-time body eval
CALLS a generic method whose specialization isn't cached, force-compute + cache that
specialization (bind its forall `T`, evaluate `(*(T))(ptr)` against the bound element) BEFORE
using its result — so the cast/method-res resolves instead of degenerating. This addresses
warm-up-dependence directly. RISK: medium (touches the call/specialization path; must not
infinite-loop on mutually-recursive specializations — reuse the mutual-recursion stack from
the phase-6 stage-2 work, [[yo-self-phase6-stage2-crash-root]]).

### Direction C — Central recursive-type resolution at the operation boundary
Instead of scattered resolve sites (9+ failed), resolve enum+struct shells (transitively, with
a cycle guard) at the SINGLE entry of the degenerating operations: `*(T)` type-application /
pointer-cast eval, `sizeof`/`alignof`, and method-receiver-type resolution. A central
`resolve_recursive_type(t)` covering both shells. MUST be paired with the registration-timing
fix (ensure the final is in the registry before any use of a shell-typed value) — the 9 prior
no-ops were largely timing. RISK: medium; depends on timing being fixable.

### Direction D — id-indirect `Self` (the faithful systematic fix)
Make `Self` in a recursive type a stable HANDLE (the type's id), resolved via ONE central
registry at every TypeValue traversal that needs the full type (substitute, type_to_string,
compatibility, layout/sizeof, codegen type-emission). The id IS the identity (closest to TS's
object-identity). Eliminates "shell leaks + can't resolve" entirely because the registry is the
single source of truth and is always populated post-definition. RISK: high (touches every
traversal); but it's the only direction that structurally removes the class. Do this only if
A+B+C are insufficient.

## 5. Recommended staged execution

- **Stage 0 (PREREQUISITE):** re-run the full-compile swallow + innermost-expr instrumentation
  (function_type.yo `_trial_eval_fn_body` handler + expr.yo `evaluate_expression` current-expr
  tracker — both temporary, REMOVE before commit) to get the definitive **full-compile**
  [enclosing-fn → exact failing sub-expr → error] map. Cluster by enclosing C function
  (`awk '/^static .*yo_id_[0-9]+\(/'` on stage2.c). This re-prioritizes against the ACTUAL
  full-compile throws (NOT standalone artifacts). ~14 min (build + capture).
- **Stage 1:** Direction A (struct shell completion). Full self-compile + std + corpus. Expect
  the `box.*.field` cluster to drain.
- **Stage 2:** Direction B (specialization warm-up). Expect the `with_capacity` ptr-cast +
  `clone`→TypeVal clusters to drain.
- **Stage 3:** if markers remain concentrated, Direction C (central resolve + timing) then, if
  still stuck, Direction D (id-indirect Self).
- Each stage: COMMIT only on a measured full-compile marker drop + std 152/152 + corpus 83/83.
  Revert +0 fixes (no speculative code).

## 6. Validation gates (per stage)
- Full self-compile marker count (THE metric): `YO_MAIN_STACK_MB=2048 yo-self-bin compile
  yo-self/main.yo --emit-c --skip-c-compiler` then `grep 'Failed to transpile' stage2.c |
  grep -v 'const uint8_t' | grep -v '\.ptr' | wc -l`. ~54 min — unavoidable (standalone is
  unreliable per §3).
- `check ./std` = 152/152; differential corpus = 83/83 (DIFF 0).
- Build loop: `--optimize 1` (stack); ENV `export PATH=/nix/store/*-bun-1.3.3/bin:$PATH`.

## 7. Open risk / honest caveat
Approach D (enum-shell elimination) gave +0, so it is POSSIBLE that even completing the struct
side (A) and central resolution (C) yield small drains and the true blocker is warm-up (B) or a
deeper specialization-evaluation gap. Stage 0 (the full-compile exact map) must drive the order;
do not invest in a direction without a full-compile throw it provably targets. Related memory:
[[yo-self-recursive-enum-self-shell]], [[yo-self-fixpoint-tail-run-compile]],
[[yo-self-phase3-hashmap-new-blocker]].
