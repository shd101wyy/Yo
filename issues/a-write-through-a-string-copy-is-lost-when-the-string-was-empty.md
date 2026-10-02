# A write through a `String` copy is lost when the string was empty

**Severity:** S1: silently wrong result. Whether a write through a copy of a `String` reaches the original depends on whether the original happened to be empty, and nothing reports the lost write.

**Status: OPEN.** Found 2026-10-03 while documenting `String` copies (agent-knowledge consolidation K1; DESIGN §Writing through a copy of a `String`). **Measured on:** yo 0.2.49, `--std-path ./std`.

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

**Recommendation:** keep the documented reference semantics. `ArrayList` has the same semantics, and existing code relies on it; the DESIGN `for(names, s => s.push_str("!"))` example is one case. The fix is that a copy of an empty `String` shares the buffer it lazily allocates, for example by making the handle itself a shared reference cell. Then update DESIGN §Writing through a copy of a `String` in en-US and zh-CN, which documents the defect.
