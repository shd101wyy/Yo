# `consume(x)` of an owned local, as a statement, leaks `x`

**Status:** Fixed 2026-10-16 (#1416, `fix/consume-statement-leak`).

**Severity:** S2 — `consume(s)` on a heap-owning local marks it moved, and the discarded result is never dropped, so the object leaks (LeakSanitizer); the workaround is to not use the builtin on an owned value

**Found:** 2026-10-16, Tier 1 of stdio Generation B (fix/stdio-current-position).
`tests/std_export_coverage.test.yo` "stdin() constructs a handle" did `s := stdin(); consume(s);`
and failed locally with `16 byte(s) leaked in 1 allocation(s)`: on develop's std with the
v0.2.63 seed and with the tree binary alike (develop's CI battery at 6f6a2d8e9 reported the
Linux test job green, so the CI leg may not run that file under leak detection; not
investigated). The test now asserts `s.fd() == i32(0)` and lets `s` drop.

## Reproducer

`issues/repros/consume-of-an-owned-local-as-a-statement-leaks-it.yo`:

```yo ignore
E :: ref(struct(x : u64));
main :: (fn() -> unit)({
  s := E(x : u64(0));
  consume(s);
});
```

```
$ yo compile issues/repros/consume-of-an-owned-local-as-a-statement-leaks-it.yo --sanitize address --allocator system -o /tmp/r && /tmp/r
SUMMARY: AddressSanitizer: 16 byte(s) leaked in 1 allocation(s).
```

## Root cause

`evaluate_consume` (`src/evaluator/builtins/consume.yo`) marks the variable consumed, so its
scope-end drop is suppressed, and `generate_consume` (`src/codegen/exprs/consume.yo`) emits
just the argument expression. Used as a statement, that value is discarded with nothing
taking ownership of it. The builtin is ownership plumbing for `consume(p.* = v)` (initialize
through a raw pointer, where the pointee takes the value); on a bare owned local it behaves as
`mem::forget`.

## Fix direction

Either reject `consume(<owned local>)` in statement position (it is a forget with no
spelling that says so), or drop the discarded value. The fix's test: the reproducer's shape in
`tests/rc.test.yo` under the leak checker.

## Fix

`consume` returns `unit`, so "statement position" is every position: the
builtin is always the last owner of what it consumes. The documented model
(`docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`, "`consume(b); // b
cannot be used after this point`") is a move into a consumer that releases the
value; only the initialization form `consume(p.* = v)` means "do not release",
because there the assignment's value is the slot's uninitialized old content.
So `consume(x)` of an owned value now releases it at the consume, as
`drop(x)` does:

- `evaluate_consume` (`src/evaluator/builtins/consume.yo`) decides, BEFORE it
  marks the variable moved, whether the mark suppresses a drop:
  `_consume_releases_variable` mirrors `_schedule_scope_end_drops`'s
  eligibility (owning, RC-containing, not module-level, not a `ref` binding,
  not an unresolved `SomeType`, not yet moved) and also skips a capture of the
  current closure (its capture struct owns it). The init form
  (`_is_init_assignment`: `p.* = v`, also inside `unsafe(...)`) never
  releases. A release is recorded in a side table
  (`record_consume_release`, `src/expr_info.yo`, purged with the other
  ExprId-keyed tables).
- `generate_consume` (`src/codegen/exprs/consume.yo`) emits a recorded
  release through `generate_drop_of_operand`, the body of `___drop` factored
  out of `generate_drop` (`src/codegen/exprs/rc_fns.yo`), so a state-machine
  slot is read in place and cleared after the release exactly as a `___drop`
  of it is.

The same rule closed `consume(f())`: the call's owning result temp was marked
moved by the consume and never released either.

The dup/drop pair optimizer needs no change: it already refuses a candidate
that is moved (`e5`), a base whose derived copy is moved (`consumed_dups`) and
a derived copy whose base is moved (`base_consumed`), so an alias `b := a`
keeps its own count and `consume(b)` releases only that count.

Test: `tests/rc.test.yo`, seven Drop-counter tests (an owned local released at
the consume, a call result, an alias, a consume in one `cond` arm on both
paths, an owned parameter, a `&T` borrow, an early return after and before
the consume). The first five fail on develop's binary, each counting 0
releases where 1 is due; the borrow and early-return tests are
over-release canaries. The parameter case leaked too:
a by-value parameter owns its own count, and the consume dropped it on the
floor, so the caller's object never reached zero. The counter
works with leak verdicts off, which is how every `test.yml` job runs.

## Why develop's CI was green

Every `yo test` job in `.github/workflows/test.yml` sets
`YO_TEST_LEAK_VERDICT: "0"` (the staging ratchet for
`issues/self-hosted-emit-leaks-remaining-classes.md`): LeakSanitizer still
runs and reports, but a leak alone never fails a test there. Leak verdicts
stay ON only in `.github/workflows/leak-verdict.yml`, a weekly scheduled leg
over a seven-file allowlist that does not include
`tests/std_export_coverage.test.yo`. A local `yo test` keeps the runner's
default (verdict on), which is why the stdio branch saw the leak and CI did
not. `tests/rc.test.yo` is on that allowlist, so the new tests also run under
LeakSanitizer weekly.
