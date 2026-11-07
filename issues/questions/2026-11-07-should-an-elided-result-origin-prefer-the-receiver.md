# Should an elided result origin prefer the receiver's?

**Kind:** design question — an open decision, not a defect.

**Status:** DECIDED 2026-11-08 (VERDICTS-35): neither option; O2's union
stands (VERDICTS-1 Q2); `get_or_init` spells `-> &(T, self)` in v0.2.77
(seed-gated on #1801); v0.2.76 takes `f` by value without `sink`. Filed
2026-11-07 by the G1 lane (`vbd/g1-fnmut-slots`) while rebasing VERDICTS-28
Q1 onto #1804.

## The collision

VERDICTS-28 Q1 makes every non-escaping callback slot in std
`f : &mut Impl(FnMut(...))`, call-once included, `OnceCell.get_or_init` by
name. #1804 made `get_or_init` return `&T` into the cell (Rust's
`OnceLock::get_or_init`), and in the same change took `f` **by value**
(`f : Impl(Fn() -> T)`), not by reference. That was deliberate: an elided
result origin is the union of every reference parameter's origin
(`plans/backlog/REFERENCES_AND_ORIGINS.md` O2), so with `f` a reference
parameter the result also borrows the closure, and

```yo
{ OnceCell } :: import("std/sync/once");
main :: (fn() -> unit)({
  cell := OnceCell(i32).new();
  got := cell.get_or_init(() => i32(42)); // borrows the temporary closure
});
export(main);
```

is rejected at the binding: "the projection's result is a place inside
`() => i32(42)`, which is a temporary that ends with this statement". All 19
tests of `tests/sync/once.test.yo` and the `once-reentrant-call-panics`
cli-case fixture bind the result this way.

The G1 branch keeps both decisions by spelling `get_or_init`'s slot
`sink(f) : Impl(FnMut() -> T)`: Q1's `FnMut` trait, #1804's by-value
parameter, so the receiver stays the only origin. (As decided: the slot is
`f : Impl(FnMut() -> T)` without `sink` for v0.2.76 — a closure argument
always moves, so `sink` there marks nothing.) It is the one non-escaping
callback slot in std that is not `&mut Impl(FnMut(...))`.

## What each slot admits (measured 2026-11-07)

