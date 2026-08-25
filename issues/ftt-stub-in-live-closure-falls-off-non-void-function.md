# A `Failed to transpile` marker in a LIVE closure falls off a value-returning C function

**Status: OPEN.** Found 2026-08-25 while landing the STD_API_AUDIT D2 naming
sweep. Reproducer: `issues/repros/ftt-stub-in-async-closure-returns-garbage.yo`.

A method that does not exist, called inside `io.async((e) => { ... })`, is
silently dropped. `yo check` passes, `yo compile` exits 0 with no diagnostic,
and the program returns a garbage value.

## Symptom

```rust
_boom :: (fn(io : Io) -> Impl(Future(usize, IoExn)))(
  io.async((e) => {
    s := HashSet(usize).new();
    s.no_such_method_at_all(usize(1));   // does not exist
    usize(7)
  })
);
```

```
$ yo check   tmp/fixme.yo                     # rc=0 — "tmp/fixme.yo — evaluator OK"
$ yo compile tmp/fixme.yo --release -o boom   # rc=0 — no diagnostic at all
$ ./boom
0                                             # expected 7
```

The emitted C is the whole story:

```c
static inline size_t closure_yo_id_5565(void* closure_context, __yo_t19 e) {
  __yo_t1* _file____User_temp_6443 = yo_id_3137__ret_R_gs_yo_id_3110_usize();
  __yo_t1* s = _file____User_temp_6443;
  // Failed to transpile (s.no_such_method_at_all)(usize(1));
  // Failed to transpile usize(7)
}
```

A `size_t`-returning function whose entire body is two comments. This is not
"returns 0" — falling off the end of a value-returning function is **undefined
behaviour**. The `0` is whatever this target left in the return register.

Both halves of that C were written by this compiler: it chose the `size_t`
return type and it chose to emit nothing for the body.

## Why this matters — the blast radius is silent and wide

This was not found by a test. It was found because `std/fs/walker.yo` hit it.

The D2 sweep renamed `HashSet.add` to `HashSet.insert`. One call site was missed:
`followed.add(canon_s)`, inside `walk_with`'s `io.async((e) => {...})` symlink-follow
loop. Every gate stayed green:

| gate | result with a BROKEN walker |
| --- | --- |
| `yo check ./std` | 152/152 passed |
| `yo check ./src` | 262/262 passed |
| `yo build` | rc=0 |

`walk_with` simply returned an empty `ArrayList(WalkEntry)`. Everything built on
it — `yo fetch`, `yo version`, `src/public_safe_report.yo`, `src/unsafe_report.yo`
— kept running and quietly traversed nothing.

The only signal anywhere was cli-case golden drift, from
`Scanned 1 .yo file(s); 2 public top-level fn declaration(s) inspected` to
`Scanned 0 .yo file(s); 0 public top-level fn declaration(s) inspected`. Had that
golden been re-recorded without being read, a compiler that silently disables
directory traversal would have shipped with a green scorecard.

## Root cause

`src/codegen/functions/generation.yo` scans each emitted function body for the
`// Failed to transpile` needle, then gates on ONE name:

```rust
if(stub_found_ftt && (c_function_name == "__yo_user_main"), {
  codegen_fatal(...)
});
```

The comment above it is explicit that this is deliberate, and that widening it
was already tried:

> Markers elsewhere are NOT gated here: the degrade guards keep the C valid, and
> the stub rewrite just below deletes the ones that land on dead superseded
> originals. Gating those too was tried and reverted — it failed `tests/fn.test.yo`
> and `tests/algebraic_effects.test.yo`, whose markers are exactly that dead code.

So the gate is scoped to avoid false positives on DEAD code, and the discriminator
it uses for "unambiguously harmful" is "is this `main`". A live closure is neither
`main` nor dead, so it escapes.

This is the deferred-generic hole named as still-open in
`issues/fixed/self-hosted-compile-swallows-undefined-call.md`:

