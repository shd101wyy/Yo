# E0623 at a template part names the lowering's `append_to` and repairs it as `err.*.append_to(...)`; the type prints as `Dyn(ToString, , Clone)`

**Severity:** S3: a misleading diagnostic. The user wrote `${err}`, the message talks about a member they never wrote and proposes a call they should not write; the right repair is `${err.*}`. The type in the same message has an empty slot.

Branch: `v0280/deref-explicit` (lane deref-f2, the F2 deletion of handle forwarding, VERDICTS-73). Not on develop yet: on develop `${err}` is still accepted through forwarding. Found by the VERDICTS-78 consultation (Q2) on the F2 binary of `Yo-wt/v0280-deref-explicit` (head `8abe1f5aa`); re-run for this document with the same binary and that worktree's std. The deref lane owns the message; this document records it.

## Reproducer

```yo ignore
{ String } :: import("std/string");
{ println, ToString } :: import("std/fmt");
{ Error, AnyError } :: import("std/error");
Bad :: struct(n : i32);
impl(Bad, ToString(to_string : (self -> `bad ${self.n}`)));
impl(Bad, Error());
impl(Bad, Clone(clone : (self -> Bad(n : self.n))));
main :: (fn() -> unit)({
  (err : AnyError) = dyn(Box.new(Bad(n : i32(7))));
  println(`e=${err}`);
});
export(main);
```

(`ignore`: it is rejected on the branch it describes.)

On the F2 branch:

```text
error[E0623]: `err` has type `Box(Dyn(ToString, , Clone))`, which has no member "append_to"; its payload `Dyn(ToString, (source : fn(self : &Self : (ToString)) -> Option(Box(Dyn(ToString, , Clone)))), Clone)` has one. `.` does not read through a handle.
   --> s3a.yo:10:11
   |
10 |   println(`e=${err}`);
   |           ^^^^^^^^^
help: write `err.*.append_to(...)`: `err.*` names the payload (`yo fix` applies this)
help: run `yo explain E0623` for more information
```

What it should say, in the shape the `for`-head form of the same error already has: `` `${err}` renders `err`, of type `Box(Dyn(Error, Clone))`, which does not implement `ToString`; its payload does. `.` does not read through a handle, and neither does a template part. `` with the help `` write `${err.*}` ``.

## Root cause

1. **Wording.** A template part `${e}` lowers to a call of `ToString`'s provided `append_to` on `e`. On the F2 branch `member_behind_deref_error` (`src/evaluator/exprs/property-access.yo`) builds E0623 from the member name of the call it sees, which is the lowering's `append_to`, and its repair inserts `*.` before that name. It has a special form for a `for` head (`for_head`: "`for(...)` walks …, and neither does a `for` head", help `for(&r.*, …)`) but none for a template part, so the template's call is reported as if the user had written `err.append_to(...)`. The `yo fix` edit it advertises targets a name token inside the template, which the source does not contain.
2. **`Dyn(ToString, , Clone)`.** Not F2's: develop prints the same type the same way (`(x : i32) = err;` with `err : AnyError` gives E0601 "Given : Box(Dyn(ToString, , Clone))"). `AnyError` is `Box(Dyn(Error, Clone))` and `Error :: trait(source ?= …, where(Self <: ToString))`. The `Dyn` holds `Error` as its supertrait `ToString` plus a trait value for `Error`'s own member that carries no name: the payload form above prints it by its fields (`(source : …)`), and the `Box(...)` form prints an empty string, which is what the `TraitT` arm of `_tts` (`src/types/string.yo`) returns for a trait with no name and no field labels. Why the `Box(...)` rendering sees no fields was not traced (a display name registered for the `Box` instance before `Error`'s body was evaluated is one candidate). Either way the message should print the trait the user wrote, `Dyn(Error, Clone)` (or the alias `AnyError`).

## Fix

- Owner: the deref lane (F2). Give `member_behind_deref_error` a template-part form, as it has a `for`-head form: the message names `${err}`, the help is `${err.*}`, and no `yo fix` edit is offered unless it targets the part's expression.
- The printer: keep a supertrait-expanded trait's name through `Dyn` so the type prints as written. Can land separately (develop has it).

## Test

The F2 PR adds a row to `tests/deref-explicit.test.yo` (or the template tests) that expects E0623 at `${err}` with the help `` `${err.*}` `` and a message without `append_to`; and a type-printing row expecting `Dyn(Error, Clone)` (or `AnyError`) in an E0601 at `(x : i32) = err`.
