# A closure defined INSIDE an `io.async` closure body makes that body untranspilable — `abort()`, scored `0 real`

**Status: OPEN.** Found 2026-08-26 while reviewing the C16 fix; **pre-existing**,
reproduces identically on develop tip and is not caused by that fix.

## Symptom

```rust
twice :: (fn(k : usize, io : Io) -> Impl(Future(usize, IoExn)))(
  io.async((e) => {
    f := ((x : usize) -> (x * usize(2)));   // <-- a closure inside the async body
    a := e.io.await(rd(k, io), e);
    f(a)
  })
);
```

`yo compile … --release` exits **0**, clang is clean, and the binary dies
**rc=134** with no output. The emitted C is

```c
static inline size_t closure_yo_id_6840(void* closure_context, __yo_t16 e) {
  abort(); /* untranspilable body in a value-returning fn: aborting beats falling off the end (UB) */
}
```

and the enclosing future is a `_sync_fut_t`, not a state machine — the await
analysis never ran because the body eval was swallowed.

## Why it is easy to miss

`scripts/count-transpile-failures.sh` scored this file **`0 real`** before
2026-08-26: PR #275 replaces the marker comments with `abort()` in
value-returning functions, so the marker count cannot see it. The script now also
prints an `N abort-stub` field; this file is `0 real (0 string-literal floor, 1
abort-stub)`.

## Reproducers

- `issues/repros/closure-nested-in-io-async-closure.yo` — free async fn, no traits.
- The same body inside a trait `?=` default behaves identically (2 stubs for two
  implementors), which is how it was found.

## Scope

Independent of traits, of `Self`, and of the C16 fix — VERIFIED by compiling the
free-function form with a compiler built from develop and with one built from the
C16 branch: both emit the stub, both rc=134.

## Gate

```bash
yo compile issues/repros/closure-nested-in-io-async-closure.yo \
  --std-path ./std --release -o /tmp/n.out && /tmp/n.out    # must print 6, not rc=134
bash scripts/count-transpile-failures.sh /tmp/n.out.c        # must be 0 abort-stub
```
