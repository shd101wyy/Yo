# Did the explicit-copy migration misread moves as copies on env-carrying sites (`input_string`, `module_path`)?

**Kind:** design question — whether the migration's copy detector is faithful on the sites that decide the swept compiler's speed. Not filed as a bug: the migration is a one-time rewrite tool, its output was parked before landing, and the verdict decides how V2b B1's sweeps are regenerated (or re-designed), not how a shipped compiler behaves.

**Status:** OPEN — blocks regenerating the V2b B1 sweeps
**Found:** 2026-10-19, gating the parked B1 branch
(`feat/v2b-genb-b1-migration` @ `e556161b0`) after its Tier-1 test run.

## The observation

The swept tree builds and checks green (`check ./src` 278/278, `check ./std`
172/172 under the seed), but the tree-built — swept — compiler is ~80x slower
at evaluation, measured on an idle box:

| command | seed v0.2.65 | swept tree binary |
| --- | --- | --- |
| `yo check std/string/string.yo --std-path ./std` | 5.4 s | 430 s |
| `yo check std/path.yo --std-path ./std` | — | >300 s (timeout) |
| `yo test tests/global_lend.test.yo` | — | 12/12 fail at the 600 s compile timeout, twice |

`perf` puts ~60% of CPU inside std HashMap internals — `hash(key)`, the
bucket probe, the bucket get — plus `mi_malloc`: deep copies of hash-keyed
structures re-hash every key. 1,268 of the 3,271 `src/` insertions are in
`src/evaluator/`; representative hot-shape insertions include:

- `env_ptr.input_string = result_info.env.input_string.clone();` — clones a
  module's entire source text per copy;
- `env_ptr.module_path = result_info.env.module_path.clone();` — per
  operation.

## The question

The migration rewrites only copies whose source stays alive afterwards (a
sharing copy becomes an explicit deep copy; a move is left alone, and a copy
whose source or destination is written afterwards is listed, not rewritten).
The measured slowdown says the detector classified sites like the two above
as sharing copies. Were they?

- If they WERE sharing copies (the env genuinely aliases the result's
  buffers and outlives it), the migration is faithful and the cost is real:
  B1's premise — "each insertion turns a count bump into an O(n) deep copy",
  absorbed by a ±5% ratchet — is wrong by orders of magnitude on
  env-carrying sites, and the sweeps need a different design (borrow the
  sites by hand first, as B4 would, or keep the env's big strings shared
  until the B8 flip makes the decision moot).
- If they were MOVES mis-read as copies (the source env is discarded after
  the assignment, so the emitted C's dup was optimized to a move by the
  dup/drop pair pass), the detector has a fidelity hole on exactly the hot
  paths, and fixing it before regenerating the sweep would recover most of
  the cost.

The distinction matters because the evaluator's env-carrying strings are the
largest buffers the compiler copies and the most frequently: one
`input_string.clone()` in a per-definition path is a whole-file memcpy per
definition.

## Evidence trail

- Parked branch: `feat/v2b-genb-b1-migration` @ `e556161b0` (std 165
  insertions / 38 files; src 3,106 insertions / 1,338 listed / 201 files),
  with the measurements in `plans/VALUES_BY_DEFAULT.md`'s B1 "PARKED
  2026-10-19" block.
- `perf record -F 99 -g --call-graph dwarf` on `yo check std/path.yo`;
  hot addresses symbolized through `nm` + `yo.c` to the three HashMap
  internals named above.
- Tool cost note: re-running `yo fix --migrate explicit-copy` on one `src/`
  file peaks above 50 GB RSS and 45 min without completing (three attempts,
  two kernel-OOM-killed), so the audit below should read the parked diff,
  not re-run the tool.

## Recommendation

Treat it as a fidelity hole until proven otherwise: audit the hottest
insertions by hand, starting at `src/evaluator/env.yo`'s `input_string` and
`module_path` sites, and decide per site whether the source env outlives the
copy. Concretely:

1. Grep the parked branch's `src/` diff for `.clone()` insertions whose
   receiver is `env`, `.env`, `input_string`, `module_path` or a field of
   `Environment`; order by the enclosing function's call frequency (the
   evaluator's per-definition and per-expression paths first).
2. For each, read the C the UNSWEPT tree emits today (the dup/drop pair
   optimizer's output): a pair cancelled to a move means the site was never
   a sharing copy and the rewrite was wrong; a surviving dup means the
   sharing was real.
3. If most hot sites audit as moves, fix the detector (the copy audit needs
   the dup/drop pair outcome, not the surface syntax), then regenerate the
   sweep per the plan's own rule ("take the tip's file and re-run the
   migration") and re-measure the five numbers in the plan's parked block.
4. If most audit as true sharing, do not regenerate: B1's sweeps as
   designed cannot land before B4-style hand edits on the env-carrying
   sites, and the plan's B1 bullet should be rewritten around that.

Either way the sweeps stay parked until this has a verdict; the partial B1
(two migration S2 fixes + the E0916 structural-clone exemption) carries none
of the cost and is unaffected.
