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
