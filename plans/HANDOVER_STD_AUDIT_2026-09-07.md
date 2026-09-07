# Handover — std API stabilization, §2 decisions mostly landed (2026-09-07)

**For the agent taking over the std campaign.** Supersedes
`plans/archive/HANDOVER_STD_AUDIT_2026-09-06.md`, whose PR stack has all
merged. §0 below repeats the standing constraints verbatim because they are
still in force.

---

## 0. Standing goal and the maintainer's standing constraints

Goal: finish `plans/STD_API_STABILIZATION.md`.

- At most **5 concurrent agents**.
- **Do NOT use the `Workflow` tool.**
- **Admin merges are pre-authorized** when CI is green.
- **API-shape decisions are delegated** — prefer Rust's shape, and say so when
  the choice is contestable.
- **Patch releases are pre-authorized**, with breaking changes called out in
  the release notes. Stay on v0.2.x (no 0.3.0 window).
- **Always squash-merge WITH `--delete-branch`** (added to `AGENTS.md`
  2026-09-07 at the maintainer's request).

## 1. Releases

**v0.2.26 and v0.2.27 both shipped.** v0.2.27 = the fmt canonical
pointer-cast sweep (#459), `yo init` agent scaffolding (#460), the `dyn` type
check (#433), `comptime_assert` in fn bodies (#420), json trailing content
(#458), and the `Box`-is-Rc docs (#457).

**The release gate requires a green Test run for develop's EXACT head sha.**
A squash merge creates a NEW sha whose PR run does not count, so after merging
you must wait for develop's own push-triggered run before dispatching
`release.yml`. Dispatching early fails fast and harmlessly at
"Require a green test run for this commit" — no version is bumped, so just
re-dispatch `bump=patch`.

## 2. The PR stack — 9 open, verified as one tree

All nine are D-batch decisions from `STD_API_STABILIZATION.md` §2. **All are
breaking and were held for the v0.2.28 window** (v0.2.27 is out, so they can
go now).

**Merge in this order** — trial-merged and gated as one tree:

| # | PR | decision |
| --- | --- | --- |
| 1 | #467 | D13a — hex/base64/utf16 decoders return `Result` |
| 2 | #462 | D18a — `timeout -> Result(T, TimeoutError)` |
| 3 | #465 | D11 — max-heap `PriorityQueue` + `Reverse(T)` |
| 4 | #463 | D17 — stable `sort`, `sort_unstable` heapsort |
| 5 | #461 | D14 — `iter()` yields pointers |
| 6 | #468 | D9a — infallible `ArrayList.push` |
| 7 | #466 | D12 — `FromStr` + `s.parse(T)` |
| 8 | #464 | D10 — `replace` replaces all |
| 9 | #469 | D9b — infallible `insert` (+ plan annotations, this handover) |

That order clears the four contention points: `array_list.yo` (D17→D14→D9a),
`string/string.yo` (D12→D10), `priority_queue.yo` (D11→D9a), and
`hash_map.yo` (D14→D9b).

**Only one real conflict: #461 vs #469 in `std/collections/hash_map.yo`.** Both
add a method at the same anchor, immediately before `contains_key` —
`get_entry_ptr` (D14) and `insert` (D9b). **Resolution: keep both**, D14's
first. Verified in a preflight worktree.

Verified on the merged tree (PRs 1–8): `check ./std` 173/173, `check ./src`
266/266, `fmt --check` clean, compiler self-build green, **full suite
3617/3617**.

**CI on these PRs was deliberately cancelled** — nine concurrent runs starved
the develop run that gates the release. Re-run after rebasing.

## 3. What is still OPEN in §2

| decision | state | why it is not done |
| --- | --- | --- |
| **D13 part 2** | open | `Url.parse` threads `exn.throw` through a long parser — a restructure, not a wrapper. `json.yo` ships **two complete parsers** (`json_parse*` exn and `json_parse_result`) that D13 wants unified: ~94 call sites. |
| **D15** | open | `Debug` split from `ToString`. The `derive(ToString)` rule is `__derive_tostring` + `derive_rule(ToString, …)` in `std/fmt/to_string.yo`, so the `Debug` half is **std-only** — factor the structural body out and wrap it in two impls. The harder half is `derive(Error)` with per-variant format strings (thiserror's `#[error("…")]`); `derive_rule` does receive `trait_params`, so it may be expressible. Design question not settled: should `derive(Debug)` recurse via `Debug` (Rust) or keep calling `to_string` on fields? |
| **D16** | open | `HashSet(T)` over `HashMap(T, unit)`. **525 lines are byte-identical** between the two files (measured). NOTE the plan's tombstone-bug argument is now STALE — #448 fixed tombstones in BOTH, so the remaining value is deduplication only. A type alias will not work (set and map need different method shapes); it must be a newtype wrapping `HashMap(T, unit)` with delegating methods. |
| **D18 part 2** | open | `Thread(T).spawn` carrying its result, `join() -> T`. `Thread` is non-generic and `__yo_thread_spawn` only takes `Fn(io) -> unit`, so the result needs a shared cell — `Channel(T)` already exists with `where(T <: (Send, Acyclic))` and is the natural vehicle. The cost is **174 `Thread.spawn` occurrences**, and it is wired into the evaluator's closure-specialisation (`src/evaluator/calls/`) and `src/codegen/exprs/parallelism.yo`. |

Also open: §4 P1 batteries per module group, and §5 maintainer decisions
(`imm`/`Vec` structure, `MemoryOrder.Consume`, HashMap random keys). D19 (`Box`
keeps its name) landed in #457.

## 4. Rules that bit THIS session — read before touching anything

- **`yo check` is not a gate for this work.** It does not evaluate deferred
  generic bodies, so D9a's `check ./std`+`./src` passed **before** any consuming
  call site was fixed. The gate is `yo build` plus the suite.
- **`yo fmt --check` is not a syntax gate either.** D9b's missing `;` (a `{ e; }`
  body rewrite) produced `error[E0008]` at BUILD time while `fmt --check`
  reported clean. Both properties are documented; both bit anyway.
- **`fmt --check` on a directory is wrong while a suite is running** — the test
  runner writes `tests/.yo_selftest_batch_*.yo` scratch files that fmt then
  flags.
- **`fmt`'s verdict on `*(X(...))` vs `*X(...)` is file-dependent** and not yet
  explained: `hash_map.yo:694` and `ordered_map.yo:280` hold byte-identical
  text and get opposite verdicts. Filed as
  `issues/fmt-pointer-type-paren-verdict-is-context-dependent.md` with three
  narrowing experiments. Practical rule: run `yo fmt` and take what it gives.
- **A remote branch literally named `std` exists**, so every `std/*` branch name
  is rejected with `remote rejected … (directory file conflict)`. All D-batch
  branches are named `std-d9-…` etc. for that reason. Deleting that branch would
  free the namespace.
- **Never delete a worktree whose binary you are using.** Removing
  `/private/tmp/yo-460` took out the compiler every D-branch was testing
  against. A stable one now lives at `/private/tmp/yo-toolchain/yo`, outside
  every worktree.
- **An integration preflight is worth its cost.** Merging all the PRs into a
  scratch worktree and gating the result found an unformatted file that every
  individual PR's own `fmt --check` had passed.

## 5. Findings worth not re-deriving

- **D10 fixed four latent compiler bugs**, not just an API name: Windows
  `\`→`/` normalisation stopping at the first backslash, `/./` collapsing, and
  a "whitespace-stripped" pragma scan that stripped one space and one tab — so
  a spaced `pragma( Pragma.SkipWasm )` was ignored and the test RAN on wasm.
  Write-up: `issues/fixed/string-replace-first-only-broke-compiler-callers.md`.
- **Stronger types keep exposing tests that passed for the wrong reason.** In
  D13a, `"Zm9v YmFy"` was asserted to fail because of a space; it is 9 symbols,
  so the 1-mod-4 length check fires first and the space is never reached. The
  old assertion ("the returned list came back empty") could not tell.
- **D11 is the campaign's one contestable flip** and is flagged as such in
  #465: `PriorityQueue` is max-ordered in C++ but MIN-ordered in Java, so the
  name alone does not settle it.
- **D9's `.unwrap()` hazard.** `map.insert(k, v).unwrap()` used to unwrap the
  RESULT; under `insert -> Option(V)` the identical text unwraps the OPTION and
  panics on a fresh key. Six of the eight sites were inside the `hash_map!` /
  `hash_set!` literal macros, which expand into USER code.
- **`iter()` pointers require a FILE-level pragma**, and `unsafe(...)` alone is
  not a grant. Raised by the maintainer against D14; written up with probes and
  a Rust/Swift comparison in
  `plans/backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md`. Note that #461's
  "writing through the pointer mutates in place" framing over-claims — Yo
  already has safe in-place mutation via `list(i) = v`.

## 6. Environment at handover

`origin/develop` carries v0.2.27. Worktrees `/private/tmp/yo-d9`, `-d9b`,
`-d10` … `-d18`, `-integ2` hold the nine branches and the preflight; all
disposable via `git worktree remove`. Stable compiler:
`/private/tmp/yo-toolchain/yo`. Fallback: the installed `yo` (v0.2.25).

**First three things to do:** (1) merge the nine PRs in the §2 order, keeping
both methods at the `hash_map.yo` conflict; (2) cut v0.2.28 once they are in,
calling out every breaking change; (3) pick up D15 or D16 from §3 — D15's
`Debug` half is std-only and the smaller of the two.
