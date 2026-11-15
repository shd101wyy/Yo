# The inout-borrow audit labels a by-value capture-list entry "a `match` or `for` binding"

**Severity:** S3 — under `YO_AUDIT_INOUT_BORROW=1`, a write through a by-value CAPTURE-LIST entry (`{ seen }() => { seen.push(...) }`, an `FnMut` closure's own copy, decision 47) is listed as `[inout-borrow]` with the noun "a `match` or `for` binding" — the entry is neither — instead of the capture row the audit's vocabulary promises (`-capture`, "a captured variable"). Audit-mode output only; no effect on any verdict the compiler gives.

Found 2026-11-14 while migrating `tests/cli-cases/audit-inout-borrow-lists-collection-writes` off #1932's E0913 (`fix/develop-1932-cli-goldens`): the implicit-capture spelling keeps the capture row, which is why that fixture chose it.

## Reproducer

```yo ignore
apply_mut :: (fn(f : &mut Impl(FnMut() -> unit)) -> unit)(f());
main :: (fn() -> unit)({
  mut(seen) := ArrayList(i32).new();
  apply_mut({ seen }() => {
    seen.push(i32(9));
  });
});
```

`YO_AUDIT_INOUT_BORROW=1 yo check main.yo` prints

```text
[inout-borrow] main.yo:4:5 seen -> … (seen: a `match` or `for` binding, ArrayList(i32))
```

## Root cause

The d3 pending-entry construction in `src/evaluator/exprs/assignment.yo` builds its noun as `cond(bv.is_parameter() => "a `&T` parameter", true => "a `match` or `for` binding")` (the same fallback the plain-assignment listing uses): a by-value capture-list binding falls into the fallback, and the `-capture` tag is reserved for `_CAPTURE_NOUN` entries, which this walk never produces for capture-list bindings. Whether a decision-47 own copy should be listed at all (the write stays inside the closure's copy) is part of the same question.

## Direction

Give the borrowed-root walk a capture-list-binding noun ("a by-value capture of `seen`"), tag those rows `-capture`, or stop listing writes that stay inside the closure's own copy — whichever matches the V2a audit's remaining purpose now that B8 has landed.