> Scope is TS parity exactly: the deferred-GENERIC trial keeps discarding errors
> (TS's own `catch {}` at function-type.ts:112); the concrete path re-raises.
> ... The wider strict mode — the ~220 type-level swallow classes — stays OPEN.

The concrete path works: move the same call into `main` and the compile fails
with `Error: No matching call found with arguments:` (rc=1). That is an
EVALUATOR error raised on the concrete path, before codegen ever runs. Inside
the async closure the deferred trial swallows that same error, and codegen is
then handed an expression it cannot transpile. So the evaluator swallow is the
root and the FTT stub is the symptom — which is why the codegen-side gate below
is a containment measure, and the re-raise is the cure.

## Proposed fix

The real fix is the deferred-trial re-raise, i.e. closing the wider strict mode.
That is a campaign, not a patch.

But the gate can be made sound for this class WITHOUT needing dead-vs-live
analysis, because there is a second unambiguously-harmful condition available at
exactly the point the current check runs:

**a marker in a function with a NON-VOID return type, positioned such that the
function has no reachable return.** That C is invalid for a dead function and a
live one alike — nothing legitimate falls off the end of a value-returning
function. Extending the gate to that condition should not reproduce the
`tests/fn.test.yo` / `tests/algebraic_effects.test.yo` regressions, whose dead
markers need checking against this narrower predicate.

Independently, clang ALREADY detects this exact shape:

```
a.out.c:4124:1: warning: non-void function does not return a value [-Wreturn-type]
```

`src/main.yo` suppresses it — and investigating WHY exposed a second bug.

Optimized builds passed `-w` and then "re-enabled" a short list of diagnostics.
Measured on clang 21.1.7, that never worked: **`-w` is absolute.** No later
`-W…`, and not even `-Werror=…`, can bring a diagnostic back once `-w` is on
the command line. `-Wno-everything` behaves differently — later flags DO
override it.

| flags | on the FTT file above |
| --- | --- |
| `-w -Wincompatible-pointer-types -Wint-conversion -Wimplicit-function-declaration` (shipped) | rc=0 — ships the UB |
| `-Wno-everything <same three> -Werror=return-type` | rc=1 — `error: non-void function does not return a value` |

So the backstop needs BOTH: the blanket flag changed to `-Wno-everything`, and
`-Werror=return-type` (a bare `-W` would only warn and still build). That also
makes the three flags from
`issues/fixed/release-builds-suppress-all-c-warnings.md` effective for the
first time — see that issue.

The flag is still a backstop, not the cure: it catches the invalid C, but the
evaluator swallow that produced it remains the root.

## A SECOND bug, found while fixing the first: the marker scan is unanchored

`src/codegen/functions/generation.yo` decides whether a function body contains a
marker by scanning the emitted C for the raw bytes `// Failed to transpile`.
That text is not only a marker — it is also **data inside this compiler**:

- `src/codegen/exprs/generation.yo` builds the marker with
  `String.from("// Failed to transpile ")`, and
- the `codegen_fatal` message a few lines below the scan itself contains
  "Failed to transpile part of main's body".

So on any SELF-compile the scan matches the compiler's own source text.
**Measured on stage-2's emitted C: 14 hits, none of them a stub** — every one a
string literal of the form

```c
__yo_t0 tmp = yo_id_4576((__yo_str){ .ptr = (const uint8_t*)"// Failed to transpile", .len = 22 });
```

This was latent because the two consumers were narrowly scoped: the fatal gate
only fires for `__yo_user_main`, and the rewrite only for
`fid_fully_specialized` originals. It stops being latent the moment either
widens — generalizing the rewrite to non-void functions replaced **7 substantial
emitter functions** (`expr, indent, context`) with `abort()`, ~950 KB of deleted
bodies, and stage 3 died with `STAGE3_RC=134` (SIGABRT).

It is also reachable WITHOUT any change: a user program whose `main` contains the
literal text `// Failed to transpile` — a Yo program that generates C, say —
trips `codegen_fatal` today for no reason.

**Fix:** line-anchor the match. A genuine marker is a comment that starts its own
line; a string literal is always mid-line inside an expression. Walk back over
spaces/tabs and require a newline (or buffer start).

## Regression test

`issues/repros/ftt-stub-in-async-closure-returns-garbage.yo` must fail to compile
(rc != 0) once fixed. Today it compiles clean and prints `0`.
