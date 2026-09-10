# A unary operator applied to a value of a GENERIC type parameter fails to transpile

**Status:** FIXED 2026-09-11. Verified: the repro compiles and runs clean, `tests/closure_param_unary_operator.test.yo` 11/11, `tests/int_checked_arithmetic.test.yo` 38/38, full suite 4007/0, `FIXPOINT_HOLDS`.
**Found:** 2026-09-10, while collapsing the ten per-type bit batteries in
`std/prelude.yo` onto one `where(T <: Integer)` blanket impl.

## Symptom

`~self` (and `-self`) inside a blanket-impl body whose receiver type is a
GENERIC type parameter compiles to a `// Failed to transpile` marker. The
marker leaves a value-returning C function with no `return`, so
`codegen/functions/generation.yo` rewrites the whole body into an
`__attribute__((error(...)))` abort stub — and every call site then fails the
C compile:

```
error: call to 'yo_id_2188_rtparam0_u8_ret_u32' declared with 'error' attribute:
yo: the body of yo_id_2188_rtparam0_u8_ret_u32 failed to transpile — its
definition-time evaluation failed and was swallowed
```

`yo check` reports **evaluator OK** for the same file: the failure is in
codegen, so nothing catches it before the C compiler does.

## Minimal reproducer

`issues/repros/unary-operator-on-a-generic-parameter.yo`:

```rust
impl(
  generic(T : Type),
  where(T <: Integer),
  T,
  a1 : (fn(self : T) -> T)((T(0) - self)),   // binary  -> fine
  a2 : (fn(self : T) -> T)((~self)),         // unary ~ -> FAILS
  a3 : (fn(self : T) -> bool)((!(self == T(0)))),  // unary ! on a bool -> fine
  a4 : (fn(self : T) -> T)(self.(~)())       // explicit method -> fine
);
```

`yo compile … --emit-c --skip-c-compiler` marks only `a2`'s u8 specialization.
A `where(T <: (Integer, SignedInteger))` blanket with `neg : (fn(self : T) ->
T)((-self))` fails the same way, while `_concrete_neg :: (fn(y : i32) ->
i32)((-y))` beside it is fine.

## Why

`codegen/exprs/generation.yo` has two operator fast paths that lower a
primitive operator straight to the C operator instead of dispatching to the
trait method:

- `_is_primitive_infix_operator` — any binary operator symbol.
- `_is_primitive_unary_operator` — **`!` only.**

For a primitive operand the trait impl's body IS an inline builtin, so there is
no real function for the dispatcher to call; it bails at
`other_fn_call.yo:1612` because `ExprInfo.runtime_arg_exprs_in_order` is
`.None` for the node, and emits the marker. The infix path routes around that
for every binary operator. The unary path was added for `!` alone
(`issues/retired/yo-self-selftest-codegen-divergences.md`), so `~` and unary
`-` still reach the dispatcher and still fail.

Two details explain why nobody hit it earlier:

- On a CONCRETE receiver the same expressions are fine, because the node keeps
  its `runtime_arg_exprs_in_order`. It takes a specialized generic body to
  lose it. Every `~` in `std/` was inside a per-type `impl(u8, …)` block.
- With a NON-primitive operand it is also fine — a struct's `BitNot` impl is a
  real function, so the dispatcher has something to call. Verified with a
  `struct(v : u8)` carrying its own `BitNot` inside a blanket impl.

## Why `~` was not simply mapped to its inline name

`_operator_inline_name` is keyed by the operator SYMBOL alone, and `-` has two
lowerings: it answers `BF_YO_OP_SUB`. An earlier attempt to widen the unary
gate to "any 1-arg operator with an inline name" therefore diverted a prefix
`-y` into the binary lowering and emitted `(y) - ()`, which
`tests/operator_grouping.test.yo` caught. The recorded conclusion was "only
`!` qualifies" — but the actual problem is that the table is not arity-aware.

## Fix

A second, arity-keyed table — `_unary_operator_inline_name` — mapping `!` →
`BF_YO_OP_NOT`, `~` → `BF_YO_OP_BIT_COMPLEMENT`, `-` → `BF_YO_OP_NEG`. All
three lowerings already exist in `codegen/exprs/inline_fns.yo` (`_unop`), and
all three names are already in `codegen/constants.yo`'s inline-builtin list;
only the symbol → name resolution was missing. `_is_primitive_unary_operator`
and `_generate_inline_call` both consult the unary table when the call is
non-infix with exactly one argument, so a prefix `-` can no longer collide
with the binary reading.

## Coverage

`tests/closure_param_unary_operator.test.yo` gains four cases: `~`, unary `-`,
`!` and `count_ones`-style widening through a generic type parameter in a
blanket impl, each with a concrete-receiver twin so a regression is attributed
to genericity rather than to the operator.
