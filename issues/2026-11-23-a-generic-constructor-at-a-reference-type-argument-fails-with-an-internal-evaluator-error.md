# A generic constructor at a reference type argument fails with an internal evaluator error

**Severity:** S3 — the program is rejected, as it should be (an `Rc` payload holding a reference), but with "evaluate_function_call: TypeVal SomeT callee without FnTrait (Phase 4)" instead of the E0909 `Escapable` wall; at `T := i32` it compiles.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/cells/es06_generic_rc_where_escapable_missing_in_struct.yo`
in `scripts/test7/audit-corpus.tar.gz`. Reproduced with a stage 1 of develop `f06ff5889`.

## Reproducer

```yo
{ println } :: import("std/fmt");
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(h : Rc(T)));
mkw :: (fn(generic(T : Type), v : T) -> W(T))(W(T)(h : Rc.new(v)));
main :: (fn() -> unit)({
  s := i32(5);
  r := &s;
  w := mkw(r);
  println(`OUT: ${w.h.*.to_string()}`);
});
export(main);
```

```text
error: evaluate_function_call: TypeVal SomeT callee without FnTrait (Phase 4)
 3 | mkw :: (fn(generic(T : Type), v : T) -> W(T))(W(T)(h : Rc.new(v)));
```

## Root cause

Not traced to a line. Specializing `mkw` at `T := &i32` evaluates `W(T)(…)` with `W(T)` unresolved (`SomeT`), so the
constructor call has no callee; the `Rc.new` wall (E0909) that the non-generic spelling reports never runs.

## Fix

Resolve `W(T)` at the specialization's `T`, or report the `Escapable` violation at the call `mkw(r)`.
