# A unit-typed `Index` argument emits an empty C argument in a `:=` binding

**Severity:** S3. A valid program that subscripts with `()` (`b(())`, an `Index(unit)` impl) and binds the result with
`:=` is accepted and then fails the C compile. The unit index has no C value; a type used as a pure selector is rare,
and `v := b.view()`-style named projections are a workaround.

Found 2026-11-15 by the VERDICTS-63 probes (p9f), through a stand-in for the `Deref` owner, not through `Deref`. Seed
`yo` 0.2.77 (with `--std-path ./std`) and develop (`yo-dt6`) both fail.

## Reproducer

`issues/repros/2026-11-15-a-unit-index-argument-emits-an-empty-c-argument.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");

Buf :: struct(items : Array(i32, 4), n : usize);
impl(
  Buf,
  Index(unit)(
    Output : [i32],
    index : (fn(self : &Self, u : unit) -> &[i32])({
      p := unsafe(__yo_slice_ptr(unsize(&self.items)));
      part := unsafe(__yo_slice_from_raw_parts(p, self.n));
      &part.*
    })
  )
);

count :: (fn(xs : &[i32]) -> usize)(xs.len());

main :: (fn() -> unit)({
  b := Buf(items : Array(i32, 4)(1, 2, 3, 4), n : usize(2));
  v := &b(());
  assert(count(v) == usize(2), "the view through a unit index");
});
export(main);
```

```text
/tmp/v63r/out.bin.c:2312:71: error: expected expression
 2312 |   __yo_slice_t __yo_v_v = yo_id_14580818748948087319000000(&__yo_v_b, );
      |                                                                       ^
1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/v63r/out.bin.c
```

## Expected

The call site and the callee agree on whether a unit-typed parameter occupies a C parameter: today the call site
leaves an empty slot after the comma (the root cause is not located).

Fix: not started (v0.2.79).
