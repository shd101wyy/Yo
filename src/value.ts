import { Expr } from "./expr";
import {
  ArrayType,
  FunctionType,
  StructType,
  TupleType,
  Type,
  typeOfType,
  typeToString,
} from "./type-checker";

export enum ValueTag {
  Type = "Type",
  U8 = "U8",
  I8 = "I8",
  U16 = "U16",
  I16 = "I16",
  U32 = "U32",
  I32 = "I32",
  U64 = "U64",
  I64 = "I64",
  F16 = "F16",
  F32 = "F32",
  F64 = "F64",
  Unit = "Unit",
  Boolean = "Boolean",
  Char = "Char",
  Array = "Array",
  Tuple = "Tuple",
  Struct = "Struct",
  Function = "Function",
  Unknown = "Unknown",
}

export type TypeValue = {
  /**
   * This is for value such as
   *    MyI32 := i32
   *
   * i32 is the value, where:
   *    .type = Free
   *    .value = i32
   */
  tag: ValueTag.Type;
  /**
   * Type of the .value
   */
  type: Type;

  /**
   * Such as TFree, TLinear, TType, TI32, TBoolean, TStruct, etc.
   */
  value: Type;
};

export type NumberValue = {
  tag:
    | ValueTag.U8
    | ValueTag.I8
    | ValueTag.U16
    | ValueTag.I16
    | ValueTag.U32
    | ValueTag.I32
    | ValueTag.U64
    | ValueTag.I64
    | ValueTag.F16
    | ValueTag.F32
    | ValueTag.F64;
  type: Type;
  value: number;
};

export type UnitValue = {
  tag: ValueTag.Unit;
  type: Type;
};

export type BooleanValue = {
  tag: ValueTag.Boolean;
  type: Type;
  value: boolean;
};

export type CharValue = {
  tag: ValueTag.Char;
  type: Type;
  value: string;
};

export type ArrayValue = {
  tag: ValueTag.Array;
  type: ArrayType;
  value: Value[];
};

export type TupleValue = {
  tag: ValueTag.Tuple;
  type: TupleType;
  elements: Value[];
};

export type StructValue = {
  tag: ValueTag.Struct;
  type: StructType;
  members: Value[];
};

export type FunctionValue = {
  tag: ValueTag.Function;
  type: FunctionType;
  frameLevel: number;
  body: Expr;
};

export type UnknownValue = {
  tag: ValueTag.Unknown;
};

export type Value =
  | TypeValue
  | NumberValue
  | UnitValue
  | BooleanValue
  | CharValue
  | ArrayValue
  | TupleValue
  | StructValue
  /*
  | {
      tag: TypeTag.Enum;
      variantName: string;
      type: EnumVariant;
      elements: Value[];
    }
  | {
      tag: TypeTag.Union;
      type: UnionType;
      variantName: string;
      value: Value;
    }
  | */
  | FunctionValue
  | UnknownValue;
/* | {
      tag: "Interface";
      type: Interface;
      implementations: Record<string, Value>;
    }
      */

/**
 * Convert a Value object to a human-readable string representation
 */
export function valueToString(value?: Value): string {
  if (!value) {
    return "<unknown>";
  }

  switch (value.tag) {
    case ValueTag.Type: {
      return typeToString(value.value);
    }
    case ValueTag.U8:
    case ValueTag.I8:
    case ValueTag.U16:
    case ValueTag.I16:
    case ValueTag.U32:
    case ValueTag.I32:
    case ValueTag.U64:
    case ValueTag.I64:
    case ValueTag.F16:
    case ValueTag.F32:
    case ValueTag.F64: {
      return value.value.toString();
    }
    case ValueTag.Boolean: {
      return value.value.toString();
    }
    case ValueTag.Char: {
      return `'${value.value}'`;
    }
    case ValueTag.Array: {
      return `[${value.value.map(valueToString).join(", ")}]`;
    }
    case ValueTag.Tuple: {
      if (value.elements.length === 0) {
        return "()";
      }
      return `(${value.elements.map(valueToString).join(", ")}${
        value.elements.length === 1 ? "," : ""
      })`;
    }
    case ValueTag.Struct: {
      return `_(${value.members
        .map((member) => {
          return `${valueToString(member)}`;
        })
        .join(", ")})`;
    }
    /*
    case TypeTag.Enum: {
      if (value.elements.length === 0) {
        return `.${value.variantName}`;
      }
      return `.${value.variantName}(${value.elements
        .map(valueToString)
        .join(", ")})`;
    }
    case TypeTag.Union: {
      return `${value.variantName}(${valueToString(value.value)})`;
    }
    */
    case ValueTag.Function: {
      return `<function>`;
    }
    case ValueTag.Unit: {
      return `()`;
    }
    case ValueTag.Unknown: {
      return `<unknown>`;
    }
    default: {
      return `<unknown>`;
    }
  }
}

export function isTypeValue(value?: Value): value is TypeValue {
  return value?.tag === ValueTag.Type;
}

export function isFunctionValue(value?: Value): value is FunctionValue {
  return value?.tag === ValueTag.Function;
}

export function isUnknownValue(value?: Value): value is UnknownValue {
  return value?.tag === ValueTag.Unknown;
}

export function isTupleValue(value?: Value): value is TupleValue {
  return value?.tag === ValueTag.Tuple;
}

export function createTypeValue(value: Type): TypeValue {
  return {
    tag: ValueTag.Type,
    type: typeOfType(value),
    value,
  };
}

export const VUnknown: UnknownValue = {
  tag: ValueTag.Unknown,
};
