# Should a non-resuming operation be spelled `ctl(ps) -> never` instead of `ctl(generic(R : Type), ps) -> R`?

**Kind:** design question. It is an open decision, not a defect. Filed 2026-11-27 from VERDICTS-89 §10 (Fable 5.2).

## The question

After VERDICTS-89 R1, the only generic `ctl` left is the operation that does not resume, as in `Exception.throw : ctl(generic(ResumeType : Type), error : AnyError) -> ResumeType`. It encodes "does not return" as a polymorphic result. Every special case in this area exists to manage that encoding:

- in codegen, `ctl_generic_ret` and the `void*` signature;
- in the evaluator, `ctl_force`, the inherited `forall_labels` and the `nrs_ret_bare` exclusion;
- since VERDICTS-89, E0627's R2 check on handler bodies.

The language already has the direct spelling, `-> never`. Against `throw : (ctl(code : i32) -> never)`, the handler check falls out of the ordinary rules with existing codes:

- `code -> ()` and `code -> { println(...); }` are E0604;
- `code -> return(i32(7))` is E0605.

(VERDICTS-89 probes p18–p20.)

Should the language switch to `ctl(ps) -> never` and retire the polymorphic-result encoding?

## What blocks it today

- `issues/2026-11-27-a-ctl-returning-never-in-statement-position-emits-a-void-temp.md` (S2): a `-> never` `ctl` call in statement position emits invalid C.
- `issues/2026-11-27-a-call-through-a-function-value-typed-never-does-not-coerce-to-the-expected-type.md` (S3): a `-> never` call through a field or a parameter where a value is expected is E0601.

## Options

1. Keep `ctl(generic(R : Type), ps) -> R`, with R1 and R2 as the rules that keep it sound.
2. Move to `ctl(ps) -> never`. After R1, every surviving generic `ctl` has the shape `ctl(generic(R : Type), ps) -> R`, so the migration is one exact edit per declaration. That makes it a real `yo fix` repair. `generic` on a `ctl` then becomes E0009, and std flips one seed later.

## Recommendation

Option 2 (Fable, VERDICTS-89 §6; confidence 65%). Fix the two blocking bugs in v0.2.82, add the `yo fix` repair, and flip std's `Exception` and every generic `ctl` one seed later. It is not needed to close the S1 (`issues/fixed/2026-11-25-a-generic-ctl-handler-cannot-resume-with-a-value-at-any-type.md`). The unreachable-code consequences at statement-position throw sites (code after a `-> never` call) have not been costed. Cost them before adopting.
