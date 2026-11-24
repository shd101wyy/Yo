# Is an `Impl(Future(T, E))` slot the erased future? Finish it for every slot, or retract it

**Kind:** design question — an open decision, not a defect.

Filed 2026-11-25 by the dyn-future-reject lane, from VERDICTS-80's "Not in this PR" (Fable 5.2, adopted 2026-11-25). VERDICTS-80 rejects `Dyn(Future(...))` (E0614) and points the user at two spellings: `Impl(Future(T, E))` for one future, `JoinHandle(T)` for several running tasks. The first is only half built.

## The question

A future is already one pointer to its state machine, and the state machine's prefix (`__YO_FUTURE_PREFIX`) carries its own table (`resume`, `set_effect`, `cancel_pending`, the bundle slot). Codegen can therefore hold any future of `(T, E)` behind the generic interface pointer (`Future(T, E)`'s C struct) and await it through the prefix. A slot whose written type is `Impl(Future(T, E))` could mean "any future of `(T, E)`, erased", the way a struct field already does. Today only some slots mean that:

| Slot written `Impl(Future(i32, Io))` | Holding two different futures (a sync future and a state machine) |
| --- | --- |
| a struct field (`Job :: struct(fut : Impl(Future(i32, Io)))`), in an `ArrayList(Job)` | works: stored, reassigned, awaited (`_future_field_upcast`, `src/codegen/exprs/other-fn-call.yo`; `tests/async-await.test.yo` "an Impl(Future) struct field is stored, reassigned and awaited"); VERDICTS-80 probe `e1` runs under ASan |
| a local, reassigned | E0902 "Cannot reassign variable "f" of type Impl(...). Impl(...) uses static dispatch and the concrete type is fixed at first assignment." |
| a function result, from two `cond` arms | `check` OK, clang error (`issues/cond-arms-with-different-impl-future-types-mix-c-pointer-types.md`) |
| a list element, `ArrayList(Impl(Future(i32, Io)))` | E0610 `No method "add" on *(Impl(Future(i32, Io)))`, raised inside `std/collections/array-list.yo` |
| a function-typed element, `ArrayList((fn(...) -> Impl(Future(i32, Io))))` | `check` OK, C fails (`issues/2026-10-25-a-list-of-async-function-values-does-not-compile.md`) |

Everywhere else in the language `Impl(Trait)` is static dispatch: one concrete type per slot, fixed at its first assignment. The struct field is the exception, decided 2026-09-29 for futures only.

## Options

- **A. Finish it.** Every slot whose written type is `Impl(Future(T, E))` is the erased future: codegen lowers it to the interface pointer and upcasts each concrete future on the way in, as the field does today. The local's E0902 goes away for futures, the `cond` arms compile, `ArrayList(Impl(Future(T, E)))` works, and the list of async function values follows from the same lowering. Cost: `Impl(Future(...))` no longer means what `Impl(Trait)` means elsewhere, and the rule has to be taught as a future-only exception (it already is one, for fields).
- **B. Retract it.** `Impl(Future(T, E))` is static dispatch at every slot, the field included; the erased form is `JoinHandle(T)` only (spawn first). The field's upcast and its test go; `e1`-shaped programs (a list of cold futures awaited later) must spawn each future, which starts it early.
- **C. Leave it as is.** Fields erase, nothing else does. The four failures above stay open as separate bugs, each fixed or rejected on its own.

## Recommendation

**A, after VBD** (VERDICTS-80's lean, confidence 0.6). The lowering exists and is tested for fields; extending it to every `Impl(Future(T, E))` slot closes the `cond`-arms S2 and the async-function-list S2 with one rule, and gives a list of different cold futures a spelling that does not start them. Until then, the E0902 text for an `Impl(Future)` local names `JoinHandle` (VERDICTS-80's PR), and the E0610 that a list element raises inside std belongs to this decision rather than to a separate fix. This deserves its own consultation before implementation.
