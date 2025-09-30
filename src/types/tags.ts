/**
 * Type tags to identify different kinds of types
 */
export enum TypeTag {
  // Primitive types
  Unit = "unit",
  Boolean = "boolean",
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
  // Rune = "rune", // 4 bytes, u32, // Unicode code point
  // Rune :: u32;

  // Compt types
  ComptInt = "compt_int",
  ComptFloat = "compt_float",
  ComptString = "compt_string",

  // C Compatible types
  // NOTE: C Compatible types cannot be used for compile-time known value.
  //       They can only used for runtime, as their size and representation
  //       may vary depending on the platform.
  Char = "char",
  Short = "short",
  UShort = "ushort",
  Int = "int",
  UInt = "uint",
  Long = "long",
  ULong = "ulong",
  LongLong = "longlong",
  ULongLong = "ulonglong",
  LongDouble = "longdouble",

  // For opaque type
  Void = "void",

  // Add Undefined type
  // Undefined = "Undefined",

  // Type universes
  Type = "Type",

  // Complex types
  // Variant = "Variant",
  Array = "Array",
  Tuple = "Tuple",
  Struct = "Struct",
  Enum = "Enum",
  Union = "Union",
  Function = "Function",
  Closure = "Closure",

  // Some Type
  SomeType = "SomeType",

  // Slice (Fat Pointer)
  Slice = "Slice",

  // Value
  // Literal = "Literal",

  // Module
  Module = "Module",

  // Pointer
  MutPtr = "MutPtr",

  // Dynamic Dispatch Type
  Dyn = "Dyn",

  // Expr (for macro/metaprogramming)
  Expr = "Expr",
  ExprList = "ExprList",

  // Concurrency
  Thread = "Thread",
}
