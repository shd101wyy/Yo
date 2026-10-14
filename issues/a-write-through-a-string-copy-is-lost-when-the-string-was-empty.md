# A write through a `String` copy is lost when the string was empty

**Severity:** S1: silently wrong result. Whether a write through a copy of a `String` reaches the original depends on whether the original happened to be empty, and nothing reports the lost write.

**Status: OPEN. Closed by V2b's flip (`plans/VALUES_BY_DEFAULT.md`, "Unique buffers", Generation B), not by an earlier step.** Re-triaged 2026-10-14 on seed v0.2.62. Three shapes still split silently:

- a local copy (`ta := a; ta.push_str("!")`);
- a by-value parameter (`append_copy(a)` below). It was E0908 under `plans/STRING_VALUE_SEMANTICS.md` S1, but V3b's flip (#1296) made a plain parameter an owned copy rather than a borrowed binding, so the rule no longer covers it;
- a struct-field copy (`x := Box1(s : a); x.s.push_str("!")`).

Only the `for`/`match` binding shape is a compile error (E0908, `issues/fixed/an-inout-write-through-a-borrowed-value-bypassed-e0908.md`). Since S3a, `clone()` copies the bytes whether or not the string was empty. The copy-on-write fix this doc once named was dropped (`plans/STRING_VALUE_SEMANTICS.md` §0), and so was allocate-on-empty.

**Why the fix is the flip.** `type_requires_explicit_copy` (`src/types/utils.yo`) is false for `String`, because `_plain_data_lacks_copy` returns early for any type that reaches a counted cell, and `ArrayList` is still `ref(struct(...))`. So `t := s` copies the handle and bumps the count. The design note in `plans/VALUES_BY_DEFAULT.md` (V2b, "Unique buffers", as-built plan) measured that unique buffers and the explicit-copy kind are one step. Once `ArrayList` is a value with a destructor, `String` is explicit-copy with no predicate clause: `t := s` moves, or is E0901 naming `s.clone()` when `s` is used again. Each shape above then either moves or is rejected.

A predicate clause that made buffer owners explicit-copy while `ArrayList` is still a cell (the triage's sketch, near `_plain_data_lacks_copy`) is that same flip without the representation change. It turns the roughly 3,000 implicit `String`/`ArrayList` copies in `src/` (§6's audit) into E0901 at once, so it needs the same sweep (`yo fix --migrate explicit-copy`, Generation A2) and lands with Generation B. The test that fails before and passes after (the three shapes are E0901 or moves) goes in with it.

Found 2026-10-03 while documenting `String` copies (agent-knowledge consolidation K1; DESIGN §Writing through a copy of a `String`). **Measured on:** yo 0.2.49, `--std-path ./std`; re-measured 2026-10-14 on yo 0.2.62.

## Symptom

```yo
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
