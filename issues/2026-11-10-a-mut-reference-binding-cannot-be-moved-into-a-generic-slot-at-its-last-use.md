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
