# yo-self cycle-GC runtime port — the real scope behind `can_type_form_rc_cycle`

**Status:** OPEN (scoped 2026-06-27). Blocks un-stubbing `can_type_form_rc_cycle`
in `yo-self/types/utils.yo`. This is task #34.

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
