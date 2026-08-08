# yo-self's RC depth cap silently skips teardown for deeply nested values

**Found 2026-08-08.** Confirmed with a minimal reproducer and a differential
run against the TS compiler. **Leak direction, not corruption.**

## Symptom

An object nested more than 8 aggregate levels deep is **never torn down** by the
self-hosted compiler. Its `dispose` does not run and its refcount is never
decremented. The same object nested 8 levels deep is torn down correctly.

Reproducer: [`issues/repros/rc-depth-cap-skips-deep-teardown.yo`](repros/rc-depth-cap-skips-deep-teardown.yo)

```
                       depth 8 (control)   depth 10 (past cap)
  TS (src/)            disposed=7          disposed=42
  yo-self              disposed=7          (nothing — leaked)
```

Both compilers print the same values and exit 0. The divergence is invisible to
any stdout+exit-code differential; only the missing `disposed=` line reveals it.

## Root cause

`_type_contains_rc_inner` in `yo-self/types/utils.yo` caps its recursion by
**depth**:

```rust
    // Depth limit — conservative: return false at max depth
    (depth > u32(8)) => false,
```

TS's `typeContainsRcType` (`src/types/utils.ts:130-175`) has **no depth cap**.
It guards recursion with an identity visited-set:

```ts
if (checkedTypes.includes(type)) {
  return false;
} else {
  checkedTypes.push(type);
}
```

The port's own comment explains the substitution — a depth cap was chosen
"instead of a checkedTypes set" because yo-self's `TypeValue` is **value-typed**
and cannot do TS's reference-identity `includes` cheaply. That is a real
representational difference, so this was a considered trade, not an oversight.
But the two guards are not equivalent: TS's terminates only on an actual
**cycle**, while yo-self's also terminates on ordinary **non-recursive nesting**,
and answers `false` — "contains no RC" — when it does.

### Why it leaks rather than corrupts

The predicate is consulted at two different starting points for the same value:

- the **dup** decision inspects the argument type — `Tracked` at depth 0, which
  `is_rc_type` accepts immediately, so the dup **is** emitted;
- the **drop** decision inspects the variable's type — `L0`, from which
  `Tracked` sits at depth 10, so the cap answers `false` and the drop is
  **not** emitted.

Dup without drop is a leak. Had both consulted the predicate at the same depth
they would both have answered `false` and the result would have been
self-consistent (no dup, no drop) — which is why this survived every gate.

## Why no existing gate catches it

`type_contains_rc_type` has **139 references** in `yo-self` and gates the whole
RC dup/drop policy (`env.yo` `get_variables_needing_drop`, the closure-capture
ownership checks, both dup markers, `types/union.yo`). Despite that reach:

- the **stage-2/stage-3 fixpoint** proves the compiler is self-_consistent_, and
  a uniformly-missing drop is perfectly self-consistent;
- **`check ./std`** only type-checks — it never runs teardown;
- the **155-program corpus differential** compares stdout and exit code, and a
  leak changes neither;
- no test in the repo nests aggregates deeper than the cap.

## The same pattern is next door — and it is enormously hot

`_type_is_control_bound_inner` in the same file carries an identical
`(depth > u32(8)) => false` cap with the same rationale comment. Marker counts
per workload (each marker print = one walk that recursed 9+ levels and gave up):

| workload                         | `__DBG_RC_DEPTH8_FIRED` | `__DBG_CTL_DEPTH8_FIRED` |
| -------------------------------- | ----------------------- | ------------------------ |
| `check ./std` (153/153 pass)     | 0                       | 117                      |
| `check ./yo-self` (238/238 pass) | 0                       | 1,864,783                |
| self-emit of `yo-self/main.yo`   | 0                       | **181,325,397**          |

**181 million cap hits in a single self-compile.** Almost certainly the guard
doing its intended job on genuinely self-referential types — but that is exactly
where the two guards differ in COST, not just in answer: TS terminates the
moment it revisits a type, while yo-self re-walks nine levels **every time**.
For a cyclic type both return `false`, so this is not a correctness difference
— it is potentially a large, entirely unmeasured slice of self-compile time,
and it is invisible in a profile as "type walking" rather than as a cap.

So the visited-set fix below is a **correctness fix for the RC predicate and a
performance lever for the control-bound one**. Size the perf prize by measuring
before/after on a self-emit; do not assume it.

(The RC marker never fired in any real workload — only in the synthetic
reproducer — so the leak's blast radius on today's code is small. The bug is
real and reachable, but nothing in `std/`, `yo-self/`, or the corpus nests
deeply enough to hit it.)

## Suggested fix

Do not raise the cap — that moves the threshold without removing the class.
Cycles can only arise through **self-referential named struct/enum shells**
(`resolve_enum_shell` / `resolve_struct_shell` at the head of the walk), not
through ordinary nesting. So track visited **shell identities** and drop the
depth cap entirely: recursion still terminates on genuine recursive types, while
non-recursive nesting is walked to any depth, matching TS.

Apply the same treatment to `_type_is_control_bound_inner`.

## Probe method (reusable)

Replacing the cap's `false` with a marker print localizes it in one build:

```rust
    (depth > u32(8)) => {
      eprintln(`__DBG_RC_DEPTH8_FIRED`);
      false
    },
```

then grep the marker across `check ./std`, `check ./yo-self`, a full self-emit,
and any candidate reproducer. Note `eprintln` is already in scope in that file
via an open import — adding `{ eprintln } :: import("std/fmt")` fails with
"variable shadowing is not allowed".
