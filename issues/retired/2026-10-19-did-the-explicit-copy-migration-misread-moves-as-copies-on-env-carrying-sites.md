# Did the explicit-copy migration misread moves as copies on env-carrying sites (`input_string`, `module_path`)?

**Kind:** design question (answered by the `b1diag` experiment, 2026-10-19; retired with the verdict folded into `plans/VALUES_BY_DEFAULT.md`'s B1 section).

**Status:** ANSWERED 2026-10-19 — predominantly GENUINE copies; the regression is a population effect, not a tool misread. Filed 2026-10-19 gating the parked B1 branch (`feat/v2b-genb-b1-migration` @ `e556161b0`) after its Tier-1 test run; answered the same day by the `b1diag` rounds (artifacts: `~/Workspace/Yo-wt/vbd-logs/b1diag-v66/`, machine-local).

## The observation that asked it

The swept tree builds and checks green under the seed, but the tree-built —
swept — compiler is ~80–100x slower at evaluation, memory-bound:

| `check std/string/string.yo --std-path ./std` | wall | max RSS |
| --- | --- | --- |
| seed v0.2.65 | 3.7 s | 136 MB |
| swept tree binary | 430+ s (7:10 idle; 15:02 loaded) | 45.0 GB |
| 838 insertions reverted (27% — incl. every whole-module-source copy) | 414 s (6:54, loaded) | 46.7 GB |

`perf`: ~89% of the hot mass is std HashMap `hash`/probe/get — deep copies of
hash-keyed structures re-hash every key — plus `mi_malloc`.

## The answer

**The insertions are predominantly genuine copies.** Reverting 838 of the
~3,100 `src/` insertions — every `input_string` (81) and `module_path` (99)
whole-module-string clone, plus 658 more by hot-name — recovered at most half
of the time excess (15:02 → 6:54 under comparable load) and ZERO memory
(45.0 → 46.7 GB). Per-site classes:

- **A — env-adopted whole-module strings** (`env_ptr.input_string`,
  `env_ptr.module_path`): genuine; no move spelling exists under decision 19
  (the env adopts the buffers).
- **C — `TypeValue` label and type-list clones**: genuine, and the DOMINANT
  mass.
- **D — mut-global caches cloned per lookup**: genuine under decision 47.

The old plan note ("a count bump becomes an O(n) deep copy", absorbed by a
±5% alloc ratchet) overlooked that `String.clone` was ALWAYS a real byte copy
— the cost is the copy × per-operation frequency × retention across ~3,100
sites compounding on the evaluator's hot paths.

Two tool gaps are real but SECONDARY (b1diag §5–§6): dying temporaries get
cloned (the explicit-copy audit's liveness judgment is local/own-param-only,
while the copy-trait audit treats a temporary as a move), and the migration
has no cost/frequency model (`_copy_written_after` consults writes only).
Fixing both and regenerating still reproduces the regression.

A measurement note: the ">50 GB / 45 min per single file" cost of re-running
`yo fix --migrate explicit-copy` was an artifact of running the tool with the
SWEPT binary (the tool evaluates the file with the compiler it is). The
original sweep ran all 201 `src/` files in 384 s clean.

## Recommendation (the verdict this retires with)

Do not attempt recovery by fixing the migration tool. The path back to a
landable B1 is representation work FIRST, sweep SECOND:

1. Pull the borrow/share conversions ahead of any re-sweep: intern or
   `Rc`-share `module_path` and `input_string` in `Environment`; share envs
   and `TypeValue` label/type lists instead of copying them; redesign the
   mut-global read-by-clone caches (decision 47) so a read does not clone per
   lookup.
2. Land the two tool gaps as GUARDS (list dying temporaries; a cost model so
   hot sites are listed for hand edits, not blindly cloned), not as recovery.
3. Regenerate as a LISTING-HEAVY sweep over an already-sharing tree — most
   remaining sites become borrows or shares by hand (B4-style), few become
   clones.
4. Scope: v0.2.67. The sweeps stay out of v0.2.66 (plan B1's PARKED block
   carries the same table).
