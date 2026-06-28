# yo-self cycle-GC runtime port — the real scope behind `can_type_form_rc_cycle`

**Status:** DONE for ref-structs + direct-field ref-enums (2026-06-27). The
QuickJS trial-deletion runtime is ported and `can_type_form_rc_cycle` is
un-stubbed (commit b4a18a750), and cycle roots now include ref-enums (the
ref(enum) cycle commit). Remaining: the traverse only follows DIRECT reference
fields, not reference fields wrapped in a value-enum (`Option(Self)`) or a
container (`ArrayList(Self)`) — see "Remaining traverse layers" below. The
original task-#34 scope as written:

## Summary

`yo-self/types/utils.yo` ships `can_type_form_rc_cycle` as a conservative
`-> false` stub. Un-stubbing it (so `needs_cycle_gc` can become `true` for
programs containing cyclic reference types, e.g. `Box(Tree)` with a recursive
`Tree`) is **not** a one-function fix: it activates an entire cycle-collecting GC
subsystem that yo-self **has not yet ported**. Turning the stub on without the
runtime regresses the corpus (undeclared `__yo_gc_register` / `__yo_gc_collect` /
`__yo_dispose_dispatch` / `__yo_traverse_<cName>` at C-compile time).

The earlier memory note's claim that the gap was "(a) `type_id` missing from the
GC header + (b) the struct traversal fn missing" was **wrong on (a)**: yo-self
*already* has `type_id` in the GC `__yo_ref_header_t` (`types/generation.yo:630`),
the dispatch `switch (header->type_id)` (`codegen_c.yo:127`), and the ctor
stamping (`constructors.yo:108`). The real gap is the **runtime** and the
**function-pointer dispatch path**.

## Exact gap (4 pieces)

1. **`generateFullGCRuntimeFunctions` — UNPORTED (the big one).**
   `src/codegen/functions/generation.ts:1963-2450` (~487 lines, mostly a static
   C template): thread-local GC init (`__yo_init_thread_gc`,
   `__yo_all_thread_gcs`, `__yo_thread_list_mutex`), `__yo_gc_register` /
   `__yo_gc_unregister` (doubly-linked tracking list + threshold trigger), and the
   QuickJS-style **trial-deletion** cycle collector (`__yo_gc_trial_delete_visitor`,
   mark/scan/collect, `__yo_gc_collect`). yo-self only has
   `generate_lightweight_rc_functions` (the no-op `__yo_gc_register` for the
   `needs_cycle_gc == false` path) and `generate_atomic_gc_runtime_functions`
   (`gc_runtime.yo`). `parallelism/runtime.yo` only *calls* `__yo_gc_collect()`
   (lines 150/287/294); it does not emit it.
   - Port technique: per `[[yo-self-c-template-split-emit]]`, split into many
     0-interpolation `emit_string_line` calls (a single ~380-line template with
     ~16 `${}` interpolations makes the TS codegen hang). Interpolation **count**
     is the quadratic cost, not line count.

2. **Dispose-dispatch function-pointer path — UNPORTED.**
   `yo-self/codegen/codegen_c.yo:101-104` `emit_dispose_dispatch` **early-returns**
   when `needs_cycle_gc` is true. Under cycle-GC, TS uses the `dispose_fn`
   function-pointer form (set in the ctor at `constructors.yo:102`) instead of the
   `type_id` switch. The needs-cycle-gc branch must be ported (see TS
   `codegen-c.ts` around the `__yo_dispose_dispatch` emission).

3. **`generate_ref_struct_traversal_functions` — WRITTEN, saved as a patch.**
   Mirrors `generateRefStructTraversalFunctions` (`generation.ts:2451-2559`):
   `__yo_traverse_<cName>` visits direct ref-struct/ref-enum fields and switches
   on embedded value-enum fields (visiting ref-STRUCT variant fields only — a
   faithful mirror of the TS filter, which omits ref-enum variant fields; that
   omission is a likely latent TS bug, narrow, not in the corpus — fix in BOTH
   compilers separately if pursued). yo-self already has the ref-ENUM analogue
   (`_generate_one_ref_enum_traversal` / `generate_ref_enum_traversal_functions`,
   gated-but-dead today). Patch: `scratchpad/ref_struct_traversal.patch` (168
   lines; adds the two fns + wires the call in
   `generate_ref_struct_constructor_functions` + imports `is_enum_type`,
   `can_optimize_as_nullable_pointer`, `can_optimize_as_simple_enum`). Verified
   `fmt`-clean; **not** built (gated off without the runtime, so it would be dead
   code — committed only as part of the whole subsystem).

