# Two codegen faults surfaced by `std/fmt/format.yo` (D3.10 Stage 1)

**Status:** OPEN — they block merging D3.10's engine, which is otherwise written
and passing for `String`, the integers, the floats and `bool`.
**Found:** 2026-08-25, implementing STD_API_AUDIT D3.10 on branch
`std/d310-format-specs`.

## Fault 1 — a blanket-impl result loses its body when bound to a local

`issues/repros/format-blanket-body-lost-when-result-bound.yo`:

```rust
a := Option(i32).Some(i32(4)).format(">10");
b := `   Some(4)`;
// a=[          ] len=10     <-- ten spaces; the text is GONE
// b=[   Some(4)] len=10
// eq=false
```

The padding is applied (length 10 is correct) but the body renders empty — the
String's buffer is dead while its length field survives, i.e. a use-after-free of
the body String.

It is NOT simply "inout receiver on a temporary" and NOT simply "an owning String
argument to a method on a temporary receiver": both were reproduced in isolation
and both work (`tmp/pfb.yo`, `tmp/pfc.yo`, `tmp/pfd.yo` shapes). What distinguishes
the failing case:

- the receiver type is `Option(i32)` — the same call on `String`, `i32`, `u8`,
  `f64` and `bool` is CORRECT, so it depends on the `ToString` impl that produces
  the body (Option's builds its String through template strings);
- the result must be BOUND to a local. Passing the same call straight into
  `println(...)` prints correctly, and binding the RECEIVER first
  (`o := Option(i32).Some(i32(4)); o.format(">10")`) is also correct;
- binding the intermediates inside the blanket body (`s := FormatSpec.parse(spec);
  body := self.to_string(); s.pad(body, …)`) does NOT fix it.

So the trigger needs `pad`'s full shape — a `(text : String) = body` rebinding, a
possible reassignment in a match arm, and a free function that writes `text` into
a `StringBuilder` — plus a body String produced by a generic `ToString` impl.

## Fault 2 — calling `FormatSpec.pad` with a local String emits invalid C

`issues/repros/formatspec-pad-local-string-invalid-c.yo`:

```
error: member reference type '__yo_t9 *' (aka 'struct __yo_t9_struct *') is a pointer
```

Emitted for a straightforward user-level call:

```rust
t := Option(i32).Some(i32(4)).to_string();
p := FormatSpec.parse(">10").pad(t, Alignment.Left);
```

A `.`-access is emitted against a pointer without dereferencing it. This is a
plain codegen defect, independent of Fault 1, and it is reachable from ordinary
user code — it does not need the blanket impl.

## Why this blocks the merge

`format` returning padding-only for a whole class of values is a SILENT wrong
answer, not a compile error. Shipping the engine with tests that route around the
broken shape would be exactly the kind of workaround this campaign forbids, so
the branch stays unmerged until these are fixed.

The engine itself is verified correct on every other shape:

```
[     abc] >8      [****xy] *>6      [abc] .3
[-0000042] 08      [0x00ff] #06x     [FF] X      [101] b
[3.14] .2          [    -3.142] >10.3
[-8000000000000000] i64.MIN in hex   [  true   ] ^9
```
