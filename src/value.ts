import { Environment } from "./env";
import { FunctionValue } from "./function-value";
import {
  areTypesCompatible,
  ArrayType,
  EnumType,
  isTypeHierarchyType,
  SomeType,
  StructType,
  TBoolean,
  TupleType,
  Type,
  typeOfType,
  TypeTag,
  typeToString,
} from "./type-checker";
import { TypeValue } from "./type-value";
import { UnitValue } from "./unit-value";
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
  elements: Value[];
};

export type EnumValue = {
  tag: ValueTag.Enum;
  type: EnumType;
  variantName: string;
  elements: Value[];
};

export type UnknownValue = {
  tag: ValueTag.Unknown;
  type: Type;
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
  | EnumValue
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
    return "<runtime value>";
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
      return `_(${value.elements
        .map((element) => {
          return `${valueToString(element)}`;
        })
        .join(", ")})`;
    }
    case ValueTag.Enum: {
      if (value.elements.length === 0) {
        return `.${value.variantName}`;
      }
      return `.${value.variantName}(${value.elements
        .map(valueToString)
        .join(", ")})`;
    }
    /*
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
      return `<compt ${typeToString(value.type)}>`;
    }
    default: {
      throw new Error(`valueToString: Unsupported value`);
    }
  }
}

export function isTypeValue(value?: Value): value is TypeValue {
  return value?.tag === ValueTag.Type;
}

export function isBooleanValue(value?: Value): value is BooleanValue {
  return value?.tag === ValueTag.Boolean;
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

export function isStructValue(value?: Value): value is StructValue {
  return value?.tag === ValueTag.Struct;
}

export function createTypeValue(value: Type): TypeValue {
  return {
    tag: ValueTag.Type,
    type: typeOfType(value),
    value,
  };
}

export function createBooleanValue(value: boolean): BooleanValue {
  return {
    tag: ValueTag.Boolean,
    type: TBoolean,
    value,
  };
}

let someTypeIdIndex = 0;
export function createUnknownValue(
  type: Type,
  variableName?: string
): UnknownValue | TypeValue {
  if (isTypeHierarchyType(type) && type.level === 0 && variableName) {
    // SomeType
    const someType: SomeType = {
      tag: TypeTag.SomeType,
      typeId: `sometype_${someTypeIdIndex++}`,
      name: variableName,
      parentType: type,
      size: undefined,
    };
    return createTypeValue(someType);
  }

  return {
    tag: ValueTag.Unknown,
    type,
  };
}

export function createStructValue(
  type: StructType,
  elements: Value[]
): StructValue {
  return {
    tag: ValueTag.Struct,
    type,
    elements,
  };
}

export function createEnumValue(
  type: EnumType,
  variantName: string,
  elements: Value[]
): EnumValue {
  return {
    tag: ValueTag.Enum,
    type,
    variantName,
    elements,
  };
}

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
    if (
      value1.elements.length !== (value2 as StructValue).elements.length ||
      !areTypesCompatible(value1.type, value2.type, env)
    ) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          value1.elements[i],
          (value2 as StructValue).elements[i],
          env
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (value1.tag === ValueTag.Enum) {
    if (
      value1.elements.length !== (value2 as EnumValue).elements.length ||
      !areTypesCompatible(value1.type, value2.type, env) ||
      value1.variantName !== (value2 as EnumValue).variantName
    ) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          value1.elements[i],
          (value2 as StructValue).elements[i],
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
