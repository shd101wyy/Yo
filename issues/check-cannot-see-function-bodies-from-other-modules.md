# `yo check` cannot see function bodies from other modules, so body-walking rules reject valid code

**Severity:** S2 — `check` rejects valid programs that `compile` accepts: a thread closure calling an imported function fails E0906, and a `pragma(Pragma.StrictBorrow)` loop calling a read-only method is rejected

**Status:** OPEN (root cause measured; fix designed, not yet implemented).
**Found:** 2026-09-29, the `yo check --test-bodies` census (`plans/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`
§3.3, site #8): `tests/thread_pool.test.yo`, `tests/sync/channel.test.yo`, `tests/sync/once.test.yo`
and `tests/imm_threading.test.yo` fail strict with E0906. The same error fires for an ordinary
function under plain `check`, so this is not specific to test bodies.

## Symptom (measured, the Phase 3 step 7 branch; develop behaves the same)

```rust
{ assert } :: import("std/assert");
{ ThreadPool, spawn } :: import("std/thread");
{ AtomicI32, MemoryOrder } :: import("std/sync/atomic");
main :: (fn() -> unit)({
  pool := ThreadPool.new(usize(2));
  value := 42;
  seen := AtomicI32(i32(0));
  spawn(pool, io => {
    assert(value == 42, "visible");
    seen.store(value, MemoryOrder.Release);
    ()
  });
  pool.join_all();
});
export(main);
```

```
$ yo check main.yo
error[E0906]: This closure runs on another thread (it is bound to a Send closure type) but calls
'assert', which has a body that was never evaluated (a forward reference?) — …
$ yo compile main.yo --optimize 2 -o a.out     # rc=0, and the program runs
```

The same closure calling `println` passes `check` (std/fmt is an audited file, so the walk trusts
it without looking at the body). Calling `assert` once before the spawn does not help.

## Second symptom: StrictBorrow (measured)

`tests/for_macro_borrow_strict.test.yo` fails strict. The same shape in an ordinary function fails
plain `check` and passes `compile`, which runs and prints `1`:

```rust
pragma(Pragma.StrictBorrow);
Bag :: ref(struct(items : ArrayList(i32)));
impl(Bag,
  iter : (fn(self : Self) -> ArrayListIterPtr(i32))(self.items.iter()),
  total : (fn(self : Self) -> i32)({ t := i32(0); for(self.items, x => { t = (t + x); }); t }));
main :: (fn() -> unit)({
  bag := Bag(items : xs);
  for(bag, inout(x) => { seen = (seen + bag.total()); });   // check: "may mutate … borrowed by this loop"
});
```

`total` is read-only, but its per-parameter mutation mask is built by walking the bodies it
calls: std's iterator methods, whose ExprInfo is in another module's table under `check`.

## Root cause

Both are walks over a callee's evaluated body. Rule D1's reach walk (`function_reaches_non_send_global`,
`src/evaluator/effects/mutation_summary.yo`) descends into each callee's body and judges it
"never evaluated" when the body has no ExprInfo in the walk's table:

```rust
if(expr_info_table_get(table, ast_expr_id(body)).is_none(), {
  return(Option(String).Some(String.from("has a body that was never evaluated …")));
});
```

The walk looks in the CALLER's table. `compile` routes every module's metadata into one shared
table (`g_shared_expr_info_table`, `src/module_manager.yo`), but `check` and `test` give each
module its own throwaway table (so a one-shot `check ./src` can release a finished module's
context). Under `check`, a callee defined in another module (here `assert`'s specialization,
evaluated in `std/assert.yo`'s table) is therefore always "never evaluated".

## Fix direction

Retaining foreign tables would give `check` compile-sized memory. Instead, compute each function's
summaries while its own module's table is alive: for D1, the non-Send globals its body reaches
directly and the callee fids it calls; for StrictBorrow, the mutation mask (`g_msp_by_fid`). The
walks then compose summaries across fids instead of re-walking a body from another module's
table. Whatever the mechanism, `check` and `compile` must give the same verdict.

## Test

When fixed: `tests/cli-cases` cases that `check` both programs above (rc=0), plus `check
--test-bodies` over the five test files above.
