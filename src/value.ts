import { Expr } from "./expr";
import {
  ArrayType,
  FunctionType,
  StructType,
  TupleType,
  Type,
  TypeTag,
  typeToString,
} from "./type-checker";

export type TypeValue = {
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
};

export type NumberValue = {
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
};

export type UnitValue = {
  tag: TypeTag.Unit;
  type: Type;
};

export type BooleanValue = {
  tag: TypeTag.Boolean;
  type: Type;
  value: boolean;
};

export type CharValue = {
  tag: TypeTag.Char;
  type: Type;
  value: string;
};

export type ArrayValue = {
  tag: TypeTag.Array;
  type: ArrayType;
  value: Value[];
};

export type TupleValue = {
  tag: TypeTag.Tuple;
  type: TupleType;
  elements: Value[];
};

export type StructValue = {
  tag: TypeTag.Struct;
  type: StructType;
  members: Value[];
};

export type FunctionValue = {
  tag: TypeTag.Function;
  type: FunctionType;
  frameLevel: number;
  body: Expr;
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
  | FunctionValue;
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
      if (value.elements.length === 0) {
        return "()";
      }
      return `(${value.elements.map(valueToString).join(", ")})`;
    }
    case TypeTag.Struct: {
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

export function isTypeValue(value: Value): value is TypeValue {
  return value.tag === TypeTag.Type;
}
