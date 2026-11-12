# A trait-qualified call passes check and emits the trait's type name as a C value

**Severity:** S2. A call qualified by the TRAIT name — `Bump.bump(&mut s)`, `Get.get(&s)`, `Store.put(&mut s, &b)` —
passes `yo check`, and `yo compile` fails in the C compiler with "use of undeclared identifier `__yo_t_N`": the
callee is emitted as a field of the trait's type, used as a value. The spelled forms `S.bump(&mut s)`,
`(S <: Bump).bump(&mut s)` and `s.bump()` compile. Pre-existing: v0.2.76 fails the same way.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 B2) while probing impls against their traits' origins;
the defect has nothing to do with origins. Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-trait-qualified-call-passes-check-and-emits-the-traits-type-name-as-a-c-value.yo`
(expects accept, `OUT: 8`):

```yo
{ println } :: import("std/fmt");
Bump :: trait(bump : (fn(self : &mut Self) -> unit));
S :: struct(n : usize);
impl(
  S,
  Bump(
    bump : (fn(self : &mut Self) -> unit)({
      self.n = (self.n + usize(1));
    })
  )
);
main :: (fn() -> unit)({
  mut(s) := S(n : usize(7));
  Bump.bump(&mut s);
  println(`OUT: ${s.n.to_string()}`);
  ()
});
export(main);
```

```text
$ yo check repro.yo        # accepted
$ yo compile repro.yo -o t
repro.c:2369:23: error: use of undeclared identifier '__yo_t_14460964913727536345'
  (((void (*)(void**))__yo_t_14460964913727536345.__yo_v_bump)((void**)((&(__yo_v_s)))));
yo: error: compile: C compiler failed (exit 1)
```

- `…-shared.yo` (expects accept, `OUT: 7`): `Get.get(&s)` with `get(self : &Self) -> usize`; the same undeclared
  identifier, plus a second error at the use of the result.
- `…-pos.yo` (positive control): `(S <: Bump).bump(&mut s)`; compiles and prints `OUT: 8`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `Trait.m(&mut s)`, `Trait.m(&s)`, `Trait.m(&mut s, &b)` on a plain struct's impl | check OK, C compile fails | accept, or a check-time error |
| `Store.put(&mut s, &b)` over `impl(generic(p : Origin), Slot(p), Store(…))` (ledger: t16c) | check OK, C compile fails | E0923 (the impl's `v` is narrower than the trait's) |
| `S.m(&mut s)` (type-qualified), `(S <: Trait).m(&mut s)`, `s.m()` | compiles, runs | accept |

## Root cause

The trait-qualified dispatch that exists is `(T <: Trait).m(recv)`. `get_type_trait_methods_by_name_from_env`
(`src/env.yo`) handles it: the callee type is a `TraitT` whose `is_concrete` field carries the receiver type, and the
lookup resolves the RECEIVER's registered methods filtered to the trait's id, so the concrete impl's `FuncVal` rides
the method-callee side table. Its comment names the failure this bug shows: "Looking up by the TRAIT's id returns
the trait DECLARATION (no impl body value) — codegen then falls back to expression-emitting the callee
(`__yo_t16.get_number`, a type name in C …)". A bare `Bump.bump` is a `TraitT` with no receiver in `is_concrete`,
so it takes that fallback: the evaluator types the call from the declaration's signature and accepts it, and codegen
emits the trait type's C name as a value.

## Expected

The checker never accepts a call codegen cannot lower. Two consistent outcomes; the first matches Rust's
`Trait::m(&x)` and the existing `(T <: Trait)` machinery:

- resolve the receiver from the `self` argument's type (the first argument, read through its `&`/`&mut` marker) and
  dispatch exactly as `(S <: Bump).bump(&mut s)`; a `self` argument whose type has no impl of the trait is the usual
  "does not implement" error;
- or reject `Trait.m(...)` at check time with a help naming `(S <: Bump).bump(...)`.

## Test

With the fix: the two programs and the positive control as cases in `tests/impl.test.yo` (beside the
`(T <: Trait).method` cases), each compiled and run, or, for the second outcome, an `expect_error` case with the
diagnostic's code.
