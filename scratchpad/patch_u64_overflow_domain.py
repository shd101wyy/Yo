#!/usr/bin/env python3
"""Fix the u64/usize FALSE POSITIVE in `check_int_overflow`.

`u64(9223372036854775807) + u64(1000)` is a valid u64 result but wraps in the
SIGNED i64 domain yo-self carries comptime integers in, so the signed wrap test
reported an overflow where TS (BigInt) accepts the value. Redo the whole test in
the UNSIGNED domain for 64-bit unsigned types, whose i64 is a bit pattern.

Anchored on unique context; run once from the repo root.
"""
import sys

P = 'yo-self/evaluator/builtins/comptime_numeric_fns.yo'
s = open(P).read()

OLD_IMPORT = '{ IntRange, get_integer_type_range } :: import("../../types/utils.yo");'
NEW_IMPORT = '{ IntRange, get_integer_type_range, get_integer_type_bits } :: import("../../types/utils.yo");'
if OLD_IMPORT not in s or s.count(OLD_IMPORT) != 1:
    print('IMPORT ANCHOR missing/ambiguous', file=sys.stderr)
    sys.exit(1)
s = s.replace(OLD_IMPORT, NEW_IMPORT)

OLD = """  out_of_range := cond(
    _i64_op_wrapped(a, b, op_s.clone()) => true,
    (value < rng.min) => true,
    (value >= i64(0)) => (u64(value) > rng.max),
    true => false
  );"""
NEW = """  // u64 / usize: yo-self carries comptime integers as i64, so every value above
  // i64::MAX is a NEGATIVE i64 BIT PATTERN (`usize.MAX`, hash constants). Both
  // signed tests below are meaningless there — `u64(9223372036854775807) +
  // u64(1000)` is a valid u64 result that signed-wraps, and `usize.MAX` reads
  // as `-1 < min` — so redo the test in the UNSIGNED domain on the patterns.
  // TS needs no such split: its comptime integers are BigInt, so
  // `checkOverflow` compares exact values (comptime-numeric-fns.ts:131).
  is_unsigned_64 := is_unsigned_integer_type(ty) &&
    match(get_integer_type_bits(ty),.Some(bw) => (bw == u32(64)),.None => false);
  if(is_unsigned_64, {
    ua := u64(a);
    ub := u64(b);
    uv := u64(value);
    u_over := cond(
      (op_s == "add") => (uv < ua),
      (op_s == "sub") => (ua < ub),
      (ua == u64(0)) => false,
      true => ((uv / ua) != ub)
    );
    if(u_over, {
      u_symbol := cond(
        (op_s == "mul") => String.from("*"),
        (op_s == "add") => String.from("+"),
        true => String.from("-")
      );
      exn.throw(
        dyn(
          format_error_message(
            token,
            `Integer overflow in compile-time evaluation
  ${ua.to_string()} ${u_symbol} ${ub.to_string()} = ${uv.to_string()}
  Result ${uv.to_string()} exceeds ${type_to_string(ty)} range [0, ${rng.max.to_string()}]`,
            false,
            Option(ErrorKind).Some(ErrorKind.Overflow)
          )
        )
      );
    });
    return(());
  });
  out_of_range := cond(
    _i64_op_wrapped(a, b, op_s.clone()) => true,
    (value < rng.min) => true,
    (value >= i64(0)) => (u64(value) > rng.max),
    true => false
  );"""
if OLD not in s or s.count(OLD) != 1:
    print('BODY ANCHOR missing/ambiguous', file=sys.stderr)
    sys.exit(1)
s = s.replace(OLD, NEW)

open(P, 'w').write(s)
print('patched', P)
