/**
 * Type tags to identify different kinds of types
 */
export enum TypeTag {
  // Primitive types
  Unit = "unit",
  Boolean = "boolean",
  /// Char = "char",
  Usize = "usize",
  Isize = "isize",
  U8 = "u8",
  I8 = "i8",
  U16 = "u16",
  I16 = "i16",
  U32 = "u32",
  I32 = "i32",
  U64 = "u64",
  I64 = "i64",
  F32 = "f32",
  F64 = "f64",

  // Compt types
  ComptInt = "compt_int",
  ComptFloat = "compt_float",
  ComptString = "compt_string",

  // C Compatible types
  // NOTE: C Compatible types cannot be used for compile-time known value.
  //       They can only used for runtime, as their size and representation
  //       may vary depending on the platform.
  CChar = "c_char",
  CShort = "c_short",
  CUShort = "c_ushort",
  CInt = "c_int",
  CUInt = "c_uint",
  CLong = "c_long",
  CULong = "c_ulong",
  CLongLong = "c_longlong",
  CULongLong = "c_ulonglong",
  CLongDouble = "c_longdouble",

  // Add Undefined type
  // Undefined = "Undefined",

  // Type universes
  Free = "Free",
  Linear = "Linear",
  Type = "Type",

  // Complex types
  // Variant = "Variant",
  Array = "Array",
  Tuple = "Tuple",
  Struct = "Struct",
  Enum = "Enum",
  Union = "Union",
  Function = "Function",

  // Some Type
  SomeType = "SomeType",

  // Slice (Fat Pointer)
  Slice = "Slice",

  // Value
  // Literal = "Literal",

  // Module
  Module = "Module",

  // Pointer & Reference
  MutPtr = "MutPtr",
  Ptr = "Ptr",
  MutRef = "MutRef",
  Ref = "Ref",

  // Expr (for macro/metaprogramming)
  Expr = "Expr",
  ExprList = "ExprList",
}
