import { Environment } from "./env";
import { Expr, exprToString } from "./expr";
import { FunctionValue } from "./function-value";
import {
  areTypesCompatible,
  ArrayType,
  createBooleanType,
  createComptFloatType,
  createComptIntType,
  createComptStringType,
  createExprType,
  createF32Type,
  createF64Type,
  createI16Type,
  createI32Type,
  createI64Type,
  createI8Type,
  createIsizeType,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
  createUsizeType,
  EnumType,
  ExprType,
  isTypeHierarchyType,
  ModuleType,
  SomeType,
  StructType,
  TupleType,
  Type,
  typeOfType,
  TypeTag,
  typeToString,
} from "./type-checker";
import { TypeValue } from "./type-value";
import { UnitValue } from "./unit-value";
import { ValueTag } from "./value-tag";

export type ComptStringValue = {
  tag: ValueTag.ComptString;
  type: Type;
  value: string;
};

export type NumberValue = {
  tag:
    | ValueTag.ComptInt
    | ValueTag.ComptFloat
    | ValueTag.U8
    | ValueTag.I8
    | ValueTag.U16
    | ValueTag.I16
    | ValueTag.U32
    | ValueTag.I32
    | ValueTag.U64
    | ValueTag.I64
    | ValueTag.F32
    | ValueTag.F64
    | ValueTag.Usize
    | ValueTag.Isize;
  type: Type;
  value: number;
};

