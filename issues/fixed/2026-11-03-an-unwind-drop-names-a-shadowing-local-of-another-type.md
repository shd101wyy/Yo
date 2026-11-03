# An unwind drop names a shadowing local of another type

**Severity:** S1 — trust of output. A function that declares a local after an inner block whose own local has the same name emits C that, on the unwind path out of that inner block, drops the later local's value against the inner local. With a value type that has a `Drop` (`String` after B8) the C compiler rejects it as a pointer type mismatch. With a reference-counted type (`String` before B8) the C compiles, and the unwind path calls `__yo_decr_rc` on an integer. When the two locals have the same type, the C compiles silently and the unwind releases the inner one twice (a double free).

**Status:** FIXED 2026-11-03 (`fix/s1-match-duplicate-labels-and-shadowed-drop`). The escape path's consumed-variable drop list now skips a target declared after the escape point.

## Symptom

The B8 flip's first tree build (`vbd/b8-arraylist-string-flip-r4`, with the v0.2.73 seed building the flipped tree) found this, and so did B9's (`vbd/b9-hashmap-flip`). `_lookthrough_switch_cell` (`src/codegen/exprs/match.yo`) declares `(k : usize)` inside a match arm's inner loop, and later in the same loop body declares `k := type_key(&bt)`, a `String` that `cell_key = k` consumes. The escape check after a call inside the inner loop emitted

```c
// Drop consumed variables (unwind propagation)
yo_id_4683339436075136311000402(&(__yo_v_k));   // String's drop, applied to the usize `k`
```

and clang rejected it with `incompatible pointer types passing 'size_t *' to parameter of type '<String> *'`. B8 works around it by renaming the later local to `bt_key`; the rename stays because the seed builds the tree.

## Reproducer

Three tests in `tests/shadowed_binding_early_return_drop.test.yo` cover it. On develop `ce827ae52`, "an unwind out of an inner loop does not drop a later same-named local" and "the same function without an unwind balances every key" fail because their batch does not compile: the C has the same `incompatible pointer types` error, since the move-only `_SbKey`'s drop takes `_SbKey*`. "An unwind before a later same-named local drops the earlier one once" compiles there, but the unwind drops the inner `k` twice (`dropped 2`). The first shape:

```yo
_sb_pick :: (fn(xs : &ArrayList(usize), limit : usize, exn : Exception) -> usize)({
  (mut(cell_key) : _SbKey) = _SbKey(n : usize(0));
  (mut(i) : usize) = usize(0);
  while(i < xs.len(), i = (i + usize(1)), {
    x := xs(i);
    simple := match(
      x,
      usize(0) => false,
      _ => {
        (mut(ok) : bool) = true;
        (mut(k) : usize) = usize(0);
        while((k < x) && ok, k = (k + usize(1)), {
          ok = _sb_check(k, limit, exn);
        });
        ok
      }
    );
    if(!simple, {
      return(usize(0));
    });
    k := _SbKey(n : x);
    cond(
      (cell_key.n == usize(0)) => {
        cell_key = k;
      },
      !(k.n == cell_key.n) => return(usize(0)),
      true => ()
    );
  });
  cell_key.n
});
```

The same-type shape (`_sb_twice`):

```yo
_sb_twice :: (fn(flag : bool, fail : bool, exn : Exception) -> usize)({
  if(flag, {
    k := _SbKey(n : usize(1));
    t := _sb_mk(fail, exn);
    return(_sb_take(k) + t);
  });
  k := _SbKey(n : usize(2));
  _sb_take(k)
});
```

## Root cause

On an escape, `generate_consumed_var_drops_for_escape` (`src/codegen/exprs/return.yo`) releases the function's consumed variables (locals a later statement moves out). A drop is kept when its target is not yet moved and its C name is on the emitter's block-scope stack (`scope_stack_contains`). That stack is how the code avoids dropping a local whose C declaration comes after the escape point. But it holds C names only. The outer `k` is not declared yet at the inner escape point, while the inner `k` has the same C name (`__yo_v_k`) and its block is still open. So the check passed and the outer `_SbKey`'s drop was emitted against the inner `usize`. The rest of the check resolves each pending drop's target by name in the cleanup point's environment (`_resolve_drop_target_in_scope`), which falls back to the last same-named variable there. That is how, in `_sb_twice`, the later `k`'s drop resolved to the inner `k` and released it a second time.

The sibling list, `_keep_pending_drop`'s escape branch, already has a positional guard for exactly this reason. It refuses a target initialized after the cleanup point (`_variable_initialized_after_cleanup_point`), citing `issues/fixed/seed-built-stage1-miscompiles-current-source.md`. The consumed-variable list never got that guard.

Shadowing an in-scope binding is rejected (`Failed to define variable "k"`), so a target declared before the escape point is never hidden behind a same-named inner local. The only way the stack can vouch for the wrong variable is a target declared after the escape point.

## Fix

`generate_consumed_var_drops_for_escape` now applies the same positional guard, keyed on the drop's own target (the variable its atom's record names), not on the by-name lookup. A named C local whose `initialized_at_token` comes after the escape point is skipped before the scope-stack check. Such a local does not exist yet when control leaves, so skipping it cannot leak.

The guard is limited to named C locals. Minted temps and state-machine fields have unique C names, so no other variable can stand in for them. A temp's recorded initialization token can also lie after its C declaration (a `cond` result that a later constructor argument consumes), so applying the guard to temps skipped their live releases. A first version did exactly that, and the `src/main.yo` emit-diff caught it.

The `src/main.yo` emit-diff against develop's binary (both compiling this tree) removes four lines in two functions, nothing else. `_compile_const_expr`'s inner `const_ty` (`src/evaluator/exprs/pattern_compile.yo`) was released twice when `_make_const_test` unwound, and so was a `t : String` in `_variant_test_code` (`src/codegen/exprs/match.yo`).

`issues/2026-11-03-an-unwind-out-of-a-later-argument-leaks-an-earlier-moved-argument.md` is a separate bug this exposed. In a shape like `_compile_const_expr`'s `return(Pattern.Const(ty : const_ty, ..., subject : _test_subject(&test), ...))`, an unwind out of `_test_subject` now leaks `const_ty` (one of the four removed lines). The old code balanced that path only by accident, because the later `const_ty`'s drop landed on the inner one.
