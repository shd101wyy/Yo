# A ctl handler falling through with a unit tail emitted a value-returning C function with no return

**Found**: 2026-08-27 triaging CI (internal-test shards 2/3:
`tests/internal/{check_watch,module_invalidation}.test.yo` — batch C compile
failed `-Werror,-Wreturn-type`; `parser.test.yo` was batch collateral).
**Fixed**: same day, `src/codegen/functions/generation.yo`
(`_emit_erm_unit_resume_tail`), branch `s3/async-combinators`. Repro kept in
this doc; the two internal tests pin it in CI.

## Symptom

```rust
exn := Exception(
  throw : (
    (err) -> {
      assert(false, `test io failed: ${err}`);
    }                      // no return(...) / unwind(...) — falls through
  )
);
```

Emitted C:

```c
static inline void* fn_yo_id_N(__yo_tX err) {
  ...assert call...
  if (__yo_effect_escaped) { ...drops...; return (void*){0}; }
  ...drops...
}                            // ← no return on the fall-through path
```

`error: non-void function does not return a value in all control paths
[-Werror,-Wreturn-type]`.

## Why now

The handler shape is old (#219/#232-era tests) and the emission was always
missing the return — but until PR #275 added `-Werror=return-type`
(deliberately, to stop `// Failed to transpile` stubs shipping as UB), clang
compiled it as a warning-suppressed UB fall-through. The flag is correct and
stays; the emission was the bug.

## Mechanism

An effect-record-member (ctl handler) function's C signature renders the
UNRESOLVED `ResumeType` SomeT — a pointer (`void*`) — because the erm
declaration path passes `body = None` (handlers are type-erased fn pointers
in the effect record). The body generator, meanwhile, resolves the result to
unit (`result_is_unit`) and emits the tail as a plain STATEMENT with no
`return` — correct for a `void` signature, wrong for this one. The
effect-escaped early-exit branch already returned `(void*){0}`; only the
normal fall-through path lacked its return.

## Fix + semantics

Completing a ctl handler body without `return(...)`/`unwind(...)` is an
implicit RESUME WITH UNIT (consistent with Yo functions' implicit tail
values). `generate_function_body` now ends every effect-record-member
function whose unit-tail path can fall through with
`return (<sig-type>){0};  // implicit unit resume` — emitted only when the
signature-side rendering is a pointer, so a genuinely `void` signature never
gains an illegal return; paths that already returned make it unreachable,
which is legal C.
