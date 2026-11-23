# R7's value records raise the `check` allocation count by 31 percent

**Severity:** S3 — no wrong output; `check src/main.yo` makes 31% more heap allocation calls after R7, which costs check and build time for every user of the compiler.

- Filed: 2026-11-20 (fix-forward lane for develop battery 44642495937, whose "Evaluator memory ratchet" job failed on R7 #2006).
- Status: fixed 2026-11-23 (fix/evalwork-invariant-memo). The count is below its pre-R7 value; see "Resolution". The other sites listed under "Source" remain copies but no longer show in the count.

## Measurements

`scripts/bootstrap/eval_work_ratchet.sh` counts malloc+calloc+realloc+aligned_alloc calls of `check src/main.yo` on a glibc-malloc rebuild of the stage-2 C:

| Head | Count | Source |
| --- | --- | --- |
| `939fe7160` (last battery before R7) | 8,077,961,565 | develop battery 44434476733, both runs agree |
| `69f09baf4` (R7, #2006) | 10,593,360,000 (+31.1%) | develop battery 44642495937, both runs agree |
| the fix(develop) head after R7 | 10,588,125,544 | local, CI's method (stage 1 emits the stage-2 C, `clang -O2 -I scripts/bootstrap/libc_mimalloc`, `alloc_count.so`, `setarch -R`) |

Max RSS barely moved: 1,954,668 kB at `69f09baf4` against a 1,871,608 kB baseline (inside the ±10% band). The cost is work, not retained memory.

## Source

R7 turned the compiler's ~50 `ref(struct(...))` records into value structs, and every place that used to share a handle now copies the record:

- reads out of the `RefCell` registries use `get_cloned` where `get` used to hand back the shared handle (`g_local_borrows`, the method registries, the in-flight impl stack);
- the in-flight impl record is cloned whole for each member evaluation (`impl_in_flight_clone_at`, which deep-copies its `EvalContext`), and a field is cloned for each accessor read;
- the analysis records (`effects/`, `async/`, `shared/suspension_analysis*`) and the verifier's sort trees are cloned at each repeated use;
- an in-place update is now a take-out, rebuild and store-back (`update_type_trait_method_entry` clones the type's whole method list per update).

Per-site attribution has not been measured.

## Reclaiming it

The deep copies are of records that are only read after the copy. Projection accessors that lend `&` into the cell, or a `with`-scoped read in place of `get_cloned`, avoid most of them. In-place `with_mut` updates replace take-out and rebuild. Measure with `eval_work_ratchet.sh` and lower the baseline in the PR that wins it back (`plans/backlog/EVALUATOR_MEMORY_REDUCTION.md`).

## Resolution (2026-11-23)

A sampling allocation profile of `check src/main.yo` (an `LD_PRELOAD` shim recording a backtrace every 16381st allocation call, the stage-2 C emitted with `--line-directives` so frames map to `.yo` lines) put 43% of every allocation on one line: `_find_methods_from_generic_impls_scan` (`src/evaluator/values/impl.yo`) read the registering module of each generic-impl entry as `g_impl_registry_entry_owners.with(xs => xs.get_cloned(ki))`, a copy of the bucket's whole owner list, strings included, once per entry. A bucket of n entries cost n² string copies per lookup: 4.63e9 calls before #2020, 5.31e9 at `fecf7193a`. This is the R7 pattern above (a `get_cloned` where a shared handle used to be lent).

The scan now reads one owner in place (`xs(ki).get_cloned(ei)`), and only for an entry whose field names include the method (the only entries that reach the visibility check), before the receiver match as before. `check src/main.yo` makes 7,191,229,721 allocation calls (CI's method, `c2955c6e5`), against 10,588,125,544 after R7 and 7,737,272,500 before it. The ratchet baseline was lowered to the new count in the same PR.
