# Inherent method does not shadow a same-name trait method (inherent-first violation)

**Status:** ✅ FIXED on BOTH compilers (TS 2026-06-22, yo-self 2026-06-23).

TS (`src/env.ts` `getReceiverMethodsByNameFromEnv`): impl'd-trait methods are collected
**only when no direct/inherent method of the name exists** (both the `receiverType` and
`dereferencedReceiverType` blocks). The acceptance test
`tests/inherent_first_resolution.test.yo` is **GREEN** (the resolution error is reported:
`f.m(true)` → "Cannot unify i32/bool"; `s.starts_with(i32(5))` → where-bound error);
`check ./std` 152/152; full `./yo-cli test` 2606/2606; corpus 83/83.

yo-self (commit `2a7cdee3f`): `impl.yo` tags trait-impl methods (`impl(T, Trait(...))`,
`current_trait_ty` Some) with their trait id as `source_trait_id` (was `""` — they were
indistinguishable from inherent methods); `env.yo`
`get_receiver_methods_by_name_from_env` drops trait-sourced candidates when an inherent
(`source_trait_id == ""`) candidate for the name exists. Validated: `check ./std`
152/152, corpus 83/83, and the `Foo.m` repro no longer dispatches to the trait
(`f.m(true)` resolves to the inherent and is rejected — yo-self emits a "Failed to
transpile" marker where TS reports a clean error, a pre-existing def-eval-wall
error-reporting limitation, not a resolution difference).

The §4 std cluster migration (the six String pattern methods → generic over `Pattern`)
is also done + validated on both compilers.

## The bug

When a type has an **inherent** method `m` _and_ implements a trait with a same-name
method `m`, a call `x.m(arg)` whose `arg` matches **only** the trait method silently
resolves to the **trait** method instead of erroring on the inherent. This violates
**inherent-first** resolution — a type (inherent) method must _shadow_ a same-name
trait method (Rust's rule); resolution must pick the inherent, type-check the args
against it, and **error** on mismatch (no fall-through to the trait).

This is the same bug under `some_string.starts_with("str")`: it resolves to the
`StrPattern` `str` overload instead of erroring on the inherent
`String.starts_with(prefix : String)`. The root is Yo's arg-type _overload resolution_
(`function.ts:1691` / yo-self `_select_matching_overload`) treating inherent + trait as
equal candidates.

## Isolated repro (`src/tests/fixme.yo`)

```rust
Foo :: newtype(n : i32);
Bar :: trait(m : (fn(self : Self, x : bool) -> i32));
impl(Foo, m : (fn(self : Self, x : i32) -> i32)(x));                 // inherent  m(i32)
impl(Foo, Bar(m : (fn(self : Self, x : bool) -> i32)(cond(x => i32(1), true => i32(0)))));  // trait m(bool)

main :: (fn() -> unit)({
  f := Foo(n : i32(1));
  r := f.m(true);   // bool arg matches ONLY the trait
  ()
});
```

## Current behavior (TS reference compiler, 2026-06-22)

`node out/cjs/yo-cli.cjs compile src/tests/fixme.yo --emit-c --skip-c-compiler` →
**EXIT 0, no error.** Emitted C: `f.m(true)` calls `fn_…_48_m(self, bool x)` — the
**trait** method; the inherent `m(i32)` (`fn_…_39_m`) is silently bypassed. yo-self
mirrors this (both compilers share the overload-resolution path). It **should be a
type error.**

## Required behavior

`f.m(true)` must be a **compile error**: the inherent `m(i32)` is selected
(inherent-first), `bool` ≠ `i32`, and resolution must **not** fall through to `Bar::m`.
To call the trait method, use the existing UFCS form `(Foo <: Bar).m(f, true)`. The
error must be clear (see `OVERLOADING_REDESIGN.md` §6): name the offending arg type,
the selected inherent method's signature, and the UFCS escape hatch.

## Test — promote to `tests/` when the fix lands (currently verified-failing)

```rust
test("inherent method shadows a same-name trait method (inherent-first)", {
  // `f.m(true)` must error: inherent `m(i32)` is selected and `bool` != `i32`.
  // It must NOT silently resolve to Bar::m(bool).
  comptime_expect_error({
    f := Foo(n : i32(1));
    f.m(true)
  });
});
```

Per AGENTS.md (test-first), this is **red now** — `comptime_expect_error` fails because
no error is raised (the call silently resolves to the trait). It goes **green** once
inherent-first resolution is implemented, at which point it moves to `tests/`. It is
kept here (not in the live suite) until then so CI stays green.

## Fix (the redesign — these steps are coupled)

1. **Inherent-first resolution** (both compilers): if an inherent method exists for the
   name, resolve to it _exclusively_; type-check args against it; **error** on mismatch
   (no trait fall-through). Mirrors Rust. Remove the arg-type overload-resolution
   machinery (`_select_matching_overload` / the `functionsToCall` filter).
2. **Coupled prerequisite:** inherent-first makes _every_ existing inherent+trait
   same-name conflict error — including std's `StrPattern` cluster
   (`starts_with`/`contains`/`ends_with`/`index_of`/`last_index_of`/`split`). So those
   must FIRST be migrated to **§4** (one generic method over a `Pattern`-style trait —
   no inherent-vs-trait conflict, so `s.starts_with("lit")` keeps working via `P=str`).
   Otherwise std breaks. **Audit** for any other inherent+trait conflicts first
   (`OVERLOADING_REDESIGN.md` Phase 1).
3. **Clear error message** per `OVERLOADING_REDESIGN.md` §6.
4. **Validate:** differential corpus 83/83, `check ./std`, full `./yo-cli test`, and the
   self-host fixpoint — on both compilers.

## References

- `plans/backlog/OVERLOADING_REDESIGN.md` — the redesign (§4 generic method, §6 clear errors,
  Phase 1 audit, Phase 5 remove overload resolution).
- `issues/yo-self-p1-transpile-tail.md` — the `starts_with` instance + the codegen
  first-hit dispatch fix.
