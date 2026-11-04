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

## Status

Open. The test (a `HashMap(String, Span)` insert, overwrite and `try_insert`, in `tests/`) lands with the fix.
