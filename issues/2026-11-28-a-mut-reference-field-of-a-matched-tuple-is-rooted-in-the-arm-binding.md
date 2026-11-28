# A `&mut` field of a matched tuple is rooted in the arm binding: `.Some(kv) => .Some(kv.1)` is E0912

**Severity:** S3 — a correct program is rejected; destructuring the tuple in the pattern (`.Some((_, v)) => .Some(v)`) is the workaround the maps' `ValuesMut` iterators use.

Filed 2026-11-28 by the `v81-s3` lane while adding `values_mut()` to `HashMap`, `BTreeMap` and `OrderedMap` (STD_RUST_ALIGNMENT §3.5), on the installed v0.2.80 seed with the tree std.

## Reproducer

`issues/repros/2026-11-28-a-mut-reference-field-of-a-matched-tuple-is-rooted-in-the-arm-binding.yo`:

```yo
second :: (fn(generic(p : Origin), o : Option(Tuple(&(i32, p), &mut(i32, p)))) -> Option(&mut(i32, p)))(
  match(o, .Some(kv) => .Some(kv.1), .None => .None)
);
main :: (fn() -> unit)({
  a := i32(1);
  mut(b) := i32(2);
  r := second(.Some((&a, &mut b))).unwrap();
  r.* = i32(5);
  assert(b == i32(5), "b");
});
export(main);
```

```text
error[E0912]: Cannot return a value holding `kv`: the origin names a local of this function (a binding of the block or `match` arm that produced the value), and a result may name only origin parameters or reference-typed parameters' places (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
  --> tmp/r1/tupmut.yo:2:3
```

The same arm with a shared field (`Tuple(&(i32, p), &(i32, p))`, `kv.1` a `&i32`) is accepted.

## Root cause

`kv.1` of type `&mut i32` is read as a place of the arm binding `kv` (a reborrow through `kv`) rather than as the
`&mut(i32, p)` value the field holds, so the result's origin is the local `kv` instead of `p`. A shared reference is
`Copy`, so its projection copies the value and keeps `p`; a `&mut` is moved out of the tuple and takes the same path
only through a pattern binding.

## Fix

When a field projection of a by-value local yields a `&mut(T, p)` that is moved out (the local is not used again), the
result carries `p`, as the pattern-bound `v` does. A test: the reproducer as a `tests/` case.
