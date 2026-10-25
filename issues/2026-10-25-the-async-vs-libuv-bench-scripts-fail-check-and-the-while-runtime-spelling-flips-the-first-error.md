# The async-vs-libuv bench scripts fail `check`, and the `while(runtime(…))` spelling flips which error is reported

**Severity:** S3 — two bit-rotted benchmark scripts (no gate builds them) fail `yo check` on develop, and whether the first error is E0917 or E0901 depends on the `runtime(…)` wrapper in `while` conditions, so a pure style rewrite of the conditions changes a broken file's diagnostic.

Filed 2026-10-25 by the `while(runtime(cond))` sweep branch (`style/while-runtime-cond`, head 52bd37874, merge-base b97be9b48). The scripts were already broken before the sweep; the sweep changed only which pre-existing error surfaces first. Not fixed by the sweep branch (an evaluator analysis-order asymmetry, out of a style piece's scope).

## Symptom

With the tree binary built from develop b97be9b48:

```bash
yo check ./scripts/bench/async-vs-libuv/std_vs_raw.yo --std-path ./std
# error[E0917]: Cannot assign to `i`: it is a binding declared without `mut`, so it is immutable (plans/VALUES_BY_DEFAULT.md decision 47).
#    --> ./std_vs_raw.yo:44:7
yo check ./scripts/bench/async-vs-libuv/bench.yo --std-path ./std
# error[E0917]: Cannot assign to `left`: ... --> ./bench.yo:160:9
```

With the sweep applied (every `while(runtime(cond), …)` rewritten to `while(cond, …)`), the same checks instead stop at a later, different pre-existing error:

```bash
# std_vs_raw.yo: error[E0901]: use of moved value: cannot copy `(_ptr.add)(index).*`,
#   whose type `JoinHandle(i64)` is move-only ... --> ./std_vs_raw.yo:155:11
# bench.yo:      error[E0901]: use of moved value: cannot copy `servers(si)`,
#   whose type `JoinHandle(unit)` is move-only ... --> ./bench.yo:336:11
```

Both files fail `check` either way (rc=1). Nothing that compiles became broken; what changed is the first diagnostic an already-erroring file prints.

## Reproducer (the flip)

`scripts/bench/async-vs-libuv/std_vs_raw.yo` on the sweep branch, then revert ONE `while` site back to the old spelling — the E0917 comes back:

```bash
# branch text: check → E0901 at 155
sed -i '36s/while(i < ROUNDS)/while(runtime(i < ROUNDS))/' scripts/bench/async-vs-libuv/std_vs_raw.yo
yo check ./scripts/bench/async-vs-libuv/std_vs_raw.yo --std-path ./std
# error[E0917]: Cannot assign to `i` ... --> ./std_vs_raw.yo:44:7
```

The flip is not tied to the site near the error: reverting line 56 (`_std_side`'s loop, a different function) instead of line 36 restores the E0917-at-44 failure identically. Any one `runtime(…)` wrapper left in the file changes which of the two pre-existing errors `check` reports first.

Minimal attempts do NOT reproduce it: a plain `fn` with `(left : i64) = n; while(left > i64(0), { left = … })` and the same shape inside an `io.async(e => …)` closure both error E0917 identically under both spellings (`tmp/probeE1–E4.yo` in the worktree). The flip needs the full bench file; the E0917 sites sit inside `io.async` closure bodies while the E0901 sites are moves of `JoinHandle` elements (`hs.get(j).unwrap().await(io)` / `servers(si).await(io)`).

## Root cause (partial)

Both scripts bit-rotted on develop independently of the sweep:

- **E0917** — decision 47 (values by default, `plans/VALUES_BY_DEFAULT.md`): the scripts declare loop counters with `(i : i64) = i64(0);` / `(left : i64) = left_i;` and assign them inside `while` bodies; decision 47 requires `mut(i)` for that, and these pre-decision files were never migrated.
- **E0901** — the `JoinHandle` move rules: `servers(si)` / `hs.get(j).unwrap()` copy a move-only element out of its owner to `.await(io)` it.

Why the `runtime(…)` wrapper decides which error is reached first is not fully pinned down: with at least one `while(runtime(…))` present anywhere in the file, the E0917 sites inside the `io.async` closure bodies are reached during the pass that reports first; with none, that pass reaches the E0901 sites first. `check` reports one hard error and stops, so the file's other latent errors stay hidden. The wrapper is therefore not perfectly inert for `check`'s analysis order in files whose loop bodies live in async closures — the one hole found in "dropping `runtime(…)` around a `while` condition is behavior-preserving".

## What to do

- Fix the scripts themselves (migrate the counters to `mut(i)` etc., lend or move the `JoinHandle`s) so both files check clean again; that removes the visible flip along with the rot.
- Separately, if the analysis-order asymmetry matters, minimize why a `runtime(…)`-wrapped condition makes `check` reach closure-body E0917 sites before the E0901 def-site errors (start from the full file; every small extraction behaves identically under both spellings).
