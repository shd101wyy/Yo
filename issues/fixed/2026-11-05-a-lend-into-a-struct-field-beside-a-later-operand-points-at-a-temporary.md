# A lend into a struct field beside a later operand is taken of a temporary

**Severity:** S2: a struct constructor that lends a place to a reference
field (decision 43 step 3, T9) emits C that does not compile when a later
argument mentions the same root. The place's value is hoisted into a
temporary, and the field then takes that temporary's address.

> Found 2026-11-05 with the `derive(Clone)` fix for reference fields
> (`Self(self.r, self.n.clone())`), on develop 1df834f26.

## Reproducer

```yo
_Two :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p), n : i32));
_bump :: (fn(n : i32) -> i32)(n + i32(1));
_two :: (fn(x : &i32) -> _Two(x))(_Two(x)(r : x, n : _bump(x.*)));
```

The emitted C, compiled by clang:

```text
int32_t const * __yo_seq_0 = (*__yo_v_x);                 // int into a pointer
... .__yo_v_r = (&(__yo_seq_0)) ...                        // a pointer to the temporary
```

## Root cause

`other_fn_call.yo`'s value-struct constructor sequenced the argument first
(`sequence_operand` hoists it when a later operand mentions its root). Only
then did it take the address of the recorded lend (`_lend_field_addr`), so
the address was of the hoisted copy.

## Fix

The lend's address is taken first and passed to `sequence_operand` as a
pointer operand (`_is_recorded_lend`), which is never hoisted. The variant
payload path got the same order in #1771's fix-forward. Test:
`tests/origin_holder_derive.test.yo` ("a lend beside a later operand").
