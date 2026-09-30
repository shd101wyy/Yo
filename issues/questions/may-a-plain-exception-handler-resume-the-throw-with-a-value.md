# May a plain `Exception` handler resume the throw with a value?

**Kind:** design question. It is open because the silent-wrong-value bug in
`issues/a-plain-exception-handler-that-returns-a-value-resumes-with-zero.md` (S1) cannot be fixed
until the rule is decided.

## Situation (re-verified 2026-10-01 on develop `29bf728b4` and the v0.2.46 seed)

`Exception.throw` is `ctl(generic(ResumeType : Type), error : AnyError) -> ResumeType`
(`std/error.yo`). A handler written against it, `err -> { return(i32(7)); }` or `err -> i32(7)`,
passes `yo check`, and the throw site reads 0:

- The handler is emitted returning `(void*)0` after computing the 7. This is the DEGRADED
  unresolved-SomeT return guard in `src/codegen/exprs/return.yo`.
- The throw site keeps its zero-initialized result on purpose: "a generic-ResumeType handler
  cannot resume with a value, so the zero-init IS the result" (`src/codegen/exprs/other_fn_call.yo`,
  `ctl_generic_ret`).

`ResumableException(i32)`, whose resume type is fixed when the handler is built, resumes with 7.

The evaluator already rejects the same parametricity violation for a deferred generic closure
(`(value -> i32(0))` against `fn(generic(T), value : T) -> T`, `anonymous_function.yo`'s
deferred trial). A handler declares no generic of its own, though, so its body is evaluated
eagerly. It inherits `ResumeType` from the expected `ctl` type, and an unresolved SomeT unifies with
`i32`, so the check never runs.

## Options

1. **Reject.** A body of a handler bound to a generic-`ResumeType` `ctl` may only diverge
   (`unwind(...)`, a panic, an infinite loop) or return a value typed `ResumeType` itself. A
   concrete `return(v)` or tail value is a compile error that names `ResumableException(T)`.
2. **Carry the value.** Lower a generic-`ResumeType` resume through a type-erased box that the
   throw site unboxes at its own `ResumeType`. The handler cannot know which type the throw site
   wants, so a mismatch has to be checked at run time. That is a runtime type check, which the
   language does not otherwise do.

## Recommendation

**Option 1.** The declared type already says so. `generic(ResumeType)` means the handler works
for every `ResumeType` the throw site picks, and only a diverging body satisfies that without a
value of the caller's type. That is exactly parametricity, which the deferred-trial check already
enforces for closures. Option 2 would add a runtime type check and a box per resume to paper over
a program that has no well-typed meaning. The fix is to run the deferred trial's comparison in the
eager path for `ctl` handlers: the declared result is a bare SomeT from the handler's inherited
`forall_labels`, the body type is concrete (not unit, not never, not abstract), so raise
`Incompatible function return type` with a help line pointing at `ResumableException(T)`.
Before landing, audit `std/`, `src/` and `tests/` for handlers that rely on the silent 0.
