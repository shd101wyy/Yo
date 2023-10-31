// Types

import { Token } from "./token";

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

export function synthesizeTypeFromTokens(
  tokens: Token[],
  index: number
): { typeValue: Type; index: number } {
  let typeValue: Type;
  switch (tokens[index].value) {
    case "Unit": {
      typeValue = TypeValues.unit;
      break;
    }
    case "boolean": {
      typeValue = TypeValues.boolean;
      break;
    }
    case "string": {
      typeValue = TypeValues.string;
      break;
    }
    case "char": {
      typeValue = TypeValues.char;
      break;
    }
    case "u1": {
      typeValue = TypeValues.u1;
      break;
    }
    case "u8": {
      typeValue = TypeValues.u8;
      break;
    }
    case "u16": {
      typeValue = TypeValues.u16;
      break;
    }
    case "u32": {
      typeValue = TypeValues.u32;
      break;
    }
    case "u64": {
      typeValue = TypeValues.u64;
      break;
    }
    case "u128": {
      typeValue = TypeValues.u128;
      break;
    }
    case "i1": {
      typeValue = TypeValues.i1;
      break;
    }
    case "i8": {
      typeValue = TypeValues.i8;
      break;
    }
    case "i16": {
      typeValue = TypeValues.i16;
      break;
    }
    case "i32": {
      typeValue = TypeValues.i32;
      break;
    }
    case "i64": {
      typeValue = TypeValues.i64;
      break;
    }
    case "i128": {
      typeValue = TypeValues.i128;
      break;
    }
    case "f16": {
      typeValue = TypeValues.f16;
      break;
    }
    case "f32": {
      typeValue = TypeValues.f32;
      break;
    }
    case "f64": {
      typeValue = TypeValues.f64;
      break;
    }
    default: {
      throw new Error(`Unknown type ${tokens[index].value}`);
    }
  }

  return {
    typeValue: typeValue,
    index: index + 1,
  };
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
