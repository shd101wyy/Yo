import { Environment } from "./env";
import { Expr } from "./expr";
import {
  areTypesCompatible,
  ArrayType,
  FunctionType,
  StructType,
  TUnit,
  TupleType,
  Type,
  typeOfType,
  typeToString,
} from "./type-checker";
import { TypeValue } from "./type-value";
import { ValueTag } from "./value-tag";

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

  /**
   * The function name, if available
   */
  funcName?: string;

  /**
   * The unique identifier of the function
   */
  // TODO: Let's make it mandatory for now
  funcId: string;
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

export const VUnit: UnitValue = {
  tag: ValueTag.Unit,
  type: TUnit,
};

export function areValuesEqual(
  value1: Value | undefined,
  value2: Value | undefined,
  env: Environment
): boolean {
  if (value1 === value2) {
    return true;
  }

  if (!value1 || !value2) {
    return false;
  }

  if (value1.tag !== value2.tag) {
    return false;
  }

  if (value1.tag === ValueTag.Type) {
    return areTypesCompatible(value1.value, (value2 as TypeValue).value, env);
  } else if (
    value1.tag === ValueTag.U8 ||
    value1.tag === ValueTag.I8 ||
    value1.tag === ValueTag.U16 ||
    value1.tag === ValueTag.I16 ||
    value1.tag === ValueTag.U32 ||
    value1.tag === ValueTag.I32 ||
    value1.tag === ValueTag.U64 ||
    value1.tag === ValueTag.I64 ||
    value1.tag === ValueTag.F16 ||
    value1.tag === ValueTag.F32 ||
    value1.tag === ValueTag.F64
  ) {
    return value1.value === (value2 as NumberValue).value;
  } else if (value1.tag === ValueTag.Boolean) {
    return value1.value === (value2 as BooleanValue).value;
  } else if (value1.tag === ValueTag.Char) {
    return value1.value === (value2 as CharValue).value;
  } else if (value1.tag === ValueTag.Array) {
    if (value1.value.length !== (value2 as ArrayValue).value.length) {
      return false;
    }
    for (let i = 0; i < value1.value.length; i++) {
      if (
        !areValuesEqual(value1.value[i], (value2 as ArrayValue).value[i], env)
      ) {
        return false;
      }
    }
    return true;
  } else if (value1.tag === ValueTag.Tuple) {
    if (value1.elements.length !== (value2 as TupleValue).elements.length) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          value1.elements[i],
          (value2 as TupleValue).elements[i],
          env
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (value1.tag === ValueTag.Struct) {
    if (value1.members.length !== (value2 as StructValue).members.length) {
      return false;
    }
    for (let i = 0; i < value1.members.length; i++) {
      if (
        !areValuesEqual(
          value1.members[i],
          (value2 as StructValue).members[i],
          env
        )
      ) {
        return false;
      }
    }
    return true;
  } else {
    throw new Error(`areValuesEqual: Unsupported value: 
${valueToString(value1)}
${valueToString(value2)}`);
  }
}
