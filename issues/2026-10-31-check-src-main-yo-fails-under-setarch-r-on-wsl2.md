# `check src/main.yo` fails under `setarch -R` on WSL2 (flaky, address-layout sensitive)

**Severity:** S3

Discovered 2026-10-31 during the V5 Generation A prep ABBA measurement
(branch `vbd/v5-gen-a-prep`, logs `~/Workspace/Yo-wt/vbd-logs/v5-prep/`).

## What happens

`scripts/bootstrap/eval_work_ratchet.sh` runs
`setarch "$(uname -m)" -R env LD_PRELOAD=... yo check src/main.yo --std-path ./std`
(ASLR disabled, so the allocation count is deterministic). On this WSL2 box
(kernel 6.18.54.1-microsoft-standard-WSL2, gcc-built libc-malloc binary of the
develop tip `8de7b4f022`), that invocation SOMETIMES fails:

```
error[E0610]: No method "clone" on Reference: the type has no field or method with that name.
    --> ~/.cache/yo/store/sha256/0f767e…/src/inline/link.yo:841:48
    |
841 |         (maybe_ref : Option(Reference)) = state.*.env.references.get_cloned(&label);
    |                                                ^
```

(The failing file is a STORE-CACHED dependency module — the `markdown_yo`
dependency's `src/inline/link.yo` — reached while `check src/main.yo`
evaluates the compiler's imports; `Reference` there is the dependency's own
type, and its method table lookup fails only on the affected layouts.)

The same command WITHOUT `setarch -R` passes (rc=0, `src/main.yo — evaluator
OK`), every time. Under `setarch -R` it is flaky: three consecutive failures
(two ABBA legs 2026-11-01 ~04:30 and one hand probe) then two consecutive
passes (~07:30) with the same binary and tree. With ASLR off the mapping
layout is fixed per environment block, so the pass/fail flip tracks small
environment differences (pipe vs file redirection, env size) shifting the
fixed layout — i.e. the evaluator's behavior depends on raw addresses
somewhere, and disabling ASLR exposes boundary layouts.

The develop-tip BASE binary fails identically (this is NOT a regression of
the V5 prep branch; both binaries measured). CI's `memory-ratchet` job runs
the same recipe on ubuntu-latest and is green with `REPEAT=2` there, so the
layout sensitivity does not trigger on the runner.

## Why it matters

- The work ratchet's soundness claim ("the count is exact; the gate fails
  unless every run agrees") rests on `setarch -R` making the run
  deterministic. A layout-dependent evaluator failure breaks that premise on
  affected boxes.
- A latent address-dependent comparison in the evaluator (a memo keyed by
  pointer identity, or a hash collision assumption) is a nondeterminism bug
  independent of the ratchet: two runs of the same compile can disagree.

## Repro (WSL2 box)

```
cd <a checkout at 8de7b4f022 with a built yo-out binary>
setarch $(uname -m) -R ./yo-out/x86_64-unknown-linux-gnu/bin/yo \
  check src/main.yo --std-path ./std; echo rc=$?
# plain (ASLR on): rc=0 always. Under setarch -R: sometimes rc=1 with the
# E0610 above. Retry a handful of times / vary the env block.
```

## Fix direction

Not investigated (outside the V5 prep window). Start from the E0610 site:
`Reference`'s method table lookup in the store-cached dependency module
succeeds with ASLR on and fails on some fixed layouts, which smells like a
pointer-keyed memo (the CTFE memo's `_ctfe_args_equal` family, or an id
registry keyed by an address-derived hash) returning a stale entry for
`Reference`'s impl environment. A deterministic reproducer needs the exact
failing layout; recording the mapping addresses of a failing run
(`LD_SHOW_AUXV=1`, `/proc/self/maps`) is the first step.

## Impact

No user impact on supported platforms observed; CI's ratchet stays green.
Filed so the flakiness is on record the next time someone measures on a
WSL2 box and sees `check src/main.yo` exit 1 under `setarch -R`.
