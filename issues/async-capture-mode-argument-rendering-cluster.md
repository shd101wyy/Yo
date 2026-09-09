# Capture-mode state-machine argument rendering: the still-open cluster

**Status: OPEN** (split 2026-09-09 out of
`issues/fixed/async-closure-value-struct-param-emits-invalid-c-cast.md`,
whose PRIMARY bug — the illegal aggregate call-arg cast — is fixed).

**Re-audit 2026-09-09 (v0.2.29-era develop, PR #509's branch):** probes
committed under `issues/repros/async-capture-cluster/`. Current state per
finding:

1. **Missing-name soft-fallbacks cascade — STILL REPRODUCES** (the live
   bug): an unbound name used only inside a DIRECT `io.async` closure body
   leaves `yo check` green (`evaluator OK`) and `yo compile` dead with the
   "closure body was never fully evaluated" ICE
   (`issues/repros/async-capture-cluster/` — minimal shape: `eprintln(nosuchfn(x))`
   inside the closure). **Fix constraint discovered:** a naive
   check-time surface of anon-body `Variable not found` swallows
   FALSE-POSITIVES on std itself — `std/io/index.yo`'s `read_to_end`
   trait-`?=` default is an `io.async` closure whose FIRST def-time trial
   swallows `Variable "ArrayList" not found` (import ordering) yet works,
   because trait-default closures are RE-EVALUATED per instantiation while
   direct-definition closures are consumed from the first evaluation.
   A sound fix therefore needs re-evaluation-aware bookkeeping (e.g. a
   hollow-io.async-body registry: record on first-trial swallow, clear on
   any successful re-evaluation, consult at check exit) — its own PR, not
   a bolt-on.

2. **`.io` projection in cond-branch arms — NOT reproducible as silent
   invalid C on current develop:** the await-in-a-LATER-cond-arm shape is
   now rejected by a dedicated codegen diagnostic ("`io.await` in a `cond`
   condition inside an `io.async` block must BE the first condition — it
   cannot be nested inside a larger expression, and it cannot be in a later
   branch"), the same restriction the passing
   `tests/cli-cases/await-in-later-cond-branch` fixture pins. The remaining
   residue (capture-mode `.io` drops outside cond arms) has no isolated
   failing case today; reopen with a reproducer if one surfaces.

3. **ASan heap-use-after-free on resume — NOT reproducible on current
   develop:** `uaf_ref_capture_probe.yo` (a `ref(struct)` capture held
   across TWO awaits, built `--sanitize address --allocator system`) runs
   correctly (prints the right value) with NO use-after-free — only two
   24-byte leaks, the tracked self-hosted leak-debt class. The V2-era UAF
   was observed on the pre-sync driver shape; either it was fixed by
   subsequent async work or it needed that exact (since rewritten) shape.

## Original findings (2026-09-07, V2 bisecting session)

1. An `io.async` closure whose body references a name not in scope (e.g.
   `IoExn` without `import("std/error")`) silently degrades the await
   call's recorded arg info; the result is the "closure body never fully
   evaluated" ICE at codegen (or, V2-era, an invalid `(T)(slot)` C cast).
   The def-time trial swallows the not-found error.
2. `.io`/`.exn` member projection is position-dependent: healthy in plain
   segments (`slot.io`), historically dropped in cond-branch arms and
   capture-mode SMs. A bundle-typed parameter (`bundle : IoExn`, invoked
   as `bundle.io.async(...)`) was the only arm-safe shape found.
3. A capture-mode SM with a ref-struct capture hit a UAF in
   `__yo_incr_rc` inside the generated `<sm>_resume` (capture dropped at
   suspension, re-incremented on resume).
