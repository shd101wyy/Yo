# A bundled future viewed as `Future(T)` runs with a zeroed bundle and segfaults

**Severity:** S1 — memory unsafety in safe code: a program that passes `yo check` calls through a null function pointer (`EXC_BAD_ACCESS` at address 0) at the task's first handler call.

**Status: FIXED 2026-10-03** (phase A3 of `plans/ASYNC_IO_API_AUDIT.md`). Found 2026-10-03 by `plans/ASYNC_IO_API_AUDIT.md` (finding F6, probe 5). **Measured on:** develop `bcb57bfe7` built by the v0.2.49 seed, macOS arm64, `--optimize 2` (rc 139) and `--sanitize address` (same; `lldb`: `stop reason = EXC_BAD_ACCESS (code=1, address=0x0)`, frame #0 at `0x0`).

## Symptom

`issues/repros/a-bundled-future-viewed-as-future-t-runs-with-a-zeroed-bundle.yo`:

```rust
Ctx :: struct(io : Io, raise : Raise);
make :: (fn(io : Io) -> Impl(Future(i32, Ctx)))(
  io.async((ctx : Ctx) => {
    ctx.io.await(yield(ctx.io), ctx.io);
    ctx.raise(`boom`)
  })
);
run_view :: (fn(f : Impl(Future(i32)), io : Io) -> i32)(io.await(f, io));
main :: (fn(io : Io) -> unit)({
  v := run_view(make(io), io);   // SIGSEGV
});
```

`yo check`: evaluator OK. The binary dies at `ctx.raise`.

## Cause

Three rules compose:

1. `Future(T)` has empty effect lists, and compatibility treats "empty on either side" as compatible (`src/types/compatibility.yo` 1577–1580), so a `Future(i32, Ctx)` is accepted where `Impl(Future(i32))` is expected.
2. The await-site bundle check (`src/evaluator/calls/helper.yo` 7409–7470) runs only when the future's STATIC type has exactly one effect; through the view it has none, so nothing is checked.
3. The lowering injects a bundle only when the static type carries one (`src/codegen/exprs/await.yo:293` returns early), so the slot keeps the zero it was given at construction (`src/codegen/exprs/async.yo:1387`). The body's `ctx.raise` is a call through that zero.

`ctx.io` is zeroed too; the body happens to reach `ctx.io.await(yield(ctx.io), ...)` first and survives it because the `Io` fields are not called through on that path.

## Expected

Rejected at `yo check`: a future whose static type names no bundle cannot be awaited or spawned when its dynamic type carries one, or `Future(T)` is not compatible with `Future(T, E)` in that direction. Raw `IoFuture`s and `yield` are genuinely bundle-less and stay as they are.

## Fix direction

Either direction-sensitive compatibility (`Future(T, E)` is a subtype of nothing with fewer effects), or an await/spawn-site check against the dynamic bundle size recorded in the future's vtable (`bundle_size != 0` with no injection is a compile error where the type is known, a trap where it is not). Recommended in `plans/ASYNC_IO_API_AUDIT.md` A3: reject at the await with a new diagnostic. Regression test: `comptime_expect_error` on the repro shape, plus `IoFuture` and `yield` still awaitable through `Future(T)`.

## Fix

Future compatibility is direction-sensitive (`src/types/compatibility.yo`). A bundle-less future (a raw `IoFuture`, `yield`) is still compatible with any bundle, since it reads none. A bundled future is compatible with a bundle-less `Future(T)` only when every bundle type is the prelude's `Io` (`is_prelude_io_struct`, `src/types/guards.yo`): `Io`'s fields are the compiler's async builtins and are never called through, so a body that receives a zeroed `Io` behaves the same. A handler bundle is now rejected at the conversion, at `yo check`. The await-site bundle check also compares field types, not only labels (`src/evaluator/calls/helper.yo`, Step 7c).

Regression tests: "a handler-bundled future cannot be viewed as Future(T)", "an Io-bundled future can still be viewed as Future(T)" and "a bundle with the right labels and a wrong handler type is rejected" in `tests/async/effect_bundle.test.yo`.
