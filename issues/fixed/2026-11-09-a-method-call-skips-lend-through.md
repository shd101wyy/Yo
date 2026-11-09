# A method call skips `lend_through`, so a store through `&mut self` widens a named holder's origin

**Severity:** S1: `yo check` accepts a program that is a heap-use-after-free under ASan; safe code, no `unsafe`, on develop and the v0.2.76 seed.

Found by G-E (O-6 of `plans/backlog/BORROW_CHECKER_COMPLETENESS.md`) while auditing
the call-argument sink: `lend_through` returns at once when the callee is a
`.`-access, so O3 step 3 (an origin reached through a `&mut` pointee is
invariant) is applied to free functions only. §5's call row says the receiver
counts as an argument.

## Reproducer

The corpus row `tests/origins/corpus/method-store-widen-named-holder.yo`
(`store-widen-named-holder`, which O-2 closed for `put(&mut s, &y)`, written as
a method):

```yo
{ println } :: import("std/fmt");
_Slot :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(dst : &mut Option(&(i32, p))));
impl(
  generic(p : Origin),
  _Slot(p),
  put : (fn(self : &mut Self, v : &(i32, p)) -> unit)({
    self.dst.* = .Some(v);
  })
);
main :: (fn() -> unit)({
  a := i32(1);
  mut(slot) := Option(&(i32, a)).Some(&a);
  mut(s) := _Slot(a)(dst : &mut slot);
  {
    yb := Box.new(i32(2));
    s.put(&yb.*);
  };
  match(slot, .Some(r) => println(`OUT: ${r.*.to_string()}`), .None => println("none"));
  ()
});
export(main);
```

`yo check` accepts it, and so does the qualified spelling
`_Slot(a).put(&mut s, &yb.*)`. Under `--sanitize address --allocator system`
both report `heap-use-after-free` at the read of `slot`. The free-function form
(`tests/origins/unsound/h4r-store-widen-named-holder.yo`) is E0923.

## Root cause

`lend_through` (`src/evaluator/calls/function.yo`) begins with
`if(ast_expr_is_fn_call_of(&op_callee, BF_DOT, …)) { return(()); }`. Its argument
list is the call node's own arguments, which for a method call omit the
receiver, and its slots come from the callee atom's function value. Neither
fits a `.`-access callee, so the function opts out of every method call: no
step 1 fix from the receiver's type, no step 2 check of the other arguments, no
step 3 flow write-back into a flow-inferred receiver.

## Fix

`lend_through` binds a recorded method call's receiver (the `.`-access's left
operand) as its first argument and reads the method's own slots
(`_lend_through_args`, `_lend_through_slots`, the shape `_call_lends` uses for
decision 28); a qualified `S.m(&mut s, v)` binds its written arguments. G-E's
call-argument audit reads calls the same way.
The corpus row's `today` column is E0923, and the program is
`tests/origins/unsound/method-store-widen-named-holder.yo` beside a positive
twin.
