# A captured closure is judged for `Send` by its own capture struct, so a closure whose captures are all `Send` is rejected

**Status:** OPEN. **Class**: valid code rejected. **Split out 2026-09-14** from
`issues/fixed/thread-spawn-callback-returning-a-zst-emits-void-star-from-void.md`,
whose two *emission* symptoms are fixed (`issues/fixed/closure-call-binds-a-void-result-to-a-void-pointer-temp.md`)
while this — the reason D18 part 2 is still blocked — is a different defect in a
different component and was going to be lost when that doc closed.

**Not independently re-reproduced.** Everything below is the record carried over
from the parent doc, which measured it. Reproduce it before acting on it.

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

None yet. A test must pin the accept AND the reject: a helper-wrapped spawn
whose captures are all `Send` must COMPILE, and the same shape with one
non-`Send` capture must still be REFUSED with the existing diagnostic.
Landing only the first half would turn this into a hole in `Send` enforcement.

## Related

- `issues/fixed/thread-spawn-callback-returning-a-zst-emits-void-star-from-void.md` — parent
- `issues/fixed/send-was-not-enforced-at-spawn-boundaries.md` — the #451 enforcement this rides on
- `plans/STD_API_STABILIZATION.md` — D18
