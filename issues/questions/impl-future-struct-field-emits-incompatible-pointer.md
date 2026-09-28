# An `Impl(Future(T, E))` struct field passes `yo check` and fails the C compile

**Kind:** design question — an open decision, not a defect. Moved from `issues/` root in the 2026-09-28 severity triage.

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit
(`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Seed v0.2.45 and
develop `af62bdb28` (tree-built compiler).

## Symptom

`yo check` reports `evaluator OK`, then `yo compile` fails in clang:

```
implfield.c:7219:110: error: incompatible pointer types passing
'_file____tmp__temp_139193325099029540521_sync_fut_t *' to parameter of type
'__yo_t_8381625107937523703 *' [-Werror,-Wincompatible-pointer-types]
yo: error: compile: C compiler failed (exit 1) on implfield.c
```

The same failure occurs when the stored future is a full state machine
(`..._state_t *`) rather than a no-await `sync_fut_t`.

## Reproducer

`issues/repros/impl-future-struct-field-emits-incompatible-pointer.yo`:

```rust
Holder :: ref(struct(fut : Impl(Future(i32, Io))));
_mk :: (fn(v : i32, io : Io) -> Impl(Future(i32, Io)))(io.async((io2 : Io) => v));
main :: (fn(io : Io) -> unit)({
  h := Holder(fut : _mk(i32(41), io));
  println(io.await(h.fut, io));
});
```

## Analysis

The field is lowered to a type-erased future type (`__yo_t_…*`), but the
struct constructor receives the concrete state-machine pointer and passes it
through without a cast.

The checker is also inconsistent with itself. `ArrayList(Impl(Future(i32, Io))).new()`
is rejected at check time (E0610, "No method `new` on Type"), while a struct
field of the same type is accepted.

## Decision needed

Pick one of these, and make `check` and codegen agree:

1. **Reject** an `Impl(Future(...))` field at check time with a diagnostic
   naming the alternatives: a concrete future type (`IoFuture`), a
   `JoinHandle(T)`, or a type parameter.
2. **Support** it as a type-erased future. Every access already goes through
   the common future header (`state`, `__yo_resume_fn`, `__yo_set_effect_fn`,
   `continuation_*`; see `uses_generic_future_interface`), so this needs an
   upcast at the field-initialisation site. It also needs the generic-interface
   await path when the field is awaited.

`Impl(Fn(...), Send)` fields are an established std pattern, which argues for
(2).

---

## Recommendation (agent triage, 2026-09-28 — awaiting maintainer verdict)

Option 2 — support it. `Impl(Fn(...), Send)` fields are already an
established std pattern, so an `Impl(Future(T, E))` field is the same shape one
layer down; every access already goes through the common future header, so the
support fix is an upcast at the field-initialisation site plus the
generic-interface await path — not new runtime machinery. Rejecting (option 1)
would remove the only way to store an in-flight operation inside a struct
(`JoinHandle` covers spawned tasks only; `IoFuture` is concrete-typed), and
supporting also resolves the checker's self-inconsistency in the right
direction: `ArrayList(Impl(Future(...)))` should start working too. Sequence:
make `check` and codegen agree first by whichever lands sooner — if the
support fix drags, an interim check-time rejection with a diagnostic naming
the alternatives is acceptable, but today's silent C-compile failure is not.
Slot the support work into `plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`.
