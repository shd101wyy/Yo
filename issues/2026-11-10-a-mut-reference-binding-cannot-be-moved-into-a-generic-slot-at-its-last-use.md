# A `&mut T` binding cannot be moved into a generic slot or a closure capture at its last use

**Severity:** S3 — `q := id(m)` with `m : &mut i32` at `m`'s last use is rejected ("cannot be moved either"), as is a by-value capture `{ m }`; the reborrow spelling `{ m : &mut m.* }` works.

- Filed: 2026-11-10 (capture lane; `VERDICTS-44` probe `d1`, `b6`). Decision 43's move of a `&mut` binding is unbuilt: the evaluator treats a `&mut` borrow binding as "names storage the caller owns".
- Fix: PR 2 of the capture lane (stem `closure-mut-ref-capture`), or v0.2.78.

```yo ignore
id :: (fn(generic(T : Type), v : T) -> T)(v);
g :: (fn(m : &mut i32) -> unit)({
  q := id(m);
  q.* = i32(3);
});
```

## Update (capture lane PR 2)

The closure-capture half is fixed: the by-value entry `{ m }` of a `&mut T` binding moves the reference into the closure
(`tests/closure_capture_list.test.yo`, "a `&mut` binding's by-value entry moves the reference into an FnMut closure"), a later use of
`m` is E0901 naming `{ m : &mut m.* }`, and the closure is `FnMut` (E0913 at an `Fn` slot). The generic-slot half (`q := id(m)` at `m`'s
last use, probe `d1`) is still open: `check_dyn_copy`'s "it is a `&mut` borrow, which names storage the caller owns" predicate has to be
narrowed so a `&mut` binding, not its referent, is a movable value (decision 43's unbuilt move).
