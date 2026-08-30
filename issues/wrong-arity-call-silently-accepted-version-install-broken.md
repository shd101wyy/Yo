# A wrong-arity call is silently accepted — and it broke `yo version install` in every release

**Status: OPEN (compiler hole); the one production instance is FIXED.**
Found 2026-08-30 validating the D6 PR-3 curl→std/http swap: `yo version
install <v>` either silently no-opped (rc=0, nothing cached, zero output) or
died with a bare SIGABRT (rc=134) — nondeterministically — **including in the
released v0.2.19 and v0.2.20 binaries**, so the breakage long predates the
swap.

## The production instance (fixed)

`src/version_cache.yo` `ensure_cached_version` called

```rust
cached := e.io.await(is_version_cached(version, e.io), e);
```

— TWO args for the THREE-param `is_version_cached(version, io, exn)`. At
runtime the missing `exn` record made `cached` read garbage: truthy garbage
took the `if(cached)` arm and returned the cache dir silently (the rc=0
no-op), falsy garbage continued into corrupted state (the silent rc=134).
Fixed by passing `e.exn`. (The `exn` params on these helpers are DEAD — the
bundle at the await carries the handlers — which is why the body worked at
all; a parameter-list diet is a separate cleanup.)

## The full inventory (all in `src/version_cache.yo`, all FIXED 2026-08-30)

Any ONE def-eval failure inside an `io.async` body hollows the WHOLE emitted
state machine — the await of the resulting future silently early-returns from
the caller (the plain-fn await's aborted-future path). `download_version`'s
body had THREE independent hollowing causes:

1. `ensure_cached_version` → `is_version_cached(version, e.io)` — 2 args for
   3 params.
2. `_cleanup_failed_download(version_dir, tmp_dir.path(), e.io)` — 3 args for
   4 params, at FOUR call sites.
3. A local named `short` interpolated in the 404-fallback println —
   builtin-first dispatch resolved the prelude C-interop integer type instead
   of the local ("Argument count mismatch: expected 1, got 0" in the template
   lowering; issues/builtin-name-shadows-user-definition.md third face, now
   with a production casualty). Renamed to `short_name`.

A tree-wide `YO_DEBUG_SWALLOW=1 check` sweep for "Argument count mismatch"
was run over ./src and ./std after the fixes.

## The gate gap (why nothing caught a hollow async body)

The C22 stub gate attributes hollow CLOSURES whose calls survive; a hollow
ASYNC STATE MACHINE body is emitted as a structurally valid SM that never
runs its statements and completes/aborts immediately — no abort-stub, no
attribute, a green build. The C22-class enforcement needs an async-SM
equivalent: an SM whose body ExprInfos were never stamped must poison its
resume function the same way.

## The compiler hole

The evaluator accepts the wrong-arity call: the call's def-time evaluation
fails, the swallow eats it (the
issues/fixed/def-eval-swallow-remaining-roots.md family;
memory-of-record: "check accepts wrong-arity calls"), and codegen emits a
call with too few C arguments — UB that presents as garbage values, not as an
error anywhere. `yo check ./src` was green the whole time.

Same enforcement family as C61 (rejected outside the swallow) and the C22
stub gate (C compiler as the deadness oracle): **argument-count validation
against the resolved callee must run OUTSIDE the def-eval trial swallow** —
arity is knowable even when the trial body fails for other reasons.
`try_to_call_function_with_arguments` already throws "Argument count
mismatch: expected N, got M" in some paths (seen in C60's swallow traces), so
the gap is which layer swallows it for this shape (an io.async-wrapped
helper called from another async body).

## Test gap

`yo version install` has no test at any level — it needs network, so the CLI
corpus never covers it (this is how a total breakage shipped in at least two
releases). Minimum: a compiler test pinning the ARITY rejection
(comptime_expect_error on a 2-arg call to a 3-param fn in the async-helper
shape), and a version_cache unit test that stubs `_download_file`.