4. **Un-stub `can_type_form_rc_cycle` — WRITTEN, saved as a patch.**
   `scratchpad/can_type_form_rc_cycle.patch`: full structural DFS (id-keyed
   visited set; `_type_refs_back_to_cyclic` walker), faithful to
   `canTypeFormRcCycle` (`src/types/utils.ts:1927`) except the env-gated
   `typeImplementsAcyclic` short-circuit (codegen carries no env — conservative,
   documented). Builds clean (was build #10 green); regresses the corpus **only**
   because pieces 1-3 are missing.

## Wiring

When `needs_cycle_gc`, the module pipeline must emit
`generateFullGCRuntimeFunctions` **instead of** the lightweight RC functions
(today `generate_lightweight_rc_functions` is emitted unconditionally — check
`codegen_c.yo::compile_module` and mirror the TS branch in
`CodeGeneratorC.compileModule`). `generate_ref_struct_traversal_functions` and the
already-present `generate_ref_enum_traversal_functions` run on the same gate.

## Validation (memory-safety-sensitive — do not skip)

- `bun run build` then build yo-self: `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin`.
- Corpus 0-diff: `YO_SELF_BIN=/tmp/yo-self-bin bash scripts/diff-test.sh tests/codegen-bootstrap` — must stay 83/83 (cyclic files like `recursive_enum_nested_match.yo` now run in GC mode in BOTH compilers; compare program output).
- `check ./std` — 152.
- **ASan**: compile + run `tests/cycle_collector.test.yo` (the dedicated cycle test) and the cyclic corpus files with `--sanitize address --allocator libc`; require zero leaks / zero double-frees. This is the first time yo-self's cycle-GC runtime executes — latent bugs in the never-run mark-sweep will surface here.

## Why deferred

~487-line runtime split-emit + the dispatch path + wiring + ASan validation is a
focused, memory-safety-sensitive effort that warrants its own clean session, not a
tail-of-session grind. Phase 4 (the REF refactor that motivated revisiting cycle
GC) is complete and corpus-green; this is the remaining `no-stub` follow-up.

## DONE (2026-06-27)

- **Runtime ported + un-stubbed** (commit b4a18a750): `generate_full_gc_runtime_functions`
  (QuickJS trial-deletion collector) + the ref-struct traversal emitter + the
  `can_type_form_rc_cycle` structural DFS. Validated: a ref-struct cycle is
  collected (`tracked 3→1`); corpus 83/83; std 152/152.
- **ref(enum) cycle roots** (the ref-enum commit): four pre-existing Phase-4 gaps
  fixed across BOTH compilers — (1) ref-enum variant-field access codegen used `.`
  instead of `->` (a hard C-compile error on any ref-enum field write;
  `property-access.ts:341` / `property_access.yo` `_enum_field_access`); (2)
  `canTypeFormRcCycle`/`can_type_form_rc_cycle` + the `needs_cycle_gc` scan now root
  at ref-ENUMS, not just ref-structs (with an id-based direct-self-ref check in the
  enum branch of `typeCanFormCyclicRcReference`). A recursive `ref(enum)` with a
  DIRECT `Self`-typed variant field now collects its cycles (TS + yo-self). Tests:
  `tests/cycle_collector.test.yo` (ref-enum self + two-node blocks) +
  `tests/codegen-bootstrap/ref_enum_cycle.yo` (differential).

## Remaining traverse layers (follow-up)

The traverse functions (`generate_ref_struct/enum_traversal_functions`) only follow
a reference field when it is the variant/struct field's DIRECT type. They do not
descend into:

- **value-enum-wrapped references** — `next : Option(Self)`. The ref-STRUCT traverse
  has a value-enum switch case (so `Option(ref-struct)` works), but (a) the ref-ENUM
  traverse has no such case at all (its variant fields that are value-enums are
  skipped — an empty `switch (obj->tag)` is emitted), and (b) that value-enum case
  filters reference-STRUCT fields only, so `Option(ref-enum)` is missed in both.
- **container-wrapped references** — `items : ArrayList(Self)`. The traverse visits
  the `ArrayList` handle (a ref-struct) but the elements live in a malloc'd buffer,
  not as struct fields, so the field-walk never reaches them.

Consequence: cycles that close through `Option(Self)` / `ArrayList(Self)` (the
common recursive shapes — including the real Phase-4 `TypeValue.field_types :
ArrayList(Self)`) are tracked but NOT yet reclaimed. The fix is a unified per-field
traversal helper used by both struct + enum traverses that (i) descends into
value-enum fields and (ii) emits a per-element visit loop for RC-containing
containers — both compilers, mirror-ported, ASan-validated.

## Orthogonal gap: `___dispose` not derived

`get_dispose_function_for_type` → `_method_c_name(type, "___dispose")` returns None
in yo-self (it does not derive `___dispose`/`___drop`/`___dup` — task #34's original
title), so collected objects are freed but their `dispose` is not called
(`dispose_fn` is NULL). Pre-existing (affects the lightweight path too), no corpus
regression; the cycle collector itself reclaims memory correctly.

## Orthogonal gap: ref-enum field reassignment leaks the old value (yo-self)

Reassigning a ref-enum variant field — `a.next = b` — does not drop the
overwritten value's RC in yo-self (it saves the old value to a temp but never
`decr`s it), so the old value leaks. TS drops it correctly. Measured on the
two-node ref-enum cycle: TS `tracked 0→2→0`, yo-self `0→4→2` (the two `ENil`
terminators leak; the a<->b cycle is collected by BOTH). This is why
`tests/codegen-bootstrap/ref_enum_cycle.yo` asserts `after < mid` (the unreachable
cycle was reclaimed) rather than `after == before` (everything freed). Separate
from cycle collection.

