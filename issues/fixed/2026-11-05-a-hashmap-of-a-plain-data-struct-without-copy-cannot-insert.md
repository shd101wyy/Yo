# A `HashMap` whose value is a plain-data struct without `Copy` cannot insert

**Severity:** S2 — a valid program is rejected: `HashMap(K, V).insert` and `try_insert` fail inside std when `V` is a struct of `Copy` fields that does not derive `Copy`; the workaround (`derive(V, Copy, Clone)`) is wrong for a type that is written through element copies.

Found 2026-11-05 by V5 part B (the `ref`-declaration migration), on develop `5aa0e1800`, with the v0.2.74 seed and with the tree's std (`--std-path ./std`).

## Reproducer

```yo
{ String } :: import("std/string");
{ HashMap } :: import("std/collections/hash_map");
Span :: struct(lo : u64, hi : u64);
main :: (fn() -> unit)({
  mut(m) := HashMap(String, Span).new();
  _ := m.insert(String.from("a"), Span(lo : u64(1), hi : u64(2)));
});
export(main);
```

`yo check repro.yo --test-bodies --std-path ./std`:

```
error[E0901]: use of moved value: cannot copy what `HashMap(String, Span).insert` copies (its element), whose type `Option(V)` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is borrowed (a `&T` parameter or a `match`/`for` binding), and a borrow cannot give the value away.
...
note: raised here, inside the standard library
    --> std/collections/hash_map.yo:704:20
704 |       .Ok(prev) => prev,
```

`m.try_insert(...)` instead fails with E0907 (`Variable "value" is moved in some arms but not in others`) inside `try_insert`.

## What is and is not affected

- The same struct with a `String` field inserts fine, and so does `ArrayList(String)` as `V`: only a struct whose fields are all `Copy`, without `derive(Copy)`, fails (move-only by decision 36's "plain data without `Copy`" rule, but with no drop glue).
- `derive(Span, Clone)` does not help (the message becomes "copied only explicitly"); `derive(Span, Copy, Clone)` does.
- The same `match(<owned temporary>, .Ok(prev) => prev, …)` shape in user code, generic or not, is accepted. Only the std body evaluated for this instantiation rejects it.

## Why it matters

V5 part B turns `ref(struct)` declarations into plain structs. A written record of `Copy` fields kept in a map (`_LiveVar` in `src/codegen/async/state_machine.yo`, `HashMap(String, _LiveVar)`) hits this. Deriving `Copy` makes it compile, but a written type must stay move-only so that the checker flags every element copy that a write goes through (`match(w.vars.get(id), .Some(lv) => { lv.last = at; })` writes a copy and loses the write silently once `_LiveVar` is `Copy`).

## Root cause

The two errors have two separate causes. Both are in the evaluator, and neither is in `std`.

1. **E0901 (`insert`): a type built by an instantiated generic body was judged as generic.**
   - A generic body evaluated for `V := Span` builds `Result(Option(V), HashMapError)`. Its payload is the concrete `Option(Span)`. Its type argument keeps the definition-era `Option(V)`, with the impl's own `V` still open, because `substitute` rewrites a compound enum type argument only at a phantom position.
   - `type_lacks_copy_for_flip` (`src/evaluator/trait_checking.yo`), decision 36's flip, answered "copies implicitly" for every type that mentions a type variable. Its impls cannot judge such a type: asking `Copy` of `Option(V)` binds the impl's `T` to the variable.
   - So the scrutinee of `match(Self.try_insert(...), .Ok(prev) => prev, …)` read as copyable and was borrowed (`_decide_match_mode`). Its binding `prev`, whose type is the concrete payload `Option(Span)`, read as move-only. The arm could neither copy `prev` nor move it out of a borrow.
   - The same shape fails with no `std` involved: a generic impl matching `.Some(prev) => prev` on its own `Option(Option(V))` result. A scrutinee whose type is `Option(V)` or `Result(V, E)` worked, because a bare variable argument is substituted.
   - A `String` field hid the bug: a type that owns a buffer is move-only by `type_is_move_only`, which walks payloads.
2. **E0907 (`try_insert`): a parameter's own re-bind read as another value.**
   - A struct-literal argument (`Span(lo : …, hi : …)`) folds to a constant. A specialized body then re-binds the parameter beside its owning binding, as a non-owning shadow (`calls/helper.yo`).
   - The `cond`/`match` join elaborates "moved in some arms" into a drop in the arms that keep the value (`_drop_in_arms_that_keep`). It refused whenever another variable of the same name was visible in such an arm, the guard against a pattern binding that shadows the name.
   - The shadow tripped that guard, so `.Err(err) => .Err(err)` (which keeps `value`) beside `.Ok(_) => { … value … }` (which moves it) was E0907.
   - An argument that does not fold (a struct with a `String` field built at run time, `String.from(...)`) gets no shadow, which is why those cases worked.

## Fix

- `type_lacks_copy_for_flip` judges a type that mentions a type variable by its parts (`_flip_part_lacks_copy`): a field, a variant payload, an element, or a resolved variable's resolution.
  - A `Copy` impl needs every part `Copy`, so one plain-data part without `Copy` makes the whole explicit-copy.
  - The walk skips a part that holds a cell or a move-only value; such a part is judged by its own rules.
  - It does not enter a pointer, a reference or a cell.
  - A type whose parts all copy still copies implicitly, as before. A part that is an open type variable is judged per instantiation.
- `_drop_in_arms_that_keep` no longer counts the parameter's own non-owning re-bind as another value (`_is_param_rebind_of`: a parameter of the same name, owning nothing, bound in the owning parameter's frame). A drop through the re-bind moves the owning binding, as every other move through it does (`_move_through_sink_shadow`).

## Tests

- `tests/move_only_collections.test.yo`, "HashMap of a plain value with neither Copy nor Clone: insert, overwrite, try_insert, remove": `HashMap(String, _McTok)`, where `_McTok` is a struct of an `i32` with neither `Copy` nor `Clone`.
- `tests/copy_trait.test.yo`, "Copy: a generic body moves a plain payload out of a nested Option result":
  - The generic-impl shape without `std`: it moves `prev` out at `V := _CtNoClone`.
  - The same `Option(Option(V))` copies at `V := i32`.

Both failed before the fix (E0901 at `hash_map.yo:704`, and at the test's own arm).

## Status

Fixed.
