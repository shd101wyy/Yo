# An unwind drop names a shadowing local of another type

**Severity:** S1 — valid code that declares a move-only local after an inner block with a same-named local of another type emits C that drops the wrong variable on the unwind path: a C compile error once the outer type is a value (`String` after B8), and an `__yo_decr_rc` of an integer before.

Found by the B8 flip's first tree build (`vbd/b8-arraylist-string-flip-r4`, seed v0.2.73 building the flipped tree). `_lookthrough_switch_cell` (`src/codegen/exprs/match.yo`) declared `(k : usize)` inside a match arm's inner loop and `k := type_key(&bt)` (a `String`) later in the same loop body. The escape check after a call inside the inner loop emitted

```c
// Drop consumed variables (unwind propagation)
yo_id_4683339436075136311000076(&(__yo_v_k));   // String's drop, on the usize `k`
```

so clang rejected the C with `incompatible pointer types passing 'size_t *' to parameter of type '<String> *'`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ToString } :: import("std/fmt/to_string");
{ ArrayList } :: import("std/collections/array_list");
_small :: (fn(n : usize) -> bool)(n < usize(100));
_pick :: (fn(xs : &ArrayList(usize)) -> Option(String))({
  (mut(cell_key) : String) = String.new();
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
          ok = _small(k);
        });
        ok
      }
    );
    if(!simple, {
      return(.None);
    });
    k := x.to_string();
    cond(
      (cell_key.len() == usize(0)) => {
        cell_key = k;
      },
      !(k == cell_key) => return(.None),
      true => ()
    );
  });
  .Some(cell_key)
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(usize).new();
  xs.push(usize(1));
  s := _pick(&xs);
  println(match(s, .Some(v) => v, .None => String.from("none")));
});
export(main);
```

`yo compile repro.yo --std-path <B8 std>` fails in the C compiler at the escape check after `_small(k)`.

## Root cause

`src/codegen/exprs/return.yo` (the unwind-propagation drop list) keeps a deferred drop only when its target's C name is on the emitter's declared-scope stack (`scope_stack_contains(ds_s, &lv_c_name)`), the guard that stops a drop of a local whose C declaration comes after the escape point. The stack holds C names only. The outer `k` has not been declared yet at the inner escape point, but the inner `k` has the same C name (`__yo_v_k`), so the guard passes and the drop of the outer `String` is emitted against the inner `usize`. Before B8, `String`'s drop was `__yo_decr_rc((void*)…)`, which accepts any scalar, so the same code compiled and would decrement through an integer if that unwind path ran.

## Fix direction

Make the guard compare identity, not spelling: record the declaring variable (its declaration token or id) with each declared C name, and keep the drop only when the in-scope declaration is the drop target's own. In the meantime, B8 renames the outer local (`bt_key`).

## Test

The reproducer above, as a `tests/` case that compiles and runs it, goes in with the fix.
