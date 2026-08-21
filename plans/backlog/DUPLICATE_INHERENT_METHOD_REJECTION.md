# Reject duplicate inherent method impls (make the documented model real)

**Status:** BACKLOG (agreed with maintainer 2026-08-21). Scheduled as the
follow-up branch after the function-overloading-policy branch
(`plans/FUNCTION_OVERLOADING_POLICY.md`) lands.

## Problem

`issues/duplicate-inherent-method-impls-not-rejected.md` (reproducers
there): registering the same inherent method name on one type via two
separate `impl(...)` calls is silently accepted —

- identical signature: the second impl is ignored, the FIRST wins;
- different arity: both register and dispatch by arity — de-facto
  inherent-method overloading.

Both contradict the documented model ("inherent NO, trait YES" —
yo-design.instructions.md, core-patterns cheatsheet), whose quoted
"Method already defined" error never existed in the evaluator. With the
`Call` overload-set gate landed, this is the last open overloading channel.

## The fix (design)

A rejection at inherent-method registration time, keyed to distinguish a
GENUINE second definition from an idempotent re-registration:

1. **Where:** the registration path feeding the per-type method registry
   (`src/evaluator/values/type_trait_methods.yo` — "duplicates by
   `(label, source_trait_id)` are not deduplicated by the registry —
   callers responsible" — and its `impl.yo` callers). The check fires for
   the INHERENT channel only (no source trait); trait-provided methods
   sharing a name (incl. parameterized impls `Eq(String)`/`Eq(str)`) stay
   allowed by design.
2. **Idempotency key:** the defining expression's identity (`ExprId` /
   defining token), NOT the signature. The module loader re-evaluates
   files and generic impls re-register per instantiation —
   `src/evaluator/module_loader.yo` documents duplicate pushes as expected
   ("a duplicate push would still be harmless"). Same defining expr ⇒
   re-registration, allow; different defining expr with same
   `(type, label)` inherent pair ⇒ `Method "X" is already defined for
   type "T"` error pointing at both sites.
3. **Generic instantiations:** one generic impl instantiated at many type
   arguments re-registers the SAME defining expr against different
   concrete types — the key includes the concrete type, so this stays
   legal; two DIFFERENT generic impls landing the same method on the same
   concrete instantiation is the error case, caught by the expr-identity
   split.

## Validation requirements (why it needs its own branch)

The check touches the registration path of every impl in every module, so
false positives are the risk, not the mechanics:

- probe the loader's double-evaluation paths (the "module evaluated twice"
  class — check/build/test each exercise different loader entry points);
- `yo check ./src --std-path ./std` and `yo check ./std` must stay green
  (std re-impls surface any idempotency miss immediately);
- new negative tests from the issue's two reproducers (verify they FAIL
  red-first against the current compiler per the repo rule), plus a
  positive test that a generic impl used at two instantiations still
  registers cleanly;
- full pyramid: gates_fast → fixpoint_only → fast suite → tests/internal.

## Non-goals

- No change to trait-channel name sharing or parameterized trait impls.
- No change to the `Call` overload-set gate (already landed).
- No signature-based "compatible overload" carve-outs — the model is
  Rust's: one inherent name, one definition.
