# A captured closure is judged for `Send` by its own capture struct, so a closure whose captures are all `Send` is rejected

**Severity:** S2 — valid Send-closure spawn helpers are rejected because Send is judged on the capture struct, not the closure's type

**Status:** FIXED. Closed 2026-10-17: re-measured with develop at 5425cd7bf, and it no
longer reproduces. Two earlier PRs fixed it; neither cited this doc (see "Fix" below).
**Class**: valid code rejected. **Split out 2026-09-14** from
`issues/fixed/thread-spawn-callback-returning-a-zst-emits-void-star-from-void.md`,
whose two *emission* symptoms are fixed (`issues/fixed/closure-call-binds-a-void-result-to-a-void-pointer-temp.md`)
while this — the reason D18 part 2 is still blocked — is a different defect in a
different component and was going to be lost when that doc closed.

**Not independently re-reproduced when filed.** The Symptom and Root cause sections
are the record carried over from the parent doc, which measured them. The Fix
section records the 2026-10-17 re-measurement.

## Symptom

Wrapping a spawn in a helper — so that the callback becomes a *captured*
variable of the spawn closure rather than going straight to
`__yo_thread_spawn` — makes the full suite reject it.
`tests/sync/once.test.yo` fails with:

```
error: Captured variable 'cb' (type Impl : (Fn(Io) -> unit + Send)) does not
implement Send. To move it across threads, wrap it in Arc/Iso, or capture a
Send projection of it instead.
```

The declared type in the message says `+ Send`. The value is `Send`. It is
rejected anyway.

## Root cause (as recorded)

`validate_capture_trait_requirements` (`src/evaluator/utils/closure.yo:224`,
added by #451's `Send`-at-spawn enforcement) judges each captured variable
through `_capture_judgement_type`, and that helper resolves a captured
**closure** to *its own capture struct*. One more level of nesting therefore
puts a plain struct in front of the checker — a struct that carries no `Send`
impl of its own, even when every value inside it is `Send`.

So the judged type and the declared type are different things, which is also
why the obvious fix does not work: **adding `Send` to the helper's parameter
does not help** (tried, per the parent doc) — the declared type is what the
message prints, but the capture struct is what is judged.

## Why it matters

It blocks the helper form of any std-side wrapper around a user task closure,
which is what D18 part 2 needs. The parent doc names the two ways out:

1. fix the spawn lowering's ZST-returning captured call so the **inline** form
   works and no helper is needed — **this one has since landed**, so the
   inline route may already be unblocked and should be re-measured first; or
2. teach `_capture_judgement_type` that a closure whose own captures are all
   `Send` is itself `Send`, which makes the **helper** form work.

The parent doc's judgement on (2) still stands and is worth keeping: it
touches a security-relevant checker — the one thing standing between a
non-`Send` value and a data race — and should not be rushed. A wrong
generalisation here fails *open*.

## Regression test

A test must pin the accept AND the reject: a helper-wrapped spawn
whose captures are all `Send` must COMPILE, and the same shape with one
non-`Send` capture must still be REFUSED with the existing diagnostic.
Landing only the first half would turn this into a hole in `Send` enforcement.

Landed 2026-10-17 in `tests/thread_safety.test.yo`, after the D18b block:
- `_run_on_thread` is a helper whose `sink(cb) : Impl(Fn() -> unit, Send)` its
  own spawn closure captures.
- `_helper_with_send_captures` passes it a closure that captures an `Arc` of
  an atomic, plus a second closure over the same `Arc`. It compiles.
- Two `comptime_expect_error` blocks give the same call a closure that
  captures a local `ArrayList`, directly and one closure further in. Each
  must raise its capture diagnostic. The expected texts are pinned, and a
  mutated text fails the check.

## Fix

The fix landed in two earlier PRs. Neither PR cited this doc.

1. **#612 (D18b, 2026-09-12): `_declared_bound_requires`** (`src/evaluator/utils/closure.yo`).
   - The symptom recorded above came from a captured variable whose declared
     type already lists the marker (`cb : Impl(Fn(Io) -> unit, Send)`).
   - Such a capture is now accepted on its declaration. The bound is a proof
     obligation that the caller discharged where the value entered.
   - `std/thread.yo`'s own `Thread(T).spawn` relay is this shape. It is
     pinned by `_forward_a_bounded_callback` in `tests/thread_safety.test.yo`.
2. **#902 (PARALLELISM_RULES D4 + D9, 2026-09-26): per-value judgement of a captured closure.**
   - `function_value_marker` judges a captured closure by its value, at both
     the spawn check and the argument check.
   - `record_closure_capture_verdicts` and `_captures_offense` memoize each
     closure's verdict per captured variable, when the closure is created.
   - So a closure nested in a closure is judged by its innermost captures,
     never as a plain struct.

Re-measured on develop 5425cd7bf:
- A spawn closure that captures `outer`, which captures `inner`, which
  captures an `Arc(AtomicI32)`, compiles and runs.
- `arc(...)` of such a closure also compiles and runs.
- The helper form compiles when the helper's parameter is declared
  `Impl(Fn(...), Send)`.

**What is still rejected, by design.** A helper whose parameter is a bare
`Impl(Fn() -> unit)`, with no `Send`, is refused where it is defined:
"Captured variable 'cb' (type Impl(Fn() -> unit)) does not implement Send".
- At definition time `cb` has no value, so its declared type decides
  (PARALLELISM_RULES D9: "A closure `Impl(Fn(...))` type with no value found
  is judged by what it declares").
- A generic `x : T` capture without `where(T <: Send)` is refused the same way.
- Rust also requires `F: Send` here.
- Relaxing it would fail open: the helper's body would be accepted for every
  caller, including one that passes a closure over an `ArrayList`. The fix
  for such a helper is the declaration, `Impl(Fn(...), Send)`.

## Related

- `issues/fixed/thread-spawn-callback-returning-a-zst-emits-void-star-from-void.md` — parent
- `issues/fixed/send-was-not-enforced-at-spawn-boundaries.md` — the #451 enforcement this rides on
- `plans/archive/STD_API_STABILIZATION.md` — D18