export type BooleanValue = {
  tag: ValueTag.Boolean;
  type: Type;
  value: boolean;
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

export type ModuleValue = {
  tag: ValueTag.Module;
  type: ModuleType;
  /**
   * undefined element means runtime value.
   */
  elements: (Value | undefined)[];
};

export type ArrayValue = {
  tag: ValueTag.Array;
  type: ArrayType;
  elements: Value[];
};

export type ExprValue = {
  tag: ValueTag.Expr;
  type: ExprType;
  value: Expr;
};

export type UnknownValue = {
  tag: ValueTag.Unknown;
  type: Type;
};

export type Value =
  | TypeValue
  | ComptStringValue
  | NumberValue
  | UnitValue
  | BooleanValue
  | ArrayValue
  | TupleValue
  | StructValue
  | EnumValue
  | ModuleValue
  | FunctionValue
  | ExprValue
  | UnknownValue;

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
    case ValueTag.ComptInt:
    case ValueTag.ComptFloat: {
      return value.value.toString();
    }
    case ValueTag.ComptString: {
      return JSON.stringify(value.value);
    }
    case ValueTag.U8:
    case ValueTag.I8:
    case ValueTag.U16:
    case ValueTag.I16:
    case ValueTag.U32:
    case ValueTag.I32:
    case ValueTag.U64:
    case ValueTag.I64:
    case ValueTag.F32:
    case ValueTag.F64:
    case ValueTag.Usize:
    case ValueTag.Isize: {
      return value.value.toString();
    }
    case ValueTag.Boolean: {
      return value.value.toString();
    }
    case ValueTag.Array: {
      return `[${value.elements.map(valueToString).join(", ")}]`;
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
      return `${value.type.typeName ?? "_"}(${value.elements
        .map((element, index) => {
          const label = value.type.elements[index]!.label;
          return `${label}: ${valueToString(element)}`;
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
    case ValueTag.Module: {
      return `${value.type.typeName ?? "_"}(${value.elements
        .map((element, index) => {
          const label = value.type.elements[index]!.label;
          return `${label}: ${valueToString(element)}`;
        })
        .join(", ")})`;
    }
    case ValueTag.Unit: {
      return `()`;
    }
    case ValueTag.Expr: {
      return exprToString(value.value);
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

export function isComptIntValue(value?: Value): boolean {
  return value?.tag === ValueTag.ComptInt;
}

export function isComptFloatValue(value?: Value): boolean {
  return value?.tag === ValueTag.ComptFloat;
}

export function isComptStringValue(value?: Value): value is ComptStringValue {
  return value?.tag === ValueTag.ComptString;
}

export function isNumberValue(value?: Value): value is NumberValue {
  return (
    value?.tag === ValueTag.ComptInt ||
    value?.tag === ValueTag.ComptFloat ||
    value?.tag === ValueTag.U8 ||
    value?.tag === ValueTag.I8 ||
    value?.tag === ValueTag.U16 ||
    value?.tag === ValueTag.I16 ||
    value?.tag === ValueTag.U32 ||
    value?.tag === ValueTag.I32 ||
    value?.tag === ValueTag.U64 ||
    value?.tag === ValueTag.I64 ||
    value?.tag === ValueTag.F32 ||
    value?.tag === ValueTag.F64 ||
    value?.tag === ValueTag.Usize ||
    value?.tag === ValueTag.Isize
  );
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

export function isArrayValue(value?: Value): value is ArrayValue {
  return value?.tag === ValueTag.Array;
}

export function isEnumValue(value?: Value): value is EnumValue {
  return value?.tag === ValueTag.Enum;
}

export function isModuleValue(value?: Value): value is ModuleValue {
  return value?.tag === ValueTag.Module;
}

export function isExprValue(value?: Value): value is ExprValue {
  return value?.tag === ValueTag.Expr;
}

export function createTypeValue(value: Type): TypeValue {
  return {
    tag: ValueTag.Type,
    type: typeOfType(value),
    value,
  };
}

export function createComptStringValue(value: string): ComptStringValue {
  return {
    tag: ValueTag.ComptString,
    type: createComptStringType(),
    value,
  };
}

export function createNumberValue(tag: NumberValue["tag"], value: number) {
  let numberType: Type;
  if (tag === ValueTag.ComptInt) {
    numberType = createComptIntType();
  } else if (tag === ValueTag.ComptFloat) {
    numberType = createComptFloatType();
  } else if (tag === ValueTag.U8) {
    numberType = createU8Type();
  } else if (tag === ValueTag.I8) {
    numberType = createI8Type();
  } else if (tag === ValueTag.U16) {
    numberType = createU16Type();
  } else if (tag === ValueTag.I16) {
    numberType = createI16Type();
  } else if (tag === ValueTag.U32) {
    numberType = createU32Type();
  } else if (tag === ValueTag.I32) {
    numberType = createI32Type();
  } else if (tag === ValueTag.U64) {
    numberType = createU64Type();
  } else if (tag === ValueTag.I64) {
    numberType = createI64Type();
  } else if (tag === ValueTag.F32) {
    numberType = createF32Type();
  } else if (tag === ValueTag.F64) {
    numberType = createF64Type();
  } else if (tag === ValueTag.Usize) {
    numberType = createUsizeType();
  } else if (tag === ValueTag.Isize) {
    numberType = createIsizeType();
  } else {
    throw new Error(`createNumberValue: Unsupported tag: ${tag}`);
  }

  return {
    tag,
    type: numberType,
    value,
  };
}

export function createBooleanValue(value: boolean): BooleanValue {
  return {
    tag: ValueTag.Boolean,
    type: createBooleanType(),
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

export function createModuleValue(
  type: ModuleType,
  elements: (Value | undefined)[]
): ModuleValue {
  return {
    tag: ValueTag.Module,
    type,
    elements,
  };
}

export function createTupleValue(
  type: TupleType,
  elements: Value[]
): TupleValue {
  return {
    tag: ValueTag.Tuple,
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

export function createArrayValue(
  type: ArrayType,
  elements: Value[]
): ArrayValue {
  return {
    tag: ValueTag.Array,
    type,
    elements,
  };
}

export function createExprValue(expr: Expr): ExprValue {
  return {
    tag: ValueTag.Expr,
    type: createExprType(),
    value: expr,
  };
}

export function areValuesEqual(
  expected: {
    value: Value | undefined;
    env: Environment;
  },
  given: {
    value: Value | undefined;
    env: Environment;
  }
): boolean {
  const value1 = expected.value;
  const value2 = given.value;

  if (value1 === value2) {
    return true;
  }

  if (!value1 || !value2) {
    return false;
  }

  if (value1.tag === ValueTag.Type && value2.tag === ValueTag.Type) {
    return areTypesCompatible(
      { type: value1.value, env: expected.env },
      { type: value2.value, env: given.env }
    );
  } else if (isComptStringValue(value1) && isComptStringValue(value2)) {
    return value1.value === (value2 as ComptStringValue).value;
  } else if (isNumberValue(value1) && isNumberValue(value2)) {
    return value1.value === (value2 as NumberValue).value;
  } else if (isBooleanValue(value1) && isBooleanValue(value2)) {
    return value1.value === (value2 as BooleanValue).value;
  } else if (isArrayValue(value1) && isArrayValue(value2)) {
    if (value1.elements.length !== (value2 as ArrayValue).elements.length) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.elements[i], env: expected.env },
          { value: value2.elements[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isTupleValue(value1) && isTupleValue(value2)) {
    if (value1.elements.length !== (value2 as TupleValue).elements.length) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.elements[i], env: expected.env },
          { value: value2.elements[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isStructValue(value1) && isStructValue(value2)) {
    if (
      value1.elements.length !== value2.elements.length ||
      !areTypesCompatible(
        { type: value1.type, env: expected.env },
        { type: value2.type, env: given.env }
      )
    ) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.elements[i], env: expected.env },
          { value: value2.elements[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isEnumValue(value1) && isEnumValue(value2)) {
    if (
      value1.elements.length !== (value2 as EnumValue).elements.length ||
      !areTypesCompatible(
        { type: value1.type, env: expected.env },
        { type: value2.type, env: given.env }
      ) ||
      value1.variantName !== (value2 as EnumValue).variantName
    ) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.elements[i], env: expected.env },
          { value: value2.elements[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isModuleValue(value1) && isModuleValue(value2)) {
    if (
      value1.elements.length !== value2.elements.length ||
      !areTypesCompatible(
        { type: value1.type, env: expected.env },
        { type: value2.type, env: given.env }
      )
    ) {
      return false;
    }
    for (let i = 0; i < value1.elements.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.elements[i], env: expected.env },
          { value: value2.elements[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isExprValue(value1) && isExprValue(value2)) {
    return value1.value === value2.value;
  } else {
    return false;
  }
}
