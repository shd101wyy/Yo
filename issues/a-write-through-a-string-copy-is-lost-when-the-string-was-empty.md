# A write through a `String` copy is lost when the string was empty

**Severity:** S1: silently wrong result. Whether a write through a copy of a `String` reaches the original depends on whether the original happened to be empty, and nothing reports the lost write.

**Status: OPEN, partly fixed.** Since `plans/STRING_VALUE_SEMANTICS.md` S1, the parameter, `for` and `match` shapes below are compile errors (E0908, `issues/fixed/an-inout-write-through-a-borrowed-value-bypassed-e0908.md`). Since S3a, `clone()` is the independent copy: it copies the bytes whether or not the string was empty. A plain local copy (`t := s; t.push_str("!")`) still shows the split: measured 2026-10-05 on the S3a tree with yo 0.2.52, `a := String.new(); ta := a; ta.push_str("!")` leaves `a == ""`, while the same with `String.from("hi")` makes `b == "hi!"`. The copy-on-write fix this doc once named was dropped (`plans/STRING_VALUE_SEMANTICS.md` §0). The last shape closes in `plans/VALUES_BY_DEFAULT.md` V2b, where `t := s` becomes a move, or an error naming `s.clone()` when `s` is used again. Found 2026-10-03 while documenting `String` copies (agent-knowledge consolidation K1; DESIGN §Writing through a copy of a `String`). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

append_copy :: (fn(out : String) -> unit)({
  out.push_str("!");
});

main :: (fn() -> unit)({
  a := String.new();
  append_copy(a);
  b := String.from("hi");
  append_copy(b);
  println(`"${a}" "${b}"`); // prints "" "hi!"

  names := ArrayList(String).new();
  names.push(String.new());
  names.push(String.from("n"));
  for(names, s => {
    s.push_str("!");
  });
  println(`"${names(usize(0))}" "${names(usize(1))}"`); // prints "" "n!"
});
export(main);
```

The write through the copy of `b` reaches `b`, and the one through the copy of `a` does not. The `for` loop shows the same split per element.

## Cause

`String` wraps an `Option(ArrayList(u8))` buffer. A copy copies the handle, so a non-empty string's copies share the `ArrayList`. An empty string has `.None`, so the first write through a copy allocates a fresh buffer in that copy alone.

## Expected

One semantics for every `String`. DESIGN §Type inference states reference semantics: a copy and its original "point to the same object". Under that rule a write through a copy is visible whether or not the string was empty. The alternative is value semantics, with copy-on-write or eager cloning, under which neither write is visible. Either is consistent; today's mix is not.

**Decision amended 2026-10-05 (maintainer):** value semantics through unique ownership (Hylo's model), not copy-on-write (`plans/STRING_VALUE_SEMANTICS.md` §0, `plans/VALUES_BY_DEFAULT.md` §0). `clone()` copies eagerly and `t := s` becomes a move or an error. The 2026-10-03 decision, value semantics with copy-on-write, read: Neither write is visible through the original, and empty strings stay allocation-free. The plan is `plans/STRING_VALUE_SEMANTICS.md`. It supersedes an earlier recommendation in this doc, which was to keep the reference semantics that DESIGN §Type inference stated. That earlier choice would have made every empty `String` allocate a shared buffer, and it contradicted `std/string`'s own design: its mutators take `inout(self)`, and the module says "an empty `String` allocates nothing".
