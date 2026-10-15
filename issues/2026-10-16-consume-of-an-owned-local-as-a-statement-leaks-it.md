# `consume(x)` of an owned local, as a statement, leaks `x`

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
