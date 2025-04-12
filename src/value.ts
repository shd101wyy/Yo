import { Expr } from "./expr";
import {
  ArrayType,
  EnumType,
  FunctionType,
  RecordType,
  StructType,
  TupleType,
  Type,
  TypeTag,
  UnionType,
  typeToString,
} from "./type-checker";

export type Value =
  | {
      /**
       * This is for value such as
       *    MyI32 := i32
       *
       * i32 is the value, where:
       *    .type = Free
       *    .value = i32
       */
      tag: TypeTag.Type;
      /**
       * Type of the .value
       */
      type: Type;

      /**
       * Such as TFree, TLinear, TType, TI32, TBoolean, TStruct, etc.
       */
      value: Type;
    }
  | {
      tag:
        | TypeTag.U8
        | TypeTag.I8
        | TypeTag.U16
        | TypeTag.I16
        | TypeTag.U32
        | TypeTag.I32
        | TypeTag.U64
        | TypeTag.I64
        | TypeTag.F16
        | TypeTag.F32
        | TypeTag.F64;
      type: Type;
      value: number;
    }
  | {
      tag: TypeTag.Unit;
      type: Type;
    }
  | {
      tag: TypeTag.Boolean;
      type: Type;
      value: boolean;
    }
  | {
      tag: TypeTag.Char;
      type: Type;
      value: string;
    }
  | {
      tag: TypeTag.Array;
      type: ArrayType;
      value: Value[];
    }
  | {
      tag: TypeTag.Tuple;
      type: TupleType;
      value: Value[];
    }
  | {
      tag: TypeTag.Record;
      type: RecordType;
      value: Record<string, Value>;
    }
  | {
      tag: TypeTag.Struct;
      type: StructType;
      value: Value;
    }
  | {
      tag: TypeTag.Enum;
      type: EnumType;
      value: Value;
    }
  | {
      tag: TypeTag.Union;
      type: UnionType;
      value: Record<string, Value>;
    }
  | {
      tag: TypeTag.Function;
      type: FunctionType;
      frameLevel: number;
      body: Expr;
    };
/* | {
      tag: "Interface";
      type: Interface;
      implementations: Record<string, Value>;
    }
      */

/**
 * Convert a Value object to a human-readable string representation
 */
export function valueToString(value: Value): string {
  if (!value) {
    return "undefined";
  }

  switch (value.tag) {
    case TypeTag.Type: {
      return typeToString(value.value);
    }
    case TypeTag.U8:
    case TypeTag.I8:
    case TypeTag.U16:
    case TypeTag.I16:
    case TypeTag.U32:
    case TypeTag.I32:
    case TypeTag.U64:
    case TypeTag.I64:
    case TypeTag.F16:
    case TypeTag.F32:
    case TypeTag.F64: {
      return value.value.toString();
    }
    case TypeTag.Boolean: {
      return value.value.toString();
    }
    case TypeTag.Char: {
      return `'${value.value}'`;
    }
    case TypeTag.Array: {
      return `[${value.value.map(valueToString).join(", ")}]`;
    }
    case TypeTag.Tuple: {
      if (value.value.length === 0) {
        return "()";
      }
      return `(${value.value.map(valueToString).join(", ")})`;
    }
    case TypeTag.Record: {
      const entries = Object.entries(value.value);
      if (entries.length === 0) {
        return "{}";
      }
      return `{ ${entries
        .map(([key, val]) => `${key}: ${valueToString(val)}`)
        .join(", ")} }`;
    }
    case TypeTag.Struct: {
      return valueToString(value.value);
    }
    case TypeTag.Enum: {
      return valueToString(value.value);
    }
    case TypeTag.Union: {
      const entries = Object.entries(value.value);
      if (entries.length === 0) {
        return "{}";
      }
      return `{ ${entries
        .map(([key, val]) => `${key}: ${valueToString(val)}`)
        .join(", ")} }`;
    }
    case TypeTag.Function: {
      return `<function>`;
    }
    case TypeTag.Unit: {
      return `()`;
    }
    default: {
      return `<unknown>`;
    }
  }
}
