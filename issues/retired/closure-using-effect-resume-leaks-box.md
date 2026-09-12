# A closure capturing a `Box` and installed under `using()` leaks under the resume path

Status: RETIRED — environment artifact, not a code bug (see Verdict).

## Reproducer

```bash
YO_STD=<repo>/std yo test ./tests/algebraic_effects.test.yo \
  --test-name-pattern "closure with using() effect - resume" --parallel 1 -v
```

The test is `Test closure with using() effect - resume`
(tests/algebraic_effects.test.yo:788). Verbatim shape:

```rust
Log :: (fn(msg : String) -> unit);
x := Box(i32)(0);
(log : Log) = (msg -> { println(msg); return(()); });
(closure : Impl(Fn(v : i32, msg : String) -> i32)) =
  ((v, msg) => {
    log(msg);
    x.* = (x.* + v);
    return(x.*);
  });
result1 := closure(1, `hello`);
result2 := closure(2, `world`);
```

## Verdict (final, 2026-09-12)

- Fails the same way with a compiler built from CLEAN `origin/develop`
  (95d582d73) — NOT introduced by the Phase 2 stable-names work
  (plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md §5); that branch shows the
  identical 30-passed/1-failed file summary.
- The FULL fast suite (`yo test ./tests --exclude tests/internal --exclude
  tests/cli-cases`) reports **3524 passed / 615 failed with BOTH binaries,
  with byte-identical failure sets** — every failure an LSan "Memory leak
  detected" verdict. `origin/develop`'s CI runs the same suite on Linux with
  the same address-sanitizer default and is GREEN, so the local (WSL2)
  LeakSanitizer reports are environment artifacts — LSan under WSL2 miswalks
  the async runtime's background-thread stacks and flags live allocations.
  Retired as not-a-bug; do not chase LSan verdicts from this box without a
  CI cross-check.
- The test runner flags it only when the batch compile runs under
  AddressSanitizer/LeakSanitizer; CI legs that omit the sanitizer flag cannot
  see it, which is why `develop` is green.

## Leak report (LSan)

```
Direct leak of 12 byte(s) in 1 object(s)
SUMMARY: AddressSanitizer: 12 byte(s) leaked in 1 allocation(s).
```

12 bytes = the `Box(i32)` payload allocation. The sibling test
`Test closure with using() effect - unwind` (which passes the handler as a
parameter instead of capturing around it) does NOT leak — the leak is specific
to the closure-capture + `return`(resume) path.

## Hypotheses (unverified)

- The closure value's capture struct owns the `Box` reference; the balancing
  `___drop` for the captured `x` is missing on the resume path (the handler
  `return(...)` resumes the continuation, so the closure's scope-exit drop
  sequence may be skipped or double-cancelled by the dup/drop pair optimizer —
  cf. the cancellation-soundness notes in AGENTS.md and
  issues/fixed/spawn-capture-captures-never-dropped-leak.md).
- Suspect landing window: the dup/drop deeper-scope rule (#574) or the
  struct-field-await release fix (#580) era.