Probes against a develop-tip f89a24b0d evaluator, once with develop's std
(`f : Impl(Fn() -> T)`, #1804) and once with this branch's std
(`sink(f) : Impl(FnMut() -> T)`), give the same verdict on every row, so the
carve-out does not narrow what develop accepts:

| Initializer at `got := cell.get_or_init(...)` | by value (both stds) | `&mut Impl(FnMut)` (Q1's uniform slot) |
| --- | --- | --- |
| capture-free literal | accepted | rejected: `got` borrows the temporary closure |
| implicit capture of a `Copy` local | accepted (the closure owns a copy) | rejected, same reason |
| implicit capture of a move-only local used again | E0901 (owning move) | rejected, same reason |
| `{ &k }` or `{ &mut n }` capture, inline or named | E0909 (second-class into a by-value slot) | accepted when the closure is a named `mut(g)` passed `&mut g` |

A plain by-value `f : Impl(FnMut() -> T)` (no `sink`) gives the same verdicts
as `sink(f)` in the same probes.

## The spelled form, measured (VERDICTS-35, 2026-11-08)

`get_or_init : (fn(self : &Self, f : &mut Impl(FnMut() -> T)) -> &(T, self))`
with the body `self._init(f); match(&self._cell.*._value, .Some(v) => &v, …)`,
checked against a scratch std:

| Shape at `got := cell.get_or_init(...)` | seed v0.2.75 | g1 tree `213c7b008` | O-2 `c7a2f2da9` |
| --- | --- | --- | --- |
| capture-free temporary literal, result bound, a second call bound beside it | E0912 **in the callee body** | accepted | accepted |
| implicit capture of a `Copy` local (`k` usable after) | " | accepted | accepted |
| move-only payload (`String`), two results bound and compared | " | accepted | accepted |
| struct payload | " | accepted | accepted |
| the cli fixture: a nested `cell.get_or_init` inside the initializer | " | accepted | accepted |
| named borrowing initializer `({ &k, &mut n }() => …)` bound `mut(g)`, passed `&mut g`, `got` read after | " | accepted | (not run) |
| NEG `(fn(self : &Self, other : &i32) -> &(i32, self))(&other.*)` | E0923 | E0923 | (not run) |
| POS `-> &(i32, self)` with an `f : &mut Impl(FnMut() -> i32)` slot, called with a `{ &mut hits }` literal, `hits` written after | accepted | accepted | (not run) |

The seed's E0912 is raised at `.Some(v) => &v` (its spelled-origin root walk
predates #1801, which follows a `&` match's binding into its scrutinee); the
same body checks clean under the elided `-> &T`. Three seed-acceptable bodies
were tried and failed: a helper projection `_stored(self) -> &T` holding the
match (the seed follows the call and raises the same E0912; the tree gives
E0901 on a move-only payload), `self.get().unwrap()` and
`match(self.get(), .Some(v) => v, …)` (both E0601 on the seed, which lacks
N1e-2b's reference reads of an `Option(&T)` payload).

## The question

Rust resolves the same signature without a by-value slot. Its third elision
rule: when one input is `&self` or `&mut self`, the elided output lifetime is
the receiver's, whatever other reference parameters exist. Yo's O2 takes the
union instead (the conservative R3-era default), which is exact for free
functions (`longest(a, b)`) but over-approximates every method whose other
reference parameters are inputs only — a callback, a key, a probe.

Two ways to go:

1. Keep the union and keep the by-value carve-out wherever a method returns
   a reference and takes a callback (today only `get_or_init`).
2. Adopt Rust's receiver rule for methods: a `self : &Self` / `&mut Self`
   receiver's origin is the elided result origin; the union stays for free
   functions. A method that does return a borrow of another parameter then
   spells its origin (O2's "the load-bearing ones spell"), which today has
   no surface syntax.

*Corrections (2026-11-08, VERDICTS-35).* (i) "which today has no surface
syntax" is false: N1b landed the spelled result origin `-> &(T, xs)` /
`-> &(T, self)` (`.github/instructions/yo-syntax.instructions.md`, N1b;
pinned at `tests/borrow_spelling.test.yo:589`), and VERDICTS-1 Q2 names
`-> &(V, self)` as the release for exactly this false positive. (ii) Option
2, Rust's receiver rule, was already rejected as the end state by VERDICTS-1
Q2, which this doc did not cite.

## Recommendation

Neither option. The elided result origin stays O2's union (VERDICTS-1 Q2,
binding). A method that returns a reference and takes a callback spells its
result origin — `get_or_init : (fn(self : &Self, f : &mut Impl(FnMut() -> T))
-> &(T, self))` — which is Q1's uniform slot with the receiver as the only
origin by declaration, checked against the body (a result rooted at `f` or
any other parameter is E0923 in the callee). Measured on post-#1801
binaries: every `tests/sync/once.test.yo` call shape and the
`once-reentrant-call-panics` fixture are accepted unchanged, a named
borrowing initializer passed `&mut g` is accepted and released after the
call. The v0.2.75 seed rejects the BODY under the spelled check (E0912 on
the `&`-match binding; #1801 is not in the seed), so the switch is
Generation B on the v0.2.76 seed, v0.2.77, parked in
`plans/backlog/SEED_VERSION_AUTOMATION.md`. For v0.2.76 `get_or_init` takes
its initializer by value, `f : Impl(FnMut() -> T)` (no `sink`: a closure
argument always moves, and `sink` is scheduled for deletion), which keeps
the receiver the only elided origin. No reference-returning std method takes
a callback by value for this reason again: it spells.
