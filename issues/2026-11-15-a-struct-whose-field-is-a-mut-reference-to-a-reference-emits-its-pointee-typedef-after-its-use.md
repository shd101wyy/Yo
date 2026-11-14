# A struct whose field is a `&mut` reference to a reference emits its pointee typedef after its use

**Severity:** S1 — the emitted C does not compile (`unknown type name`), so `yo compile` fails on a
program `yo check` accepts; no wrong-code ships, but the build breaks. Found by the G-B positive
control `c4-mut-ref-ref-field-lend-pos` (landed with #1947) on `fix/sig-1`'s tip gate
(`~/Workspace/Yo-wt/vbd-logs/sig/gate-s1k/`, 332 passed / 1 failed).

## Reproducer (`tests/origins/unsound/c4-mut-ref-ref-field-lend-pos.yo`, expect accept)

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
M :: struct(rp : &mut&Rc(X));
main :: (fn() -> unit)({
  outer := mk();
  other := mk();
  mut(r) := &outer;
  {
    m := M(rp : &mut r);
    ri := &other;
    m.rp.* = ri;
  };
  println(`OUT: ${r.*.*.s.len().to_string()}`);
});
export(main);
```

```text
$ yo check  repro.yo          # PASSES (evaluator OK)
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang
/tmp/...c:816:3: error: unknown type name '__yo_t_17396285966568866797'
  816 |   __yo_t_17396285966568866797 const * * __yo_v_rp;      // M's field
        ^
852 | typedef __yo_t_15990181672592572419* __yo_t_17396285966568866797; // Rc(X) — 36 lines LATER
```

## Root cause (narrowed)

The `Rc(X)` newtype typedef is EMITTED after the struct `M` that uses it. Both declarations sit in
the same type-declaration stream, whose order is id-keyed, and on `fix/sig-1`'s binary the `Rc(X)`
instance's id differs from the healthy one — the declaration lands in a different position, after
its use. Comparison pinning it to this branch's delta: the SAME row, on the SAME develop base
(f463e3fb0) with only `fix/sig-4`'s evaluator delta, compiles clean (`/tmp/sig/yo-s4i`, rc 0, typedef
at line 808 BEFORE M at 851); with `fix/sig-1`'s delta it fails (`/tmp/sig/yo-s1k`). `fix/sig-1`
touches no codegen file, so the mechanism is an evaluation-order / type-instance identity change:
the prime suspect is the branch's new origin machinery running at impl registration and signature
checking (`nominal_has_hidden_origin` flags `M` — its `&mut` field's origin is elided — and the
rigid-origin / generic-impl origin checks change which `Rc(X)` instance the checker registers
relative to `M`'s, reordering the id-keyed emission). Not yet bisected to the exact hunk.

## Expected

The type-declaration stream must order a typedef before any use (or the emitter must forward-declare);
a checker-side origin bookkeeping change may not change emitted-C ordering at all.

## Test

The G-B row itself (it must compile and run under ASan, exit 0).
