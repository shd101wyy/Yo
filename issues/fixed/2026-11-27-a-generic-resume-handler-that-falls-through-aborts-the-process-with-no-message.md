# A generic-resume handler that falls through aborts the process with no message

**Severity:** S2. `yo check` accepts the program, and the docs call it legal. At run time the process aborts (exit 134) with no diagnostic when the handler falls off its end.

- Filed 2026-11-27 from VERDICTS-89 §9 finding 1 (Fable 5.2, probes p3, p4, p6, p10 in `~/Workspace/Yo-wt/v0273/probe-ctl/`). Reproduced with a stage 1 of `wip/v0281-dupdrop-r9` merged with develop `bc706b0a3` (v0.2.80).
- Closed by VERDICTS-89 PR B: the fall-through half of R2 makes this handler a compile error. That PR also carries the sweep of 88 `assert(false, msg);` handler tails to `panic(msg)` and the docs correction.

## Reproducer

```yo
{ println } :: import("std/fmt");
Exn :: struct(
  throw : (ctl(generic(ResumeType : Type), code : i32) -> ResumeType)
);
op :: (fn(exn : Exn) -> unit)({
  exn.throw(i32(1));
  println(`after the throw`);
});
main :: (fn() -> unit)({
  exn := Exn(
    throw : (
      err -> {
        println(`swallowed`);
      }
    )
  );
  op(exn);
  println(`done`);
});
export(main);
```

```text
$ yo compile tmp/fixme.yo --allocator system -o p6 && ./p6; echo rc=$?
swallowed
Aborted
rc=134
```

The same happens with the handler `err -> ()` at `Rc` or `Box` throw sites (p3, p4). A handler `cond(c => unwind(v), true => ())` unwinds correctly on its first arm and aborts on the second (p10).

## Root cause

The handler is emitted as `void* fn(int32_t err)`. Its body ends with a statement block whose tail renders no code, so `src/codegen/functions/generation.yo` closes the function with the trap `__yo_abort();  // unreachable: every path through the tail diverges` (from `issues/fixed/2026-10-18-a-match-in-statement-position-falls-off-the-end-of-a-non-void-function.md`). That trap comes before `_emit_erm_unit_resume_tail`'s `return (void*){0};  // implicit unit resume` line, so the fall-through reaches the abort.

Before the trap existed, the fall-through resumed with a zeroed `ResumeType`: a null `Rc` or `Box` in safe code. Restoring that ordering is therefore not the fix.

The fix is VERDICTS-89 R2's second half. A handler of a `ctl(generic(R : Type), ...) -> R` does not resume, so every path must end in `unwind(value)` or in an expression of type `never`. Falling off the end is an error at the handler. `docs/en-US/ERROR_HANDLING.md` ("must `unwind`, diverge, or fall through with `()`") and `tests/algebraic-effects.test.yo`'s `_falls` line are corrected with it. The test that fails before and passes after is a `comptime_expect_error` row for `err -> { println(...); }` in `tests/algebraic-effects.test.yo`.
