# A `unit` operand renders as the empty string, so `_binop` reports "Failed to transpile"

**Status: FIXED** (2026-09-09) — `src/codegen/exprs/generation.yo`,
`_is_primitive_infix_operator` now excludes `unit`.

## Symptom

Any runtime comparison of two `unit` values fails to transpile. Standalone it
is a fatal ICE; inside a derived `==` it is an `abort()`-ing stub.

```rust
main :: (fn() -> unit)({
  a := ();
  b := ();
  r := (a == b);
  cond(r => (), true => ());
});
export(main);
```

```
yo: error: internal compiler error: Failed to transpile part of main's body —
the emitted C for "__yo_user_main" contains an untranspiled expression, so the
program would run without it
```

The emitted C, seen through a `unit`-returning helper (the entry-point gate is
fatal only for `__yo_user_main`):

```c
static inline void yo_id_4199(uint8_t a, uint8_t b) {
  bool _file____priv_temp_4073 = // Failed to transpile () == ();
  bool r = _file____priv_temp_4073;
```

## The sharper case: `derive(Eq)` over a struct with a `unit` field

```rust
S :: struct(u : unit, n : i32);
derive(S, Eq(S));
main :: (fn() -> unit)({
  a := S(u : (), n : i32(1));
  b := S(u : (), n : i32(1));
  r := (a == b);
  cond(r => (), true => ());
});
export(main);
```

The derived `==` body contains the marker, so the whole function is rewritten
to a stub. At `--optimize 2` the binary links and then dies:

```
yo: FATAL: reached fn_yo_id_4225, whose body failed to transpile — its
definition-time evaluation failed and was swallowed.
```

At `-O0` it does not even link — the GNU `error` attribute on the stub fires:

```
error: call to 'fn_yo_id_4225' declared with 'error' attribute: yo: the body of
fn_yo_id_4225 failed to transpile
```

This is exactly the case `std/prelude.yo`'s comment above `impl(unit, Eq(unit))`
claims to serve — *"Without these, `derive(Eq)` (or Ord/Hash/Clone) over a
struct with a `unit` field fails: the generated `lhs.u == rhs.u` has no `Eq` to
resolve to."* The impls make the EVALUATOR happy; codegen then dropped the call
on the floor. The mechanism was exported but never usable.

## Root cause

`unit` is a true zero-sized type (`issues/fixed/unit-should-be-a-true-zero-sized-type-like-rust.md`),
so a `unit`-typed expression has **no C representation in expression position**
and renders as the empty string.

`_is_primitive_infix_operator` (`src/codegen/exprs/generation.yo`) routes
`x op y` to the builtin-inline path whenever the LHS is a *primitive* type, and
`is_primitive_type` answers `true` for `.Unit`. The inline path's `_binop`
(`src/codegen/exprs/inline_fns.yo:73`) then guards:

```rust
if((lhs.len() == usize(0)) || (rhs.len() == usize(0)) || ...) {
  return(`// Failed to transpile (${lhs}) ${op} (${rhs})`);
});
```

That guard is correct and deliberate — `(() + ())` is invalid C, and an empty
operand really does mean a dropped `ExprInfo` for every *other* primitive. It
simply cannot distinguish "empty because the operand failed" from "empty
because the operand is a ZST".

## Fix

Exclude `unit` at the routing decision rather than teaching `_binop` about
types it cannot see:

```rust
.Some(lei) => (is_primitive_type(lei.ty) && !is_unit_type(lei.ty)),
```

`unit` has real `Eq(unit)` and `Ord(unit)` impls in the prelude, and the
trait-method path emits a real call to them (a unit argument is passed as a
literal `0` in the one-byte placeholder slot). So `==`, `!=`, `<`, `<=`, `>`
and `>=` on `unit` all start working from the impls that already existed;
nothing else changes, because `unit` was the only primitive whose operands
render empty.

## Tests

`tests/unit_as_value_type.test.yo` — "unit operands compare through the
prelude's Eq/Ord impls" and "derive(Eq)/derive(Ord) over a struct with a unit
field". Both fail on the pre-fix binary (the first as the fatal ICE, the second
as the runtime `FATAL: reached fn_… whose body failed to transpile`).

## Found by

Writing `impl(unit, Default(...))` for the std `Default` sweep
(`plans/STD_API_STABILIZATION.md` §4 Core) and trying to assert
`unit.default() == ()`.
