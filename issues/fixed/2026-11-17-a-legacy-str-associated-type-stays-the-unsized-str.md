# A legacy value `str` at an associated type stays the unsized `str`, so `TryFrom(i32)(Error : str, …)` rejects its own `.Err("…")`

**Severity:** S2 — a valid program was rejected: an impl spelling an associated type as the legacy value `str` could not
return a string literal through it, and `tests/prelude.test.yo` failed to compile on develop `916b279c1` and `b2155b8bf`
(the self-hosted gates and the hollow sweep).

**Status:** FIXED on `fix/develop-v0279-reds`. Introduced by #1980 (decision 49 S2, the `str` flip).

## Reproducer

```yo
EvenNumber :: struct(value : i32);
derive(EvenNumber, Copy, Clone);
impl(
  EvenNumber,
  TryFrom(i32)(
    Error : str,
    try_from : (
      value ->
        cond(
          ((value.* % 2) == 0) => .Ok(EvenNumber(value.*)),
          true => .Err("Only even numbers are allowed (i32)")
        )
    )
  )
);
main :: (fn() -> unit)({
  z := EvenNumber.try_from(i32(3));
  assert(z.is_err());
});
export(main);
```

```text
error[E0601]: Incompatible types for field "error":
- Expected: str
- Given  : &str
```

## Root cause

After the flip `str` is unsized and a value `str` is the legacy alias of `&(str, static)` (`unsized_legacy_spellings`,
plans/VALUES_BY_DEFAULT.md decision 49). The alias is applied at every place a value type is spelled: a binding, a
field, a parameter, a return type, an array element, and a `comptime(V) : Type` binder (`ArrayList(str)`,
`legacy_str_type_arg`). An associated type of an impl (`Error : str` against the trait's `Error : Type`) is evaluated
by the impl's member loop (`src/evaluator/values/impl.yo`), which had no such arm. `Self.Error` stayed the unsized
`str`, so `Result(Self, Self.Error)`'s `Err` payload expected `str` and a literal (`&(str, static)`) did not fit.

Spelling the test `Error : &str` is not a repair: the elided origin ties the error to the `&Source` parameter (E0911
at the caller), and safe code cannot spell `&(str, static)` while P12 is blocked. Rust spells this
`type Error = &'static str;`, which is what the legacy alias means.

## Fix

The impl member loop maps a legacy value `str` given for a `Type`-kinded member (an associated type) to
`legacy_value_str`, as `ArrayList(str)` does, and records the site for `yo fix --migrate unsized`
(`note_legacy_str_spelling`).

## Verification

The reproducer compiles and runs. `tests/prelude.test.yo` (its `TryFrom/TryInto traits` case) failed to compile and
passes with the fix.