**PINNED ROOT (2026-06-28, rigorously confirmed + NARROWED — supersedes the "no-op stub",
"ref-enum-reassign-only", AND an overstated "zero drops / broad" framing):** yo-self **does
not schedule begin-block scope-end RC drops for owning NAMED-LOCAL bindings** (`x :=
New(...)`). It is NOT a total RC absence — yo-self DOES drop call-arg/clone temporaries +
return-path values (PROVEN by the documented yo-self double-free fix
`return_call_clone_arg_drop`, BOOTSTRAPPING_CODEGEN.md:181-189 — you can't double-free
without dropping; other_fn_call.yo/return.yo/match.yo all call
`generate_deferred_drop_expressions`). (`attach_temp_variable_to_expr` is fully implemented,
utils.yo:105; the "stub" comments are stale.) MECHANISM: the codegen function-body generator
(generation.yo:102/116) emits `body_expr.deferred_drop_expressions`, but the begin-block
EVALUATOR (begin.yo) never POPULATES that field for owning named locals at scope end — the
eval-side scheduler (`helper.yo:234 generate_deferred_drop_expressions`, takes
`variables_to_drop`, emits `___drop(var)`) exists + is exported but has **zero evaluator
callers** (only suspension_analysis + recur set the field). CONFIRMED via tracked_count
probe (`/tmp/rc_probe{,2}.yo`): TS drops every named local (all patterns `0→0`); yo-self
leaks every named local (monotonic `0→1→2→3→…` across local / pass-to-owned-param /
returned-value / field-store / unit-tail / value-tail / explicit-`return`). Also: a
`Dispose` impl doesn't fire on a scope-exiting local (TS prints "disposed 7", yo-self
doesn't). CONSISTENT WITH yo-self's ~2× self-compile memory (P2 #21: named locals leak,
temps drop) and the cycle tests "collecting" partly by RC-error CANCELLATION (yo-self also
omits dup-on-store, so the two errors offset for cyclic objs; leaks surface for non-cyclic
ones like the `ENil` terminators). The behavior-based corpus can't see leaks.
**PREREQUISITE (unverified — UAF risk):** whether yo-self DUPs on named-local field-stores/
construction. form_cycle's reassignment showed NO `__dup`; if construction likewise doesn't,
adding a scope-drop for a stored-then-also-local var → UAF. **SAFE FIX ORDER:** (1) verify +
fix dup-on-store FIRST (over-dup = leak, never UAF); (2) THEN port TS `begin.ts:285-331` into
`begin.yo` (schedule drops for the frame's owning non-consumed non-borrowed named locals via
the existing `helper.yo:234` scheduler, store on the begin-block ExprInfo; + consume/move/
borrow/closure-capture exclusions). ⚠️ DELICATE (changes RC for every function; wrong →
double-free/UAF across the corpus). Validate corpus 0-diff + Dispose-fires + tracked→baseline
+ TS-ASan. Repro: `src/tests/fixme.yo`, `/tmp/rc_probe{,2}.yo`, `/tmp/dispose_test.yo`.
