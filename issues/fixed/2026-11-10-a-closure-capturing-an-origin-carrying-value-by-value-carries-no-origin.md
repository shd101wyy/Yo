# A closure that captures an origin-carrying value by value carries no origin

**Severity:** S1 — a closure capturing a holder (`V(x)(r : &x)`) by value and returned over a local passes `check` and is a heap-use-after-free at run time; its root can also be written while the closure lives.

- Filed: 2026-11-10 (capture lane; Fable consult `VERDICTS-44`, probes `d2`, `c1`, `c2`).
- Fix: R-CLOSURE-LIT's by-value clause (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3): every by-value capture whose type carries an origin adds that origin to the closure, so E0909/E0911/E0910 apply. Stem `closure-ref-capture`.

## Reproducer

```yo ignore
V :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p), n : i32));
mk :: (fn() -> Impl(Fn() -> i32))({
  x := Box(i32).new(i32(41));
  h := V(x)(r : &x.*, n : i32(0));
  ({ h }() => h.r.*)
});
```

`yo check` accepts it; compiled with `--sanitize address --allocator system` and `mk()()` called, ASan reports
`heap-use-after-free` (READ of size 4). `c1` (the same closure stored, then `x = 3`, then called) is accepted: a write under a live `&`.

## Root cause

The closure's origin is built from `&name` / `&mut name` entries only; a by-value capture of a value whose type carries an origin
(a `&T`, `&mut T`, a holder struct, a borrowing closure or future) contributes nothing.

## Fixed

`_evaluate_capture_list` (`src/evaluator/values/anonymous_function.yo`) records, for every by-value entry whose type carries an
origin, one capture borrow per place of the value's origin (`origin_of`), and the implicit-capture path does the same for a captured
holder (`variable_holder_roots`). The closure's capture struct is then second-class and its roots are frozen while it lives, so the
existing E0909/E0911/E0910 checks apply. Ungated: every tree.

Tests: `tests/origins/unsound/closure-holder-capture-returned-over-local.yo` (+ `-pos`, ASan pair), corpus rows
`closure-holder-capture-returned-over-local` and `closure-holder-capture-write-root`.
