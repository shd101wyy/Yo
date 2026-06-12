import { BuiltinFunctions } from "../expr";
import { TypeTag } from "../types/tags";

export const BuiltinYoInlineFunctions = [
  // Arithemtic
  ...BuiltinFunctions.__yo_op_add, // +
  ...BuiltinFunctions.__yo_op_sub, // -
  ...BuiltinFunctions.__yo_op_mul, // *
  ...BuiltinFunctions.__yo_op_div, // /
  ...BuiltinFunctions.__yo_op_mod, // %
  ...BuiltinFunctions.__yo_op_neg, // -

  // Relational
  ...BuiltinFunctions.__yo_op_eq, // ==
  ...BuiltinFunctions.__yo_op_neq, // !=
  ...BuiltinFunctions.__yo_op_lt, // <
  ...BuiltinFunctions.__yo_op_lte, // <=
  ...BuiltinFunctions.__yo_op_gt, // >
  ...BuiltinFunctions.__yo_op_gte, // >=

  // Logical
  ...BuiltinFunctions.__yo_op_not, // !

  // Bitwise
  ...BuiltinFunctions.__yo_op_bit_and, // &
  ...BuiltinFunctions.__yo_op_bit_or, // |
  ...BuiltinFunctions.__yo_op_bit_xor, // ^
  ...BuiltinFunctions.__yo_op_bit_complement, // ~
  ...BuiltinFunctions.__yo_op_bit_left_shift, // <<
  ...BuiltinFunctions.__yo_op_bit_right_shift, // >>

  // Pointer operations
  ...BuiltinFunctions.__yo_ptr_add, // __yo_ptr_add
  ...BuiltinFunctions.__yo_ptr_sub, // __yo_ptr_sub
  ...BuiltinFunctions.__yo_ptr_diff, // __yo_ptr_diff
  ...BuiltinFunctions.__yo_ptr_eq, // __yo_ptr_eq
  ...BuiltinFunctions.__yo_ptr_neq, // __yo_ptr_neq
  ...BuiltinFunctions.__yo_ptr_lt, // __yo_ptr_lt
  ...BuiltinFunctions.__yo_ptr_lte, // __yo_ptr_lte
  ...BuiltinFunctions.__yo_ptr_gt, // __yo_ptr_gt
  ...BuiltinFunctions.__yo_ptr_gte, // __yo_ptr_gte

  // Slice operations
  ...BuiltinFunctions.__yo_str_from_raw_parts, // __yo_str_from_raw_parts
  ...BuiltinFunctions.__yo_str_len, // __yo_str_len
  ...BuiltinFunctions.__yo_str_ptr, // __yo_str_ptr
  ...BuiltinFunctions.__yo_str_byte, // __yo_str_byte

  // Type casting
  ...BuiltinFunctions.__yo_as, // __yo_as (generic primitive type cast)

  // Crypto random
  ...BuiltinFunctions.__yo_getrandom,
  ...BuiltinFunctions.__yo_arc4random_buf,
  ...BuiltinFunctions.__yo_bcrypt_gen_random,
  ...BuiltinFunctions.__yo_getentropy,

  // MaybeUninit
  ...BuiltinFunctions.__yo_maybe_uninit_new,
  ...BuiltinFunctions.__yo_maybe_uninit_as_ptr,
  ...BuiltinFunctions.__yo_maybe_uninit_assume_init,

  // Array indexing
  ...BuiltinFunctions.__yo_array_index,

  // Others
  ...BuiltinFunctions.__yo_noop, // __yo_noop
  ...BuiltinFunctions.__yo_return_self, // __yo_return_self
  ...BuiltinFunctions.__yo_borrow_assert_unborrowed, // __yo_borrow_assert_unborrowed
  ...BuiltinFunctions.__yo_ms_sleep, // __yo_ms_sleep
];

export const PrimitiveTypeTags = new Set([
  TypeTag.Bool,
  TypeTag.Usize,
  TypeTag.Isize,
  TypeTag.U8,
  TypeTag.I8,
  TypeTag.U16,
  TypeTag.I16,
  TypeTag.U32,
  TypeTag.I32,
  TypeTag.U64,
  TypeTag.I64,
  TypeTag.F32,
  TypeTag.F64,
  TypeTag.Char,
  TypeTag.Short,
  TypeTag.UShort,
  TypeTag.Int,
  TypeTag.UInt,
  TypeTag.Long,
  TypeTag.ULong,
  TypeTag.LongLong,
  TypeTag.ULongLong,
  TypeTag.LongDouble,
]);
