# An overlapping blanket trait impl is silently DEAD — no error, no warning, no dispatch

**Status:** OPEN. **Found:** 2026-09-17 by the peer session (yo-12) while
probing whether `Default` could be refined by a comptime-capable sibling trait.

**Verification status:** the measurement below is the REPORTER's, quoted as
given; I have not independently reproduced it. The analysis of which channel
this belongs to is mine and is REASONED from the plan/issue record, not
measured.

## The measurement

A blanket impl over a bound, alongside the prelude's explicit impls for the
same trait and types:

```rust
impl(generic(T), where(T <: (ComptimeDefault, Comptime)), T, Default(default : ...));
// prelude already has: impl(i32, Default(default : (fn() -> Self)(i32(0))));
```

- **compiles `rc=0`** — no error, no warning;
- `i32.default()` returns the PRELUDE's value. With the blanket impl
  deliberately returning `7`: `compile_rc=0  run='0'`.

So the explicit impl wins and **the blanket impl never fires**. It is dead code
that looks live.

### The probe design detail that matters

The first run had BOTH impls returning `0`, and "compiles and runs correctly"
looked like evidence the refinement was viable. It proved nothing — the two
arms were indistinguishable. Only changing the blanket's value to `7` made the
question answerable. **An A/B whose arms produce identical output is vacuous**,
and it reads exactly like a pass (cf.
`issues/fixed/`-era `comptime_assert` vacuity, and the hollow-batch class).

## This is NOT the duplicate-inherent-method channel

`plans/backlog/DUPLICATE_INHERENT_METHOD_REJECTION.md` is **IMPLEMENTED
(2026-08-21)** and covers *inherent* methods registered twice on one type.
Both impls here are TRAIT impls of `Default`, one blanket-over-a-bound and one
for a concrete type. That is **trait-impl overlap** — Rust's coherence and
specialization territory — and nothing in the tree rejects or ranks it. So the
implemented work does not cover this, and citing it would close the wrong door.

## Why it matters beyond the probe

A blanket impl is how a trait is refined across a whole family at once. If it
silently loses to any pre-existing explicit impl, then:

- a refinement can be written, reviewed, merged and **ship inert**, with every
  gate green — the exact "reports success for work it did not do" shape that
  `plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md` exists to remove;
- the failure is invisible in tests whenever both impls agree, which they
  usually will (a default is a default) — so the natural test passes;
- it makes any future `Default` refinement require removing all **14** explicit
  `Default(default : ...)` impls from the prelude first, which is a far larger
  change than the feature that wanted it.

## What a fix should decide (design, not yet decided)

Yo has no overloading and a documented "inherent NO, trait YES" model, so the
options are the usual two, and the choice is a language call:

1. **Reject the overlap** — an error when a blanket impl over a bound and an
   explicit impl for a type in that bound both exist. Simple, matches the
   no-overloading stance, and forces the 14 removals to be explicit.
2. **Rank them** (specialization): the more specific impl wins, *stated* rather
   than incidental, and the blanket is then legitimately a fallback. More
   useful, much more design.

Doing neither is the current state and is the worst of the three, because it
picks option 2's behaviour without telling anyone.

## Reproducer

Minimal shape, to be re-measured before any fix:

```rust
// with the prelude's impl(i32, Default(...)) already present
impl(generic(T), where(T <: Comptime), T, Default(default : (fn() -> Self)(i32(7))));
main :: (fn() -> unit)(println(`${i32.default()}`));   // prints 0, not 7
```

Expected today: `rc=0`, prints `0`. A fix under option 1 makes it a compile
error; under option 2 it prints `0` **by a stated rule**.
