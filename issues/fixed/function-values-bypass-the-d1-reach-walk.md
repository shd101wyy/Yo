# A function VALUE that reaches a non-Send global crosses to another thread unchecked: rule D1 walks only closure literals

**Found:** 2026-09-25, closing `plans/PARALLELISM_SOUNDNESS.md` (Phase 8 review of the D1/D4 surface).
**Status:** FIXED 2026-09-25 (rule D9, `plans/reference/PARALLELISM_RULES.md`). Was: OPEN. **Class:** data race from safe code, no diagnostic. Two of the repros compile and
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

## Fix (2026-09-25, rule D9)

- **The value decides.** `function_value_marker` (`src/evaluator/utils/closure.yo`) judges a
  function-like type for `Send`/`Acyclic`: its captured state (a per-closure verdict taken at
  creation, per captured variable with the captured value as the witness) and, for `Send`,
  its code's reach (the D1 walk's verdict, memoized by function id).
  - **Where the value comes from:** a witness value when the caller has one; the callee's
    parameters bound to the type; or the closures created against a closure's `Impl` SomeT (a
    registry the specialization's fresh binders alias).
  - **Reaching it:** `trait_checking.yo` and `types/function.yo` call it through
    `call_function_value_marker` (`src/evaluator/context.yo`).
- **Every closure is walked where it is created.** `validate_send_closure_global_reach` now
  walks every closure with its defining env, not only the `Send`-bound ones, so a later
  type-level judgement reads a verdict taken where the closure's local callees resolve.
- **Conversion sites judge the value:**
  - an argument to an `Impl(..., Send)` parameter (both call paths);
  - an `Impl(...)` result;
  - every where-clause path;
  - a variable captured by a `Send` closure.
- **Bare `fn(...)` is not `Send`** at the type level (`.Func` arm of `type_implements_trait`).
  A struct field or payload of that type has lost its function's identity.
- **The walk follows functions used as values** (`_gr_value_function`,
  `mutation_summary.yo`).

All eight repros are rejected at `check`, each naming the global its code reaches. Tests:
`tests/parallelism_soundness.test.yo`'s D9 section (six rejection blocks, one canary with four
routes that each run a function on a thread) and the check-level cli-case
`check-function-value-reaching-global-is-not-send`.

## Found along the way

- **The D1 residual block regressed on the Phase 2 tip.** A local closure `k` captured by a
  spawn closure and called there (`_d1_spawn_calls_local_closure`) passed `check` again, because
  the reach walk's `_gr_walk_closure_callee` found no `FuncVal` behind the captured binding in
  the spawn body. D9's capture judgement now rejects the shape at the capture, from the enriched
  capture's value, which is where it belongs.
- **The D1 `dyn` corpus block never compiled.** Its trait was written with a `*Self` receiver,
  which safe code rejects, and an earlier failure in the same batch had always masked it. It now
  uses `self : Self`.
- **Two other bugs found here:**
  `issues/fixed/passing-a-named-function-to-an-own-parameter-moves-the-definition.md` and
  `issues/fixed/arc-of-a-capture-free-closure-emits-two-arc-typedefs.md`.
