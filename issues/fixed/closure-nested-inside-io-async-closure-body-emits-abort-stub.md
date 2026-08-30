# A closure defined INSIDE an `io.async` closure body makes that body untranspilable — `abort()`, scored `0 real`

**Status: FIXED** (2026-08-29, `src/codegen/functions/generation.yo`): every
value-returning `abort()` stub (a body whose definition-time evaluation failed
and was swallowed) is now declared with GCC/Clang's
`__attribute__((error("yo: the body of <fn> failed to transpile …")))` — on
its FIRST declaration (clang requires that; the prototype is retro-patched in
the emitter buffers) and on the definition. The C compiler is thereby the
deadness oracle: a stub nothing calls (a dead generic original — the corpus
carries several, and `fid_fully_specialized` is NOT a reliable deadness
predicate; a comptime-folded call site also leaves its callee dead) compiles
clean, while any surviving call fails the build with a message naming the
function and pointing at `YO_DEBUG_SWALLOW=1`, instead of shipping a binary
that dies rc=134 with no diagnostic. Text scans cannot decide liveness in the
emitter (closures and their callers live in the declarations buffer;
prototypes double-count) — two such designs were built and discarded.

What the original repro's body hit was a genuine type error —
`f := ((x : usize) -> ...)` binds a fn literal with no expected type
("Expected a function type", rejected at top level too); the supported
spelling `(f : (fn(x : usize) -> usize)) = ((x) -> ...)` inside an async body
compiles and prints 6. The second symptom below (a nested `io.async` with a
value) is a real evaluator gap tracked in
`issues/fixed/nested-io-async-inside-io-async-body-fails-def-eval.md` (fixed 2026-08-30); with this
fix it reports at every surviving call instead of mis-emitting.

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

## Second symptom (2026-08-29): a nested `io.async` with a value — clang error

An `io.async` closure bound INSIDE another `io.async` body and awaited there:

```rust
two_hop :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io) => {
    inner := io.async((io) => {
      io.await(sleep(u64(1)), io);
      return(i32(1));
    });
    v := io.await(inner, io);
    return(v + i32(41));
  })
);
```

does not reach the abort stub: clang rejects the emitted C —
`error: non-void function 'closure_yo_id_12479' should return a value
[-Wreturn-mismatch]` at a bare `return;` — the inner closure was emitted as a
unit-returning body although its future carries `i32`. Same C22 rule applies
(hoist the inner body to a top-level `fn` returning `Impl(Future(...))`);
hit while writing tests/async_await.test.yo's event-loop regression test.
