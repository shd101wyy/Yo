# A caller's `unsafe(...)` region admits raw-pointer and union reads in a safe file's generic body

**Severity:** S2 — a file without `pragma(Pragma.AllowUnsafe);` can contain a raw-pointer dereference or a union-member read inside a generic function body, and `yo check` accepts it whenever a pragma'd caller invokes that function inside `unsafe(...)`, so the "a safe file holds no unsafe operation" promise depends on who calls it.

**Status:** open. Found 2026-10-22 in review of `feat/drop-in-place`, whose `___drop` gate had the same shape and was fixed there (`issues/fixed/2026-10-21-the-drop-builtin-is-callable-outside-unsafe.md`). Pre-existing: the v0.2.67 seed accepts both reproducers.

## Reproducer

`issues/repros/2026-10-22-a-callers-unsafe-region-admits-raw-pointer-and-union-reads-in-a-safe-files-generic-body/`. `rawderef_lib.yo` and `union_lib.yo` declare no pragma:

```yo
read_through :: (fn(generic(T : Type), p : T) -> i32)(p.*);
export(read_through);
```

```yo
U :: union(i : i32, b : bool);
read_b :: (fn(generic(T : Type), x : T) -> bool)({
  u := U(i : i32(2));
  u.b
});
export(U, read_b);
```

`rawderef_main.yo` and `union_main.yo` declare the pragma and call `unsafe(read_through(addr_of(x)))` / `unsafe(read_b(i32(0)))`.

- `yo check ./rawderef_lib.yo`, `yo check ./union_lib.yo`: evaluator OK (the generic bodies are evaluated at their call sites).
- `yo check ./rawderef_main.yo`, `yo check ./union_main.yo`: evaluator OK. Expected: the dereference / union read is rejected at the library's line, because that file has no pragma.
- `yo check ./union_safe.yo` (no pragma, no `unsafe(...)`): rejected with "Reading union member `b` of `U` requires `pragma(Pragma.AllowUnsafe);` in this file", pointing into `union_lib.yo`. So the gate already reports the library's location; only the caller's region changes the verdict.

## Root cause

The raw-pointer dereference gate (`src/evaluator/exprs/property_access.yo`, the `.*` branch) and the union-read gate (`is_union_member_read_capable`, `src/evaluator/memory_safety.yo`) accept when `ctx.unsafe_context || is_implicitly_unsafe_capable_file(<token's module>)`. `ctx.unsafe_context` is the dynamic state of the evaluation, not a property of the code being checked: a generic body is evaluated at each call site, so it inherits the caller's `unsafe(...)` region even though the body is written in another file. The `*(T)` type gate (`src/evaluator/calls/pointer.yo`) has the same disjunct.

`unsafe(...)` is itself rejected outside a pragma'd file, so for code written in the same file as the region the disjunct adds nothing; it only matters when the evaluated code comes from another file.

## Fix direction

Decide admission from the token's own file, as `is_destroying_builtin_call_capable` now does, or make `ctx.unsafe_context` lexical (cleared when evaluation enters a body defined in another module). Either fix needs `yo check ./std` and `./src` re-run, because std generic bodies are the main callers of these gates (they are all in pragma'd files, so a file-based gate should admit them unchanged).
