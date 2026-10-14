# The destructor read as a method value gets past E0915, so it runs twice

**Severity:** S2 — `f := Fd.drop; f(&mut a)` is accepted and the destructor runs a second time at the scope end (a double close or free for a real resource).

**Status:** Fixed (v0.2.63). Found by the v0.2.62 adversarial review; new with E0915 in decision 45 Generation A (#1343).

## Symptom

```yo
{ println } :: import("std/fmt");
(g : i32) = i32(0);
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g = (g + i32(1));
    })
  )
);
main :: (fn() -> unit)({
  {
    a := Fd(n : i32(1));
    f := Fd.drop; // also `(Fd <: Drop).drop`
    f(&mut a);
  };
  println(`drops=${g}`); // printed drops=2
});
export(main);
```

`a.drop()`, `Fd.drop(&a)` and `(Fd <: Drop).drop(&a)` were E0915; the method
value spellings were not.

## Root cause

`_reject_explicit_destructor_call` (`src/evaluator/calls/function.yo`) ran
only from `_evaluate_function_call_unanchored`, on a dot that is the callee of
the call being evaluated (`callee_is_marked_dot`). A `.drop` member evaluated
anywhere else — bound to a local, passed as an argument — was never checked.

## Fix

The dot dispatch in `src/evaluator/exprs/_expr.yo` now calls
`reject_destructor_member_read` on every `.` access that is not a call's
callee (`is_dot_callee`): the same resolution as the call check (a
destructor-trait method found on the receiver before any inherent method, or a
member of the destructor trait's witness; a field of that name is a field
read), reported as E0915 "The destructor "drop" is read as a value", as Rust's
E0040 does for `<T as Drop>::drop`. Both spellings, `drop` and `dispose`, are
covered. The synthesized `___dispose` (`auto-generated://` tokens) stays
exempt.

## Test

`tests/move_only.test.yo`, "Drop: the destructor read as a value is E0915, and
the repair names the value": `_MoDropFd.drop`, `(_MoDropFd <: Drop).drop`,
`_MoFd.dispose` and `(_MoFd <: Dispose).dispose` each read as a value. Before
the fix none of them is an error.
