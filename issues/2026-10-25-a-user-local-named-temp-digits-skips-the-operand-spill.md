# A user local named `*_temp_<digits>` skips the operand spill

**Severity:** S3 — wrong value, no memory error, and only for a local whose name ends in `_temp_`
followed by digits: `sub(x_temp_1, bump(&mut x_temp_1))` computes with the value `bump` wrote (9)
instead of the value `x_temp_1` had when the argument was evaluated (2).

**Status:** open (codegen). Found 2026-10-25 in adversarial review of the operand-sequencing fix.
Pre-existing on develop: the same wrong value was computed by the develop binary of b97be9b48,
which has no spill at all. The fix (`sequence_operand`,
`src/codegen/exprs/other_fn_call.yo`) intended to settle this operand but skips it.

## Reproducer

```yo
{ assert } :: import("std/assert");
sub :: (fn(a : i32, b : i32) -> i32)(a - b);
bump :: (fn(p : &mut i32) -> i32)({
  p = i32(10);
  i32(1)
});
main :: (fn() -> unit)({
  (mut(x_temp_1) : i32) = i32(3);
  r := sub(x_temp_1, bump(&mut x_temp_1));
  assert(r == i32(2), "usertemp_name");
  ()
});
export(main);
```

Built with `--std-path ./std --sanitize address --allocator system`, the assert fails
(`usertemp_name`, rc=134) on BOTH the develop binary (b97be9b48) and the operand-sequencing tree
binary — identical wrong value, so the fix neither caused nor covers it. The emitted C on the fix
binary shows the skip: `bump`'s result temp is a statement (`tmp_bump = bump(&(&__yo_v_x_temp_1))`,
which writes 10), yet the call still reads the local inline:

```c
int32_t __yo_v_x_temp_1 = 3;
int32_t tmp_bump = yo_id_…((int32_t*)((&(__yo_v_x_temp_1))));       // writes x_temp_1 = 10
int32_t tmp_sub  = yo_id_…((int32_t)(__yo_v_x_temp_1), (int32_t)(tmp_bump));   // reads 10
```

## Root cause

`_operand_code_is_settled` (`src/codegen/exprs/other_fn_call.yo`) classifies an operand as "a temp
the operand's own generation declared" by NAME SHAPE:

```yo
_is_c_identifier(code) && (_looks_like_minted_temp(code) || is_any_temp_variable_name(code) || …)
```

The compiler's minted temps are `<module>_temp_<digits>` (`_file____home_temp_188653`), and a user
local `x_temp_1` sanitizes to `__yo_v_x_temp_1` — the same `_temp_<digits>` suffix. Both
`_looks_like_minted_temp` (`src/codegen/exprs/drop_dup.yo`; its digits-only suffix deliberately
keeps names like `await_future_temp_var_aliases` out, but cannot keep `_temp_<digits>` out) and
`is_any_temp_variable_name` (`src/utils.yo`; `_` + 0..=12 prefix bytes + `_temp_` + digits) match
it, so the operand is treated as settled and `sequence_operand` returns the code unchanged. The
name of a binding is not evidence of who declared it: the two spellings are textually
indistinguishable by design of the temp naming.

## Recommended fix (not in this cycle)

Classify an operand as the compiler's own temp by membership in the set of names codegen itself
minted — `context.declared_temp_vars` (a `HashSet(String)` filled by `record_declared_temp_var`,
`src/codegen/functions/context.yo`, already imported by `other_fn_call.yo`) — not by name shape.
Rides with the next codegen PR touching `sequence_operand`; until then every operand whose local
name ends in `_temp_<digits>` keeps develop's ordering. No fix landed here (pre-existing, S3, the
coordinator chose to file-only).
