# Once `Io` is read at run time, what happens to a future viewed as bundle-less `Future(T)`?

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN. It must be decided before IO-1b (v0.2.81) flips the prelude.
Filed 2026-11-19 by the IO-1a lane
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
