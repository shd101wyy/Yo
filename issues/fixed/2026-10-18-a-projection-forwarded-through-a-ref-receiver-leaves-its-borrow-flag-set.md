# A projection forwarded through a `ref` receiver leaves its borrow flag set, so the next container call panics

**Severity:** S2. A correct program panics at run time. A plain value container works, and `ref(...)` goes away at V5.

Filed 2026-10-18 while deciding `issues/retired/borrowed-for-over-user-defined-collections.md`. Found with a develop-built compiler (`29ceb209d` plus #1440's branch). Fixed the same day; the trace below corrects the filed guess ("not yet traced").

## Symptom

The repro is `issues/repros/2026-10-18-projection-forwarding-through-a-ref-receiver.yo`. A user collection `Bag :: ref(struct(items : ArrayList(i32)))` implements `BorrowedWalk`. Its `walk_elem` forwards the list's own projection:

```yo ignore
walk_elem : (fn(self : &mut Self, cur : &usize) -> &mut i32)(&mut self.items(cur)),
```

`for(&mut bag, x => { x = (x * i32(10)); })` compiles. At run time it aborts:

```
panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it
```

The same code with `Bag :: struct(items : ArrayList(i32))`, a plain value, compiles and runs correctly: it prints `10`.

## Cause (traced 2026-10-18)

Not a flag left set by the returned projection — a FALSE entry assert tripped by the loop's own guard:

1. The borrowed `for` desugars to a cursor loop whose guard object (`__borrow_guard(c)`) ACQUIRES the container's runtime borrow flag for the whole walk and releases it in its dispose (`std/prelude.yo`'s `for` macro; a `ref` collection has a header flag to acquire, a value one does not — V2b A1, #1384).
2. `walk_elem` is a method of the RC object with `self : &mut Self` and a projection tail. `rewrite_projection_tails` (decision 24) rewrites the tail `&mut self.items(cur)` into a synthesized `addr_of(place)` node whose token carries the `auto-generated://projection-mut` marker path.
3. The per-parameter mutation mask (`function_param_mutation_mask`, `src/evaluator/effects/mutation_summary.yo`) did not recognize that node: its head `addr_of` is neither the call-site borrow marker (`&`/`&mut`) nor a pure builtin, so both `_MsP.walk` and `_MsP.classify` bailed to "unresolved = all" (`YO_DEBUG_BORROW_MASK=1` showed `[borrow-all] walk: addr_of((self.items)(cur))` and `classify-unresolved`).
4. Codegen therefore emitted an entry `__yo_borrow_assert_unborrowed((void*)(*self))` on `walk_elem` (`_maybe_emit_method_entry_borrow_assert`), and the FIRST `walk_elem` call of the loop saw the guard's count and panicked. The same false positive put an entry assert on EVERY projection-tail method of an RC object, and made the evaluator's D3/E0908 paths assume such a callee "may write" every borrowed argument.

## Fix

Two halves, one per consumer of the analysis:

1. **The mask gets precise instead of `all`** (`src/evaluator/effects/mutation_summary.yo`): `_msp_is_projection_tail` recognizes the synthesized node, and every analysis walk (`_MsP.classify`, `_MsP.flowing`, `_MsP.collect`, `_MsP.strict_walk`, `_MsP.walk`, `_rcw_crossing`, `_gr_walk`) reads through it as through a call-site borrow marker. `_MsP.walk` additionally records what a `&mut` tail really grants: the caller may WRITE through the rooted parameter's storage, so the tail marks exactly that parameter (`_msp_mask_add_root` of the operand's root) — the E0908 write-through check and decision 18's local-borrow writes keep firing (`tests/index.test.yo`'s `_v2b_mut_projection_of_shared`, a write through a `&T` receiver, stays an error), while a `&` tail marks nothing.
2. **The entry assert skips a mut projection** (`src/codegen/functions/generation.yo`, `_maybe_emit_method_entry_borrow_assert`): a `-> &mut T` method hands the caller an interior borrow of its receiver, so it runs while its own caller already holds the container's flag — the same exemption `is_index_entry_method` gives the `Index` twin. Reallocation still asserts (callees' own entry asserts, the realloc/free auto-assert), and a genuinely-mutating non-projection method (`bump_version`, a field store) keeps its assert: `tests/cli-cases/inout-self-method-under-borrow-panics` still panics.

Safety: only the synthesized node is recognized (`projection_tail_mode` matches the auto-generated token path; a user-spelled `addr_of` keeps today's treatment).

V5 assessment: not entangled. The fix corrects a false positive of the may-mutate analysis under the CURRENT `ref` semantics; when V5 removes `ref` the user collections become values (no flag, no assert either way), and the analysis stays correct for the `Rc` shapes that remain. Landing the test's value-`Bag` conversion at V5 is therefore unnecessary.

## Test

`tests/for_macro_borrow_user_collection.test.yo` gains `FwdBag :: ref(struct(items : ArrayList(i32)))` whose `walk_elem` forwards `&mut self.items(cur)`: the borrowed `for` runs, mutates elements in place, and a container call after the loop proves the guard released the flag. Panics before the fix (the loop's first `walk_elem` aborts the binary), passes after.
