# A function VALUE that reaches a non-Send global crosses to another thread unchecked: rule D1 walks only closure literals

**Found:** 2026-09-25, closing `plans/PARALLELISM_SOUNDNESS.md` (Phase 8 review of the D1/D4 surface).
**Status:** OPEN. **Class:** data race from safe code, no diagnostic. Two of the repros compile and
run clean under `yo compile --optimize 2`, with the race live.
**Measured:** tree-built compiler at `ps/phase2-iso` `d8280ec37` (D1, D4 and the D1 residual landed),
macOS arm64.

## Repros (`issues/repros/d1-function-value-*.yo`, every one green at `yo check`)

Each program has a module-level `g := ArrayList(i32).new()` (a non-`Send` global). A function
whose body is `g.push(...)` runs on a spawned thread while `main` also pushes to `g`:

| repro | how the function reaches the thread |
| --- | --- |
| `named` | `Thread(unit).spawn(_worker)`: a NAMED function as the spawn body |
| `struct` | `Holder(f : _fill)` captured by the spawn closure, called as `h.f` |
| `fnvalue` | `_call_ptr(_fill)` inside the spawn body: a named function passed as a value |
| `argflow` | a local closure `k` captured by the spawn closure and passed to `_call_it(k)` |
| `arc` | `arc(k)` of a local closure `k`, read back and called on the thread |
| `param` | `_run(k)`, where `_run(cb : Impl(Fn() -> unit, Send))` spawns `cb` |
| `generic` | `_needs_send(k)` against `where(T <: Send)` |
| `channel` | `Channel(typeof(k))`, `ch.send(k)`, received and called on the thread |

`named` and `struct` compile and run. `arc` fails in clang, but only through the unrelated
`issues/arc-of-a-capture-free-closure-emits-two-arc-typedefs.md`.

## Mechanism

Rule D1 (`plans/reference/PARALLELISM_RULES.md`) forbids a closure bound to a `Send` closure
type from reaching a non-`Send` (or written value) global. It is enforced in exactly one place:
`validate_send_closure_global_reach`, when a closure LITERAL is created against a `Send`-bound
expected type. It walks that literal's body and its statically resolved callees
(`function_reaches_non_send_global`).

Every other way a function's code can reach another thread goes around it:

- **A named function is never a literal.** Passed to `Thread.spawn`, it is judged only by
  `impl_param_unmet_trait`, and the `.Func` arm of `type_implements_trait`
  (`src/evaluator/trait_checking.yo`) answers `Send` for every `fn(...)` type: "a code pointer
  carries no state". True of its captures, not of what its code touches.
- **A closure bound to a non-`Send` slot first** (`(k : Impl(Fn() -> unit)) = ...`) is walked
  with `wants_send = false`. When it later reaches a `Send` position by value (`arc(k)`,
  `where(T <: Send)`, an `Impl(..., Send)` parameter, `Channel(typeof(k))`), rule D4 judges its
  capture struct and nothing else, and `k` captures nothing.
- **Inside a walked body, a function used as DATA is not followed.** `_call_ptr(_fill)` and
  `_call_it(k)` descend into the callee, whose `cb()` has no compile-time callee, and never
  visit `_fill` / `k` as code that will run.
- **Data structures erase identity.** `Holder(f : _fill)` is `Send` because its field type
  `fn() -> unit` is. No check anywhere can know which function the field holds.

A function type cannot be `Send` merely because its values carry no captured state: whether
its CODE touches a thread-affine global is part of the value, and a structural `fn(...)` type
does not record it.

## Fix direction

The decision is recorded as a D1 amendment in `plans/reference/PARALLELISM_RULES.md` ("function
values"). A function value is `Send` iff its captured state is `Send` (D4) AND its body reaches
no thread-affine global (D1). That is judged where the VALUE is known, at every conversion into
a `Send` position:

1. a named function or closure value passed to an `Impl(..., Send)` parameter;
2. bound to a `where(T <: Send)` binder;
3. captured by a `Send` closure.

A bare `fn(...)` type whose value is unknown (a struct field, a collection element, a
`Channel(fn() -> unit)` payload) is not `Send`, which is Swift's rule: a plain function type is
not `Sendable`. Within a walked body, a function value used as data is walked as if called.
