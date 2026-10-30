# `Self` in a static method's signature resolves to the caller's impl receiver under static-argument inference

**Severity:** S2 — a valid `G.m(x)` call inside another type's `impl` is rejected with E0604 when `m` declares `-> Self`; writing the type arguments (`G(X).m(x)`) works around it.

Found by the static-argument-inference B2 sweep (2026-10-30): after
`yo fix --migrate handle-ctors` rewrote `box(_ChildState(...))` in
`std/process/command.yo`'s `impl(Command, ...)` to `Box.new(_ChildState(...))`,
every module importing `std/process` failed with

```text
error[E0604]: Function body has type `Box(_ChildState)`, but the declared result type is `Command`.
      --> std/prelude.yo:10233:71
10233 |   new : (fn(value : T, (alloc : Option(Allocator)) ?= .None) -> Self)({
```

## Reproducer

```yo
G :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), G(T), mk : (fn(value : T) -> Self)(Self(v : value)));
P :: struct(x : i32);
W :: struct(c : G(P));
impl(W, make : (fn() -> Self)(W(c : G.mk(P(x : i32(1))))));
main :: (fn() -> unit)({
  w := W.make();
});
export(main);
```

`yo check` (tree at b7e873958, and the v0.2.72 seed) reports
"Function body has type `G(P)`, but the declared result type is `W`". The
same call written `G(P).mk(...)` checks, and so does `G.mk(...)` in a plain
function.

## Root cause

An identifier `Self` reads `ctx.self_type` before the environment
(`evaluate_identifier`, `src/evaluator/exprs/identifer_and_operator.yo`).
`create_specialized_function_inline` (`src/evaluator/calls/helper.yo`)
re-evaluates a written return type (and the param types, the `pte` block)
with `ctx.self_type` pointed at the receiver only for a method whose first
parameter is `self`; its comment says static dot-calls "already had
`ctx.self_type` set by the dispatcher". The `FuncVal` arm of
`evaluate_function_call` does set it (`_static_dot_receiver_self_type`), but a
call through an unapplied constructor (`G.m(...)`, inferred by
`_infer_unapplied_ctor_receiver`) is dispatched by the method-lookup arm, which
hands the receiver to `try_to_call_function_with_arguments` only through
`ctx.pending_method_self_type` (the callee-env `Self` binding) and leaves
`ctx.self_type` at the enclosing impl's receiver. The body itself is fine:
its specialization clears `ctx.self_type` when the FuncVal captures `Self`
(the `b1-self-capture` arm), so only the re-evaluated signature sees the
caller's `Self`.

## Status

`Box(T).new` now writes its result `Box(T)` instead of `Self`, as `Rc.new` and
`Arc.new` already did (`std/prelude.yo`), so the handle constructors are not
affected and a v0.2.72/v0.2.73 seed builds the swept tree; the test is
`tests/handle_constructors.test.yo` ("Box.new inside another type's impl
builds a Box, not that impl's Self"). A user type whose static method declares
`-> Self` is still affected. The fix is to apply the body's `b1` rule to the
signature re-evaluation too: in the `rte`/`pte` blocks, when the first
parameter is not `self` and the FuncVal captures `Self`, clear `ctx.self_type`
so the identifier resolves through the capture. It changes how every static
impl method's written signature is re-evaluated, so it needs its own
emit-diff and is left to its own PR.
