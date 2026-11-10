# A named fn at an `Impl(Fn)`/`Impl(FnMut)` slot inside a generic body is referenced but not emitted

**Severity:** S1 — legal code fails to build with C `undeclared identifier` errors (the call to the slot's specialization is emitted, its definition is not); no wrong code, but the shape is unwritable until fixed.

Filed 2026-11-07 by the G1 lane (`vbd/g1-fnmut-slots`): rewriting `std/async/channel.yo`'s state reads as named functions at `RefCell.with`'s `&mut Impl(FnMut)` slot made `tests/async/channel.test.yo` and `tests/async/combinators.test.yo` fail to compile on a develop-based tree binary (the v0.2.75 seed emits them fine; a develop-tip binary reproduces — the impl-method facet is a develop regression, the free-generic-fn facet is older).

## The verbatim error

```
./tests/async/.yo_selftest_batch_1286557_1_0.bin.c:15551:52: error: call to undeclared function '__yo_fs_10533534717290903079'
 15551 |   size_t ... = __yo_fs_10533534717290903079(...->_u42_, (&(yo_id_6867924218380027344000000)));
        |                                                    ^
./tests/async/.yo_selftest_batch_1286557_1_0.bin.c:15551:132: error: use of undeclared identifier 'yo_id_6867924218380027344000000'
```

The named helper's specialization (`yo_id_6867…`) and the slot's specialization over it (`__yo_fs_1053…`) are both referenced and neither is declared: exactly one use of the symbol exists in the emitted C.

## The minimal reproducer (16 lines; fails on v0.2.75 AND develop-tip)

```yo
{ RefCell } :: import("std/sync/refcell");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
_P21Box :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(_st : Rc(RefCell(ArrayList(T))))
);
_p21_len :: (fn(generic(T : Type), xs : &ArrayList(T)) -> usize)(xs.len());
_p21_len_of :: (fn(generic(T : Type), self : &_P21Box(T)) -> usize)(
  self._st.with(_p21_len)
);
main :: (fn() -> unit)({
  b := _P21Box(i32)(_st : Rc.new(RefCell(ArrayList(i32)).new(ArrayList(i32).new())));
  println(`${_p21_len_of(&b)}`);
});
export(main);
```

Call `_p21_len_of` from a NON-generic fn instead (or pass a closure literal instead of the named fn) and it compiles, links and runs. The same shape inside an `impl` method (`Channel(T).len`'s `self._st.with(_ch_buf_len)`) compiles on the v0.2.75 seed but not on develop-tip (battery 2026-11-06-era), i.e. the impl-method path regressed on develop while the free-generic-fn path was already broken on the seed.

## Root cause

Not the slot and not the generic BODY: a GENERIC named function (`generic(T : Type)` binder) passed as a value at ANY function-typed slot is never specialized. `apply(idf, i32(3))` with `apply :: (fn(f : (fn(a : i32) -> i32), v : i32) -> i32)` and `idf :: (fn(generic(T : Type), x : T) -> T)(x)` passes `check` and emits C naming the TEMPLATE's `yo_id_<id>`, which is never declared. Only a CALL of a generic function mints a specialization (the binders are inferred from the arguments' types); an argument that is the function VALUE has no call, so its `FuncVal` stays the template. A closure literal is unaffected (it has no binders), and a call from a non-generic body only looked fine because the slot there is typically a literal.

The earlier hypothesis here (the closure-collection pre-pass `register_impl_closure_call_mappings` skipping named fns) was wrong: the specialization is never created, so there is nothing for any pre-pass to register. The impl-method facet that "regressed on develop" is the same bug; the seed only differed in the order it evaluated the slot.

A related pre-existing facet, same family: FORWARDING a named fn through an `f : &mut Impl(FnMut(...))` parameter and calling the slot through it emits `&(fn)` where the specialization's function-pointer parameter is expected (`void**`→`T(*)(...)`, fails on seed and develop alike - 12-line repro in the G1 worktree's `tmp/p20.yo`). Not fixed by this change.

## Fix

`specialize_generic_function_at_slot` (`src/evaluator/calls/helper.yo`) specializes the function at the slot's signature, as Rust instantiates a generic `fn` item when it coerces to a function pointer (not eta-expansion: the argument stays the named function). It runs where an argument meets its parameter, in both call paths (`check_if_function_parameter_matches_argument` for method calls and `try_to_call_function_with_arguments`, and the inline `FuncVal` arm in `calls/function.yo`). When the slot's parameter types are concrete after resolution it CALLS the function in a scratch frame on one binding per slot parameter (`&v`/`&mut v` where the slot lends), so the ordinary call machinery infers the binders and mints and records the specialization; the specialized `FuncVal` and its type replace the argument's. A slot whose parameter types still name a type variable is left alone.

## The G1 workaround (seed window, deletable)

`std/async/channel.yo`'s ten state reads spell a capture-carrying literal (`ch._st.with({ h : &ch._st }(s) => …)`) instead: a non-empty capture env takes the addressable-temp branch (no ref-spill under a pre-fix seed) and closure literals inside generic/impl bodies ARE emitted on every binary. Inline the plain literals back once this issue and
`issues/fixed/2026-11-06-a-closure-literal-at-a-generic-fnmut-ref-slot-spills-void.md`
are fixed (tracked together in `plans/backlog/SEED_VERSION_AUTOMATION.md`).

## The test that fails before and passes after

`tests/fn_mut.test.yo`: "a generic named fn at a plain function-typed slot is specialized at the slot" and "a generic named fn at an FnMut slot inside a generic body is emitted" (the `_p21_len_of` shape above). Both failed to build with the errors above before the change. `tests/async/channel.test.yo` and `tests/async/combinators.test.yo` keep passing; the capture-carrying literals in `std/async/channel.yo` can be inlined back to plain named functions once the seed carries this fix.
