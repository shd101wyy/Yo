# `derive(S, Clone)` over a field whose type has no `Clone` passes `check` and aborts at runtime

**Status: FIXED 2026-09-20** (found the same day while landing LSP code actions, PR C of
the toolchain series). Repro: `issues/repros/derive_clone_non_clone_field.yo`.

## Symptom

```rust
Inner :: struct(n : usize);
Outer :: struct(inner : Inner, k : usize);
derive(Outer, Clone);
main :: (fn() -> unit)({
  o := Outer(inner : Inner(n : usize(1)), k : usize(2));
  o2 := o.clone();
  println(o2.k.to_string());
});
```

- `yo check` passes (0 files failed).
- `yo compile` succeeds.
- Running the binary: `yo: FATAL: reached fn_yo_id_…, whose body failed to
  transpile - its definition-time evaluation failed and was swallowed`, rc=134.

The real instance: `src/diagnostics.yo`'s `Repair` derived `Clone` while its
`Span` field did not. Nothing had ever cloned a `Repair`, so the hollow method
sat unnoticed until the LSP stored diagnostics per document and cloned the
list (`ArrayList(LspDiag).clone()` → `LspDiag.clone()` → `Repair.clone()`),
which took the whole language server down on the first `didOpen`
(`tests/cli-cases/lsp-code-action` recorded rc=134 before the fix).
Fixed at the use site with `derive(Span, Clone)`; the compiler-side hole
remains.

## Root cause

The derived `clone` body is `Outer(inner : self.inner.clone(), k : self.k.clone())`.
Its definition-time evaluation fails on `self.inner.clone()` ("No matching
call"), and the def-time trial swallows that failure — the same
swallow class as issues/fixed/def-eval-swallow…: the method's ExprInfo says
"body never fully evaluated" and codegen emits the FATAL stub instead of a
body. `YO_DEBUG_SWALLOW=1 yo check` shows the swallowed error; nothing else
does. Measured on the repro (2026-09-20, tree-built compiler):

```
[anon-swallow] error: No matching call found with arguments:
((self.inner).clone)()
  --> auto-generated://
// === START auto-generated code ===
Self(self.inner.clone(), self.k.clone())
// === END auto-generated code ===
```

So the rejection is a plain dispatch failure inside auto-generated code — the
same message every legitimate overload trial swallows, which is why flagging
it as a flow violation at the throw site would be wrong (it would turn
ordinary trial misses into hard errors). The fix has to live at the derive.

## Fix direction

A derive-generated method body has no legitimate reason to be trial-swallowed:
the derive knows the field list, so either (a) `derive(S, Clone)` checks each
field type implements `Clone` up front and reports `E0602` at the `derive`
token naming the field, or (b) the generated body's def-eval failure is
re-raised as a hard error (the flow-violation re-raise the async-closure fix
used). (a) gives the better message. Gate: a cli-case `check` golden over the
repro that expects E0602, red before, green after.

Hazard for (a), from the peer session that landed the lazy-binding work:
**impl registration is lazy** (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`) —
pending entries are forced on a lookup MISS, and impl blocks ride that same
forcing path, so "does this field type implement Clone?" asked with a raw
registry read can answer NO for a type whose `impl(T, Clone(...))` sits below
the `derive` or comes from a where-bound. The check must go through the
lookup that forces pending entries, and it needs two over-rejection canaries
that must keep compiling: a field type whose Clone impl is defined BELOW the
derive, and a generic field whose Clone comes from a where-bound.

## Fix (2026-09-20)

Option (b), made general: `hard_swallow_diagnostic` (`src/evaluator/context.yo`)
gains a fourth class — any swallowed failure whose rendered location is
`--> auto-generated://` (a derive's generated body, `generate_expr_from_code`)
surfaces at check time. Auto-generated code has no call site that could
redeem a trial miss, so the swallow is never speculative there. The
anonymous-body trial re-raises it, derive's guarded evaluation catches it and
reports `derive on "Outer" failed: No matching call found … ((self.inner).clone)()`
anchored on the `derive(...)` line (E0610 through the classifier).

The lazy-impl hazard above is answered by the canary in `tests/derive.test.yo`
("a derived Clone over a field whose Clone impl is registered below the
derive"): the method miss inside the generated body forces the pending
`impl(_LaterInner, Clone(...))` registered BELOW the derive, so it compiles;
the where-bound generic derives (`derive(generic(T), CloneBox(T), where(T <:
Clone), Clone)`) in the same file keep passing. Golden:
`tests/cli-cases/check-derive-clone-non-clone-field`.
