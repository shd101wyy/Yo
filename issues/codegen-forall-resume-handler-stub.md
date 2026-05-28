# Codegen: forall ctl-handler stub treats resume as unwind

**Status:** Open

## Symptom

For effect-record handlers whose ctl signature carries
`forall(ResumeType : Type)` (e.g. `MyException(i32)` from
`tests/algebraic_effects.test.yo`), the _standalone_ function body
emitted by `src/codegen/functions/generation.ts` is a stub that always
sets `__yo_effect_escaped = 1` and returns the zero-value of the
declared return type — regardless of whether the source-level body is
`return(resume_val)` (resume) or `unwind(...)` (unwind).

A handler like

```rust
exn := MyException(i32)(
  throw : ((val, resume_val) -> { return(resume_val); })
);
```

compiles to roughly

```c
static inline void* fn_..._115(int32_t val, void* resume_val) {
  __yo_effect_escaped = 1;
  return (void*){0};
}
```

The intended resume semantics is that `return(resume_val)` returns
`resume_val` _without_ setting the escape flag — the caller of
`exn.throw` then continues with the resumed value.

## Why this only surfaces now

Before
`issues/codegen-exn-throw-ref-self-while-hang.md` was fixed, every
caller of an effect-record-bearing function simply propagated
`__yo_effect_escaped` upward without clearing it. The install fn's
outer caller (typically `__yo_user_main` or a test body) early-returned
silently, so the buggy "always sets the flag" handler stub was
_indistinguishable_ from a real unwind — and assertions placed after
the install fn returned were never reached, so resume tests passed by
accident.

With the install-point fix in place, the install fn now correctly
clears the flag and extracts `__yo_unwind_value`, so the test body
_does_ run its assertion — and it fails because the resume value never
came back via the normal return path.

## Failing test

`tests/algebraic_effects.test.yo` →
_"Struct-record effect with forall handler — early return after
resume in while loop"_ now aborts with a real assertion failure
(`result == i32(1)` is `false` because `result == 0`, the propagated
zero from the stub).

## Sketch of a fix

The stub generator at `src/codegen/functions/generation.ts:349`
(`if (value.isEffectRecordMember) { ... }`) needs to distinguish:

- Bodies that unwind (use `unwind(...)`) → keep the existing stub
  (`__yo_effect_escaped = 1; return (T){0};`).
- Bodies that only resume (use `return(<atom>)` matching a parameter
  name) → emit `return <that_param>;` with no flag write.

The body's control-flow flags (`body.$?.controlFlow.unwind` /
`body.$?.controlFlow.return`) already differentiate these — provided
they get populated for the deferred body. If not, walk the body for an
`unwind(...)` call.

## Workaround

None applied. The failing test passes when the install-point fix is
reverted, but that re-introduces the parser bug fixed by
`issues/codegen-exn-throw-ref-self-while-hang.md`. Leaving the test
failing is the smaller cost while the stub generator is corrected.
