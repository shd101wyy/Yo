# A closure literal at a generic `&mut Impl(FnMut)` slot spills a mistyped `void*` C temp

**Severity:** S1 — every call of a capture-free closure literal at an `&mut Impl(FnMut(...))` parameter whose trait signature mentions a type variable the callee's own generics solve emits ill-typed C (`void*` temp where the specialization's capture-struct pointer is expected), breaking the compile — and, under a C compiler that does not error on `void**`→`T*`, miscompiling the call; std's `RefCell.with`/`Option.map` family taking `FnMut` (G1) turns this into self-compile breakage.

Filed 2026-11-06 by the G1 lane (`vbd/g1-fnmut-slots`): the first tree build after std's non-escaping slots switched to `&mut Impl(FnMut)` failed with 20 C errors (clang's `-ferror-limit` cap; 282 such spills in the emitted `yo.c`).

## The verbatim error

```
yo-out/x86_64-unknown-linux-gnu/bin/yo.c:103638:13: error: initializing 'void *' with an expression of incompatible type '__yo_t_14852077574508216922' (aka 'struct __yo_t_14852077574508216922_struct')
 103638 |       void* __yo_ref_spill_0 = (__yo_t_14852077574508216922){};
        |             ^                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
yo-out/.../yo.c:103639:97: error: incompatible pointer types passing 'void **' to parameter of type '__yo_t_14852077574508216922 *' [-Werror,-Wincompatible-pointer-types]
 103639 |       size_t ... = __yo_fs_5168280843951836671(__yo_seq_33, (&(__yo_ref_spill_0)));
```

## The minimal reproducer (v0.2.75 seed, any `&mut Impl(FnMut)` slot whose `R` is generic)

```yo
run :: (fn(generic(R : Type), f : &mut Impl(FnMut() -> R)) -> R)(f());
main :: (fn() -> unit)({
  n := run(() => i32(5));
});
export(main);
```

`yo compile` emits `void* __yo_ref_spill_0 = (__yo_t_N){};` and passes `(&spill)` (`void**`) where the specialized callee's `__yo_t_N*` parameter is expected. Against a `RefCell(ArrayList(i32)).with(xs => xs.len())` the same holds — that is the shape that hit the compiler's own tree (282 sites).

Non-generic slots are unaffected (`sort_by`, `retain`, `replace_with`, `Once.call`: the argument's ExprInfo type is the bound closure identity, so the spill temp is typed by the capture struct), and a literal whose closure CAPTURES anything takes the addressable-temp branch, not the spill. Empty-env literals are the whole class.

## Root cause

A closure literal's ExprInfo type is bound from the slot's expected type. When the trait signature still mentions an OPEN type variable (`FnMut() -> R` of a `generic(R)` callee — also `FnMut(a : &T) -> B` of `Option.map`, `RefCell.with`), the identity binding (`is_bound_closure_identity` requires "no open type variable inside") fails and the ExprInfo type stays the abstract `Impl`, whose C lowering is `void*`. The specialization's CALLEE side knows the concrete capture struct (its parameter is `__yo_t_N*`), but the caller-side `_apply_ref_amp` ref-spill branch (`src/codegen/exprs/other_fn_call.yo`) takes the spill temp's C type from the ARGUMENT's ExprInfo type — `void*` — while the spilled VALUE is the concrete capture-struct compound literal `(__yo_t_N){…}` the closure-literal emitter already recovers the correct type for (`generate_closure_construction`'s capture-free branch does exactly this, with a comment describing this very "unresolved SomeT lowers to void*" hazard).

## The fix

`_closure_ref_spill_c_type` (`src/codegen/exprs/other_fn_call.yo`): when the spill's default C type is `void*`/`void` and the argument is an anonymous closure definition, take the type from the closure's registered capture info — the ExprInfo's `capture_type` first, then `get_closure_capture_info(fid)` (the FuncVal recorded on the definition's `value`; always present, an empty struct for capture-free closures) — mirroring the emitter's own precedence. The spill then declares `__yo_t_N __yo_ref_spill_k = (__yo_t_N){};` and `&spill` matches the specialization's parameter.

## The bootstrap window

The seed compiles the tree, and v0.2.75's codegen has the bug, so the tree's OWN ~300 empty-env reads at `with`/`map`-shaped slots must not spell the literal until a published seed carries the fix. They spell a NAMED function value instead, which fills an `FnMut` slot with no capture env (a different specialization: the callee takes a function pointer):

- `std/sync/refcell.yo` exports the `cell_*` filler family (`cell_list_len`, `cell_map_len`, `cell_value_clone`, …) for the common one-read bodies.
- `std/async/channel.yo` has `_ch_*` fillers for its `_ChannelState` reads; a handful of sites use file-local concrete helpers (`_mm_count_keys`, `_ttm_keys`, `_finished_walk_values`, `_pending_heads_has_empty`, …) where a generic filler's re-spelled `K` bounds break a chained `.into_iter()`.

Delete the fillers and inline the literals back once `SEED_VERSION` carries the fix (tracked in `plans/backlog/SEED_VERSION_AUTOMATION.md`).

## The test that fails before and passes after

`tests/fn_mut.test.yo`, "a capture-free literal at a generic FnMut slot compiles and runs": `run(() => i32(5))` over `run :: (fn(generic(R : Type), f : &mut Impl(FnMut() -> R)) -> R)(f())`. Before the fix the C compile of the test binary fails with the incompatible-pointer errors above; after it the test runs and asserts `5`.
