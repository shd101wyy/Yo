# A reference payload built from a `&T` parameter emits invalid C

**Severity:** S2: a function that returns an origin-carrying value built
from its own `&T` parameter passes `yo check` but does not compile. For
example, `pick(r : &Sq) -> Option(&Sq)` with body `.Some(r)`. Its emitted C
stores the parameter's struct copy into the payload's `const Sq*` field.
Had the C compiled, the reference would have pointed at a copy that dies
with the call.

> Found 2026-11-05 while building the borrowed `Error.source` walk
> (decision 43 step 3, N2b's values). N2b's tests build a reference payload
> only from a lend in the caller's own frame (`V(r : &x)`) or as `.None`.
> The corpus checks with `yo check` alone, so nothing compiled this shape.

## Reproducer

```yo
Sq :: struct(s : i32, t : i64);
pick :: (fn(r : &Sq) -> Option(&Sq))(.Some(r));
main :: (fn() -> unit)({
  q := Sq(s : i32(4), t : i64(2));
  _ := pick(&q);
  ()
});
export(main);
```

The emitted C, with `--emit-c-to`:

```c
static inline __yo_t_Opt pick(__yo_t_Sq __yo_v_r) {
  ... = (__yo_t_Opt){ .tag = ..._SOME, .data = { .__yo_v_Some = { .__yo_v_value = __yo_v_r } } };
```

`__yo_v_value` is a `__yo_t_Sq const *`.

## Root cause

Decision 34's ABI passes a `&T` parameter by value, except for a projection
(`-> &T`), whose result may point into it (`fn_param_is_ptr_borrow`). N2b made
a second kind of result point into a parameter, an origin-carrying type
(`Option(&T)`, a holder struct), but left the ABI rule keyed on the borrow
result slot alone.

## Fix

`fn_param_is_ptr_borrow` (`src/types/utils.yo`) passes a `&T` parameter as a
pointer when the result is a borrow OR its type carries an origin
(`type_carries_origin`). The parameter binders, the prototypes, the call
sites and the `Dyn` vtables already read that one predicate. A function
whose result carries no origin keeps its by-value ABI, so the emitted C of
std and `src/` is unchanged. Test: `tests/ref_payload_binding.test.yo`
(`_pick`, `_first`, `_Wrap.source`).
