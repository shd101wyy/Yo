# `(args) -> body` regular fn body cannot reference outer locals (by design)

## Status: BY DESIGN (closed)

## Original (incorrect) framing

The original issue was filed as "closures cannot capture mutable locals or
globals" with a repro using:

```rust
given(exn) := Exception(throw: ((err) -> {
  did_throw = true;   // ❌ "use of undeclared identifier 'did_throw'" in C output
  escape ();
}));
```

## Correct analysis

The `(args) -> body` syntax is a **regular function** definition, NOT a closure.
Regular functions cannot reference outer locals — only globals, parameters, and
their own locals are in scope. Yo's closure form is `(args) => body` (fat arrow).
This is the same distinction enforced for top-level function definitions:
`fn(x:i32) -> i32` is a regular function and never closes over an enclosing
scope.

The `Exception` module's `throw` field is typed as a regular function:

```rust
Exception :: module(
  throw : (fn(forall(ResumeType : Type), error : AnyError) -> ResumeType)
);
```

so the `given(exn) := Exception(throw: ...)` site actually **rejects** a fat-arrow
closure with a clear evaluator error:

```
Error: Expected -> for anonymous function, got:
err => begin(did_throw = true, escape(()))
```

i.e. effect handlers do not support closures at all — only regular functions —
and regular functions correctly cannot close over outer locals.

## Real follow-up bug (separate issue)

When a regular `(args) -> body` function body **does** reference an outer local,
the evaluator currently passes the broken AST through to codegen, which emits
invalid C (`use of undeclared identifier 'foo'`). The right behavior is to
surface a Yo-level diagnostic at evaluator time:

> "Function body cannot reference outer local `foo`. Regular functions
> (`-> body`) do not capture; only closures (`=> body`) do."

This missing diagnostic is tracked as part of the broader "evaluator does not
detect non-captured references" gap. Until it is fixed, the C compiler error
serves as the diagnostic.

## Workaround (production code)

For tests of error-throwing functions, install an `exn` whose `throw` calls
`assert(false, "unexpected error")` — the test fails noisily if the throw
fires. To check "did this throw?", restructure the call site so the throw path
is observed by the **caller** (e.g. via the surrounding `escape` semantics)
rather than via captured mutable state.

## Discovered

Bootstrapping yo-self tests (typeof.test.yo, anonymous_module.yo).
