# Once `Io` is read at run time, what happens to a future viewed as bundle-less `Future(T)`?

**Kind:** design question — an open decision, not a defect.

**Status:** DECIDED 2026-11-19 (VERDICTS-68): option A, unconditional, in
v0.2.80 as its own PR (not shape-keyed). Implemented 2026-11-24 (branch
`v0280/io-v68`). Filed 2026-11-19 by the IO-1a lane
([`plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md`](../../plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md) §6).

## The question

The type checker lets a future whose effect bundle is the prelude's `Io` be
viewed as a bundle-less `Impl(Future(T))`
(`src/types/compatibility.yo`: `future_view_drops_a_bundle` and the
`flat_e_types.len() == 0` arm of `_compat_impl`). An await or spawn through
the view injects nothing, so the body runs against a zeroed bundle. The rule's
own comment gives the reason this is sound: the zeroed bundle is survived
"only [by] `Io` (builtins, never called through)".

std uses the view in six places:

- `sleep` and `Interval.tick` (`std/time/sleep.yo`);
- `yield` (`std/async/index.yo`);
- `Channel.recv` (`std/async/channel.yo`);
- `Mutex.lock` and `Mutex.with_lock` (`std/async/mutex.yo`).

The tests spell `-> Impl(Future(T))` in up to 78 more places (a grep upper bound; some are genuinely bundle-less).

IO-1b makes `Io` a `{ctx, vtable}` value, and every `std/sys` operation
dispatches through `io.vtable`. A body that runs with a zeroed `Io` then calls
through a NULL table. The plan's §2 premise "a task body's `io` is the one its
awaiter passed in the effect bundle" holds only for bundled future types.

The IO-1a lane measured it on a local IO-1b-shaped prelude, with the IO-1a
compiler:

```yo ignore
clock :: (fn(io : Io) -> Impl(Future(u64)))(
  io.async((io : Io) => {
    io.await(io.vtable.sleep(io.ctx, u64(1)), io);   // io is zeroed here
    io.vtable.now(io.ctx)
  })
);
main :: (fn(io : Io) -> unit)({
  t := io.await(clock(io), io);                       // Segmentation fault (rc 139)
});
```

The same program with `-> Impl(Future(u64, Io))` runs.

## Options

- **A. Reject the view once `Io` is read.** When the prelude's `Io` has the
  interface shape, a bundled future viewed as `Future(T)` is rejected like any
  other bundle (E0605, as for a handler bundle today).
  - The compiler change is a few lines in `src/types/compatibility.yo`, keyed
    on the `Io`'s shape, so it lands in IO-1a or IO-1c.
  - IO-1b's sweep then spells the six std signatures `Impl(Future(T, Io))`,
    plus the test sites.
- **B. Inject on the view.** An await or spawn of a bundle-less-typed future
  whose awaiter's bundle is the prelude's `Io` injects that `Io` anyway. The
  runtime already guards this: `__yo_future_set_bundle` is a no-op for a
  future with no bundle slot, and the compatibility rule admits only
  `Io`-bundled futures into the view.
  - This is a codegen change in IO-1a, and no signature changes.
  - It leaves a gap: an awaiter whose bundle is a struct holding the `io`
    (`ctx.io.await(f, ctx)`) cannot inject anything into an `Io` slot. That
    case must either be rejected or still run with a zeroed `Io`.
- **C. Keep the view and accept the zeroed `Io`.** This is not viable: every
  `std/sys` operation reads the table.

## Recommendation

**A.** A future's type should say what it reads.

- The view was sound only because `Io` was a type-level token. IO-1b removes
  exactly that property.
- Option B is a coercion rule with a hole (the struct-bundle awaiter). Option
  A is the exact type, which is the direction the maintainer has taken before
  (prefer the semantically exact option over a coercion).
- The cost is mechanical and lands in the one IO-1b sweep the plan already
  schedules: six std return types and at most 78 test sites become
  `Impl(Future(T, Io))`, and nothing above them changes. `std/fs` and
  `std/net` already spell `Impl(Future(T, Io))`.

If A is adopted, IO-1a (or a follow-up before IO-1b) adds the shape-keyed
rejection to `src/types/compatibility.yo`, and IO-1b's sweep fixes the
signatures in the same PR as the prelude flip.

## Verdict

Decided (VERDICTS-68, Fable 5.2, 2026-11-19; adopted by the coordinator):
option A, **unconditional**, in v0.2.80 as its own PR. No shape key, no
option B.

- Delete the `Io` exemption: a bundled future is never viewed as bundle-less.
  `Future(T)` stays the type of a future that reads no bundle (a raw
  `IoFuture`), and it still flows into any bundle.
- Why not shape-keyed: every seed already accepts the spelling
  `Impl(Future(T, Io))`; a dormant rule would ship untested in the v0.2.80
  seed; IO-1c would then have to delete it as scaffolding.
- Why v0.2.80: the rule has three enforcement paths, and a path it misses
  becomes a segfault once `Io` is read (IO-1b). Landing it one release early
  lets the suite and the example repos find holes cheaply. Fallback: the
  identical PR lands first in v0.2.81, stacked under the prelude flip, and is
  never shape-keyed.
- **The PR (checker):** remove `is_prelude_io_struct` from
  `future_view_drops_a_bundle` and from the `flat_e_types.len() == 0` arm in
  `src/types/compatibility.yo`, and fix the comment there. Check the three
  enforcement paths: the `_compat_impl` pre-check, the `FutureTraitT` arm, and
  the per-call `Impl` binding in `src/evaluator/calls/helper.yo`.
- **The PR (std):** about nine signatures: `sleep`, `Interval.tick`, `yield`,
  `Mutex.lock`, `Mutex.with_lock`, and `send`/`recv` on both channel types.
  The compiler enumerates them. Also swept: tests, about ten cli fixtures
  (read each golden diff), both doc languages, the pack,
  `.github/instructions`.
- **Diagnostic:** keep E0605 and extend its text: "...The future's body takes
  its `io` from the effect bundle, and `Future(unit)` names no bundle: an
  await or spawn through it would inject nothing. Name the bundle:
  `Impl(Future(unit, Io))`." `yo fix` inserts `, Io` when the expected type is
  a written annotation and the dropped bundle is exactly the prelude's `Io`;
  at an await that passes a non-`Io` bundle for such a future, a hint
  suggests passing the `Io` as the bundle.
- **Tests, rejection PR:** flip `tests/async/effect-bundle.test.yo` "an
  Io-bundled future can still be viewed as Future(T)" to
  `comptime_expect_error`; add negatives for the return-position view, the
  parameter view, a `Dyn(Future(T))` slot, spawn through the view, and a
  generic `R` (`with_lock`); add positives for an `IoFuture` flowing into
  `Future(T, Io)`, and a struct-bundle task awaiting `sleep(d, ctx.io)` with
  `ctx.io` as the bundle. The IO-1a PR adds nothing for this and leaves that
  test untouched.
- **Claim:** v0.2.80's claim is unaffected (with the four-field prelude
  nothing reads the zeroed `Io`). v0.2.81's claim depends on this rule, so
  IO-1b audits every site that starts a future without `set_bundle`.
