# HashMap's `walk_ref` reads an unoccupied bucket in safe code

**Severity:** S1 — a safe-code program that calls `walk_ref` on a `HashMap` bucket with no entry passes `check` and reads uninitialized memory (a SEGV under ASan).

- Filed: 2026-11-13 (lane g2, G3; Fable consult `VERDICTS-59` decisions 5 and 8, probe `probe-59/q2.yo`).
- Shipped in: every release that exported the `BorrowedWalk` trait, v0.2.65 through v0.2.77. `HashSet`'s walk delegated to the same code.
- Fix: G3 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md`, v0.2.78) deletes `BorrowedWalk` and every `walk_*` member.

## Reproducer

`issues/repros/2026-11-13-hashmap-walk-ref-reads-an-unoccupied-bucket-in-safe-code.yo`:

```yo ignore
(mut(m) : HashMap(String, String)) = HashMap(String, String).new();
m.insert(String.from("k"), String.from("v"));
(mut(i) : usize) = usize(0);
while(i < usize(8), i = (i + usize(1)), {
  if(m.walk_valid(&i), {
    e := m.walk_ref(&i);
    k := e.key.clone();
    println(&k.len());
  });
});
```

On v0.2.77, `yo check` accepts it. Compiled with `--sanitize address --allocator system`, the program dies with a SEGV in `String.clone` on the first unoccupied bucket.

## Root cause

The walk cursor is a plain `usize`, and `walk_valid` checks only `cur < capacity`. `walk_ref(&cur)` returns a `&MapEntry(K, V)` over bucket `cur` whether or not the bucket holds an entry. The member is public, and calling it needs no `unsafe`. That makes it a memory-safety hole in safe code (claim (S), VERDICTS-58 decision 4).

The walk's documented semantics were also unsound for its own callers. A rehash during a walk "can reorder what is left to visit", so an entry can be skipped or visited twice. The compiler's eight codegen registry walks relied on it.

## Fixed

G3 deletes the `BorrowedWalk` / `BorrowedWalkMut` traits and every std impl of them (`HashMap`, `HashSet`, `ArrayList`, `Deque`, `OrderedMap`, `BTreeMap`, `PriorityQueue`). It does not keep the methods as inherent members.

The eight codegen sites in `src/codegen/functions/declarations.yo`, `src/codegen/functions/constructors.yo` and `src/codegen/types/generation.yo` now walk differently:

- Six sites walk a `keys_cloned()` snapshot. The on-demand hook declares a type registered during a pass itself and records it in `on_demand_body_cnames`, so a pass need not visit it.
- Two read-only sites (`_deferred_decl_cnames` and the collecting pass of `generate_type_declarations`) are plain borrowed `for(&context.types, …)` loops.

The emitted C was byte-identical before and after the change (VERDICTS-59 decision 7).

Test: `tests/for_macro_borrow.test.yo` (`hashmap_walk_ref_is_gone`) is the reproducer as a rejected program: `No method "walk_valid" on HashMap(String, String)`.
