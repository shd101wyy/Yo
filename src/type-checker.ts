// Types

type TUnit = {
  type: "Unit";
};

type TBoolean = {
  type: "boolean";
};

type TChar = {
  type: "char";
};

type TString = {
  type: "string";
};

type TU1 = {
  type: "u1";
};

type TI1 = {
  type: "i1";
};

type TU8 = {
  type: "u8";
};

type TI8 = {
  type: "i8";
};

type TU16 = {
  type: "u16";
};

type TI16 = {
  type: "i16";
};

type TU32 = {
  type: "u32";
};

type TI32 = {
  type: "i32";
};

type TU64 = {
  type: "u64";
};

type TI64 = {
  type: "i64";
};

type TU128 = {
  type: "u128";
};

type TI128 = {
  type: "i128";
};

type TF16 = {
  type: "f16";
};

type TF32 = {
  type: "f32";
};

type TF64 = {
  type: "f64";
};

type TRecord = {
  type: "Record";
  properties: { name: string; type: Type }[];
};

export type Type =
  | TUnit
  | TBoolean
  | TString
  | TChar
  | TU1
  | TU8
  | TU16
  | TU32
  | TU64
  | TU128
  | TI1
  | TI8
  | TI16
  | TI32
  | TI64
  | TI128
  | TF16
  | TF32
  | TF64
  | TRecord;

// Type constructors

export const TypeValues = {
  unit: { type: "Unit" } as TUnit,
  boolean: { type: "boolean" } as TBoolean,
  string: { type: "string" } as TString,
  char: { type: "char" } as TChar,
  u1: { type: "u1" } as TU1,
  u8: { type: "u8" } as TU8,
  u16: { type: "u16" } as TU16,
  u32: { type: "u32" } as TU32,
  u64: { type: "u64" } as TU64,
  u128: { type: "u128" } as TU128,
  i1: { type: "i1" } as TI1,
  i8: { type: "i8" } as TI8,
  i16: { type: "i16" } as TI16,
  i32: { type: "i32" } as TI32,
  i64: { type: "i64" } as TI64,
  i128: { type: "i128" } as TI128,
  f16: { type: "f16" } as TF16,
  f32: { type: "f32" } as TF32,
  f64: { type: "f64" } as TF64,
};

export function synthesizeType(typeValue: string): Type {
  switch (typeValue) {
    case "Unit":
      return TypeValues.unit;
    case "boolean":
      return TypeValues.boolean;
    case "string":
      return TypeValues.string;
    case "char":
      return TypeValues.char;
    case "u1":
      return TypeValues.u1;
    case "u8":
      return TypeValues.u8;
    case "u16":
      return TypeValues.u16;
    case "u32":
      return TypeValues.u32;
    case "u64":
      return TypeValues.u64;
    case "u128":
      return TypeValues.u128;
    case "i1":
      return TypeValues.i1;
    case "i8":
      return TypeValues.i8;
    case "i16":
      return TypeValues.i16;
    case "i32":
      return TypeValues.i32;
    case "i64":
      return TypeValues.i64;
    case "i128":
      return TypeValues.i128;
    case "f16":
      return TypeValues.f16;
    case "f32":
      return TypeValues.f32;
    case "f64":
      return TypeValues.f64;
    default:
      throw new Error(`Unknown type ${typeValue}`);
  }
}

/**
 * For example,
 * {
 *   upperLeft: { label: string, x: number, y: number },
 *   lowerRight: { label: string, x: number, y: number },
 * }
 * is subtype of
 * {
 *   upperLeft: { x: number, y: number },
 *   lowerRight: { x: number, y: number },
 * }
 * @param a
 * @param b
 * @returns
 */
export function isSubtype(a: Type, b: Type): boolean {
  if (a.type === "Record" && b.type === "Record") {
    return b.properties.every(({ name: bName, type: bType }) => {
      if (bName in a.properties) {
        const aType = a.properties[bName];
        return isSubtype(aType, bType);
      } else {
        return false;
      }
    });
  } else {
    return a.type === b.type;
  }
}
