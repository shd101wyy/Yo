# `yo-self check` silently passes an undefined variable that TS's `check` catches

**Status: FIXED 2026-08-17.** Found while fixing the wasm legs
(PR #127): the missing `set_current_target` import in `yo-self/main.yo` was
caught by the TypeScript compiler and **not** by the self-hosted one.

**This is a GATE 4 hole.** `scripts/bootstrap/gates_fast.sh`'s GATE 4 is
`check ./yo-self`, and per AGENTS.md it is the ONLY thing that type-checks
`build_runner.yo` and `version_cache.yo` — files outside `main.yo`'s import
closure. A `check` that can miss an undefined variable weakens the one gate
covering them.

## Reproducer (exact, both compilers, same tree)

`yo-self/main.yo:74` imports from `./target.yo`. Remove **only** the
`set_current_target` binding from that list, leaving the call site at
`run_compile` (`set_current_target(target);`) intact:

```bash
perl -pi -e 's/\{ host_target, set_current_target, parse_target,/{ host_target, parse_target,/' yo-self/main.yo
```

| compiler | command                                  | result                                               |
| -------- | ---------------------------------------- | ---------------------------------------------------- |
| TS       | `check yo-self/main.yo --std-path ./std` | **rc=1**, `Variable "set_current_target" not found.` |
| yo-self  | `check yo-self/main.yo`                  | **rc=0**, zero errors                                |

The TS compiler's `compile` reports it too, at `main.yo:1243:3`.

## What it is NOT — three hypotheses, all refuted

Minimal probes in `src/tests/fixme.yo`; **both compilers behave identically on
all three**, so none of these is the trigger:

1. **Plain undefined name** — `totally_undefined_function_xyz(...)` called from
   `main`: both rc=1, both report it.
2. **Unlisted-export leakage** — import only `host_target` from `target.yo`,
   then call `os_to_str` (exported, not in the import list): both rc=1, both
   report `Variable "os_to_str" not found`. The module system is sound here.
3. **Uncalled function body** — an undefined name inside a `never_called`
   function: both rc=1, both report it. `check` _does_ evaluate bodies that are
   never called.

So the trigger needs something about `main.yo` specifically — its scale, or the
call sitting deep inside `run_compile` (a very large function), or a
swallowed error on that path. **Narrowing that is the next step**; the three
cheap explanations are already eliminated, which is the useful half of the
result.

## Why it matters beyond this one variable

The failure mode is silence: `check` returns 0 and prints nothing. Anything
relying on GATE 4 to prove `yo-self` type-checks is, to an unknown extent,
proving less than it appears to. This is the same class as the hollow-green
test files (`issues/fixed/yo-self-hollow-language-test-files.md`) — a gate that
reports success without doing the work.

## Suggested first probes for whoever picks this up

- Bisect by size: does the miss survive if `run_compile`'s body is trimmed?
- Does it reproduce with the call at `main.yo` top level rather than inside
  `run_compile`?
- Check whether the evaluator hits an error-swallowing path (the
  `swallow/fatal-trial-handler` family) on this route — `keep an un-silenced
swallow binary` and grep its last `__DBG_F` marker.

## Root cause (2026-08-17): one c_include import suppressed the fatal re-raise for the whole module

Bisecting `main.yo`'s import block (an imports-only probe plus
`totally_undefined_zzz()` in a fn body, binary search over the 38 import
statements) converged on a SINGLE statement: `{ exit } ::
import("std/libc/stdlib");`. Any direct import of a `c_include` module
reproduces it; the same probe without one is caught (rc=1).

Mechanism (`evaluator/calls/function_type.yo`): def-time body-eval errors are
swallowed by the capture-free trial handler and re-raised through the FATAL
channel — EXCEPT when `has_fwd_comptime_fn_cap` is set, because a body that
captured a valueless forward-declared comptime fn is an expected intermediate
failure (a bounded re-run refreshes it later). That flag scanned every
in-scope variable for "compile-time-only + valueless + fn-typed", excluding
only `__yo_*` synthetics — and `c_include`d extern fns (`exit`, `memcpy`, …)
are exactly that shape, PERMANENTLY. One libc import therefore set the flag
for every definition in the importing module, and `check` returned 0 on
bodies with undefined variables. (`YO_DEBUG_SWALLOW=1` shows it directly:
`[swallow] Variable "…" not found` followed by `[flow-post] … fwd=true`.)

## Fix

Exclude fn types carrying the FFI marker (`Func` meta `is_extern.is_some()`)
from the forward-declaration heuristic — extern fns are never user forward
declarations. yo-self-only (TS has no fwd-cap mechanism; its module-level
bindings hoist).

Verified: the poisoned probe now rc=1 under the fixed stage-1; the original
`set_current_target` removal in `main.yo` is the acceptance test — `check
yo-self/main.yo` must report it.
