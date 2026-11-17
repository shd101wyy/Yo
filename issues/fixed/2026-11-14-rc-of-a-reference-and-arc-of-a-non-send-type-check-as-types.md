# `Rc(&T)` and `Arc(NonSend)` type-check as types for one release

**Severity:** S3 (no safe program builds such a value; only a type spelling
that should be rejected is accepted)

**Status:** FIXED in v0.2.79 (`std/rc-arc-where-bounds`). Accepted for v0.2.78 by
the coordinator (2026-11-14); filed by the decision 49 S2 lane (`vbd/d49-s2`).

## What

Before S2 the prelude declared

```yo ignore
Rc :: (fn(comptime(V) : Type, where(V <: Escapable)) -> comptime(Type))(...)
Arc :: (fn(comptime(V) : Type, where(V <: (Send, Sync, Escapable))) -> comptime(Type))(...)
```

so the type `Rc(&i32)` or `Arc(Counter)` (with `Counter` not `Send`) was itself
an error. S2 declares the cells over `comptime(V) : ?Sized`, and the v0.2.77
seed cannot read a `where` on a `?Sized` type-constructor binder: its comptime
pre-scan evaluates `?Sized` as `Option(Sized)` and binds `V` to an unknown
value (finding F1, `plans/backlog/SEED_VERSION_AUTOMATION.md`, "Seed-gated
follow-up (2026-11-13)"). The compiler side is fixed in S2 (Generation A,
`src/evaluator/types/function.yo` Pass 3), but the prelude must compile under
the seed, so the bounds moved from the declarations to the constructors:
`Rc.new` carries `where(V <: Escapable)` and `Arc.new` carries
`where(V <: (Send, Sync, Escapable))`. Every other `Arc`/`ArcWeak` impl
already states `where(T <: (Send, Sync))`.

As a result a type spelled `Rc(&T)`, `Arc(NonSend)` or `ArcWeak(NonSend)`
type-checks. No safe constructor builds a value of it: `Rc.new` / `Arc.new`
still reject the payload with E0909's unchanged text.

`tests/arc.test.yo` lost one row for this:
`comptime_expect_error(Arc(Counter))` no longer errors, and the row was
removed with a comment pointing at the constructor bound. `tests/sync/refcell.test.yo`'s
`comptime_expect_error(Arc(RefCell(i32)))` row was missed there and turned four develop language
shards and the TSan job red (battery 43647918952); it now expects the error from
`Arc.new(RefCell(i32).new(i32(0)))`.

## Reproducer

```yo ignore
_NotSend :: struct(p : *i32);
// Accepted on vbd/d49-s2; an error on v0.2.77:
_T :: Arc(_NotSend);
```

## Resolution

Fixed in v0.2.79 as the Recommendation said, with `SEED_VERSION` at v0.2.78
(which carries S2's Generation A, the `?Sized` pre-scan fix). `std/prelude.yo`
declares `Rc :: (fn(comptime(V) : ?Sized, where(V <: Escapable)) -> ...)` and
`Arc`/`ArcWeak` over `where(V <: (Send, Sync, Escapable))`, and the
constructor-level copies on `Rc.new` and `Arc.new` are gone: the bound is now
on the type, so `Rc(&T)`, `Arc(NonSend)` and `ArcWeak(NonSend)` are E0909
(same text, binder `V`) wherever they are spelled. The v0.2.78 seed accepts the
std (`yo check ./std --std-path ./std`).

Tests (each fails on the parent commit, where the type spellings are accepted):
`tests/arc.test.yo` (`Arc(Counter)`, `ArcWeak(Counter)`),
`tests/sync/refcell.test.yo` (`Arc(RefCell(i32))`), and
`tests/borrow_spelling.test.yo` (`Rc(&i32)`, `Arc(&i32)`).
