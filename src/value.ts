import { Environment, getVariablesFromEnv } from "./env";
import { Expr, exprsAreEqual, exprToString } from "./expr";
import { FunctionValue } from "./function-value";
import { stringIsOperator } from "./token";
import { TypeValue } from "./type-value";
import {
  areTypesCompatible,
  ArrayType,
  ComptListType,
  createBooleanType,
  createComptFloatType,
  createComptIntType,
  createComptListType,
  createComptStringType,
  createExprType,
  createF32Type,
  createF64Type,
  createI16Type,
  createI32Type,
  createI64Type,
  createI8Type,
  createIsizeType,
  createSomeType,
  createU16Type,
  createU32Type,
  createU64Type,
  createU8Type,
  createUsizeType,
  EnumType,
  ExprType,
  isExprType,
  isTypeHierarchyType,
  ModuleType,
  StructType,
  TupleType,
  Type,
  typeOfType,
  typeToString,
} from "./types";
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
  tag: ValueTag.Bool;
  type: Type;
  value: boolean;
};

export type TupleValue = {
  tag: ValueTag.Tuple;
  type: TupleType;
  fields: Value[];
};

export type StructValue = {
  tag: ValueTag.Struct;
  type: StructType;
  fields: Value[];
};

export type EnumValue = {
  tag: ValueTag.Enum;
  type: EnumType;
  variantName: string;
  fields: Value[];
};

export type ModuleValue = {
  tag: ValueTag.Module;
  type: ModuleType;
  /**
   * undefined element means runtime value.
   */
  fields: (Value | undefined)[];
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

export type ComptListValue = {
  tag: ValueTag.ComptList;
  type: ComptListType;
  // The UnknownValue here should have a type of ExprType
  elements: Value[];
};

export type UnknownValue = {
  tag: ValueTag.Unknown;
  /**
   * Type of the unknown value.
   */
  type: Type;
  /**
   * The name of the variable holding this unknown value.
   */
  variableName?: string;
};

export type Value =
  | TypeValue
  | ComptStringValue
  | ComptListValue
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
    case ValueTag.ComptList: {
      return `compt_list(${value.elements.map(valueToString).join(", ")})`;
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
    case ValueTag.Bool: {
      return value.value.toString();
    }
    case ValueTag.Array: {
      return `[${value.elements.map(valueToString).join(", ")}${
        value.elements.length === 1 ? "," : ""
      }]`;
    }
    case ValueTag.Tuple: {
      if (value.fields.length === 0) {
        return "()";
      }
      return `(${value.fields.map(valueToString).join(", ")}${
        value.fields.length === 1 ? "," : ""
      })`;
    }
    case ValueTag.Struct: {
      return `${value.type.typeName ?? "_"}(${value.fields
        .map((element, index) => {
          let label = value.type.fields[index]!.label;
          if (stringIsOperator(label)) {
            label = `(${label})`;
          }
          if (value.type.fields[index]!.isCompileTimeOnly) {
            label = stringIsOperator(label)
              ? `compt${label}`
              : `compt(${label})`;
          }
          return `${label}: ${valueToString(element)}`;
        })
        .join(", ")})`;
    }
    case ValueTag.Enum: {
      if (value.fields.length === 0) {
        return `.${value.variantName}`;
      }

      const variant = value.type.variants.find(
        (variant) => variant.name === value.variantName
      );
      return `.${value.variantName}(${value.fields
        .map((element, index) => {
          let label = variant?.fields![index]!.label ?? `_`;
          if (stringIsOperator(label)) {
            label = `(${label})`;
          }
          if (variant?.fields![index]!.isCompileTimeOnly) {
            label = stringIsOperator(label)
              ? `compt${label}`
              : `compt(${label})`;
          }
          return `${label}: ${valueToString(element)}`;
        })
        .join(", ")})`;
    }
    /*
    case TypeTag.Union: {
      return `${value.variantName}(${valueToString(value.value)})`;
    }
    */
    case ValueTag.Function: {
      if (value.funcName) {
        return `<fn ${value.funcName}>`;
      }
      if (value.type.typeName) {
        return `<fn ${value.type.typeName}>`;
      }
      return `<fn>`;
    }
    case ValueTag.Module: {
      return `${value.type.typeName ?? "_"}(${value.fields
        .map((element, index) => {
          let label = value.type.fields[index]!.label;
          if (stringIsOperator(label)) {
            label = `(${label})`;
          }
          return `${label}: ${valueToString(element)}`;
        })
        .join(", ")})`;
    }
    case ValueTag.Unit: {
      return `()`;
    }
    case ValueTag.Expr: {
      return `quote(${exprToString(value.value)})`;
    }
    case ValueTag.Unknown: {
      if (value.variableName) {
        return value.variableName;
      }
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

export function isComptIntValue(value?: Value): value is NumberValue {
  return value?.tag === ValueTag.ComptInt;
}

export function isComptFloatValue(value?: Value): value is NumberValue {
  return value?.tag === ValueTag.ComptFloat;
}

export function isComptStringValue(value?: Value): value is ComptStringValue {
  return value?.tag === ValueTag.ComptString;
}

export function isComptListValue(value?: Value): value is ComptListValue {
  return value?.tag === ValueTag.ComptList;
}

export function isExprListValue(value?: Value): value is ComptListValue {
  return isComptListValue(value) && isExprType(value.type.childType);
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
  return value?.tag === ValueTag.Bool;
}

export function isFunctionValue(value?: Value): value is FunctionValue {
  return value?.tag === ValueTag.Function;
}

/**
 * UnknownValue is a compile-time value, not runtime value.
 * It's just we only know its type but not real value.
 * @returns
 */
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

export function isRegionValue(_value?: Value): boolean {
  return false;
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

export function createComptListValue(
  childType: Type,
  elements: Value[]
): ComptListValue {
  return {
    tag: ValueTag.ComptList,
    type: createComptListType(childType),
    elements,
  };
}

// TODO: Check the value boundaries for number values
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

export function createComptIntValue(value: number): NumberValue {
  return createNumberValue(ValueTag.ComptInt, value);
}

export function createComptFloatValue(value: number): NumberValue {
  return createNumberValue(ValueTag.ComptFloat, value);
}

export function createBooleanValue(value: boolean): BooleanValue {
  return {
    tag: ValueTag.Bool,
    type: createBooleanType(),
    value,
  };
}

export function createUnknownValue(
  type: Type,
  variableName?: string,
  recursiveTypeRef?: {
    functionValue: FunctionValue;
    argValues: Value[];
  }
): UnknownValue | TypeValue {
  if (isTypeHierarchyType(type) && type.level === 0) {
    if (!variableName) {
      console.trace("!variableName bug found in createUnknownValue");
      throw new Error(
        `createUnknownValue expects a variable name for type ${typeToString(
          type
        )}`
      );
    }

    // SomeType
    const someType = createSomeType(
      type,
      variableName,
      undefined,
      undefined,
      undefined,
      recursiveTypeRef
    );
    return createTypeValue(someType);
  }

  return {
    tag: ValueTag.Unknown,
    type,
    variableName,
  };
}

export function createStructValue(
  type: StructType,
  fields: Value[]
): StructValue {
  return {
    tag: ValueTag.Struct,
    type,
    fields,
  };
}

export function createModuleValue(
  type: ModuleType,
  fields: (Value | undefined)[]
): ModuleValue {
  return {
    tag: ValueTag.Module,
    type,
    fields,
  };
}

export function createTupleValue(type: TupleType, fields: Value[]): TupleValue {
  return {
    tag: ValueTag.Tuple,
    type,
    fields,
  };
}

export function createEnumValue(
  type: EnumType,
  variantName: string,
  fields: Value[]
): EnumValue {
  return {
    tag: ValueTag.Enum,
    type,
    variantName,
    fields,
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
    type: createExprType() as ExprType,
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
      { type: value2.value, env: given.env },
      true
    );
  } else if (isComptStringValue(value1) && isComptStringValue(value2)) {
    return value1.value === (value2 as ComptStringValue).value;
  } else if (isComptListValue(value1) && isComptListValue(value2)) {
    if (value1.elements.length !== value2.elements.length) {
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
    if (value1.fields.length !== (value2 as TupleValue).fields.length) {
      return false;
    }
    for (let i = 0; i < value1.fields.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.fields[i], env: expected.env },
          { value: value2.fields[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isStructValue(value1) && isStructValue(value2)) {
    if (
      value1.fields.length !== value2.fields.length ||
      !areTypesCompatible(
        { type: value1.type, env: expected.env },
        { type: value2.type, env: given.env },
        true
      )
    ) {
      return false;
    }
    for (let i = 0; i < value1.fields.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.fields[i], env: expected.env },
          { value: value2.fields[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isEnumValue(value1) && isEnumValue(value2)) {
    if (
      value1.fields.length !== (value2 as EnumValue).fields.length ||
      !areTypesCompatible(
        { type: value1.type, env: expected.env },
        { type: value2.type, env: given.env },
        true
      ) ||
      value1.variantName !== (value2 as EnumValue).variantName
    ) {
      return false;
    }
    for (let i = 0; i < value1.fields.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.fields[i], env: expected.env },
          { value: value2.fields[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isModuleValue(value1) && isModuleValue(value2)) {
    if (
      value1.fields.length !== value2.fields.length ||
      !areTypesCompatible(
        { type: value1.type, env: expected.env },
        { type: value2.type, env: given.env },
        true
      )
    ) {
      return false;
    }
    for (let i = 0; i < value1.fields.length; i++) {
      if (
        !areValuesEqual(
          { value: value1.fields[i], env: expected.env },
          { value: value2.fields[i], env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  } else if (isExprValue(value1) && isExprValue(value2)) {
    return (
      value1.value === value2.value || exprsAreEqual(value1.value, value2.value)
    );
  }
  // Handle UnknownValue by attempting to resolve them and comparing resolved values
  else if (isUnknownValue(value1) && isUnknownValue(value2)) {
    // Try to resolve both unknown values from their environments
    let resolvedValue1: Value | undefined = undefined;
    let resolvedValue2: Value | undefined = undefined;

    if (value1.variableName) {
      const variables1 = getVariablesFromEnv(expected.env, value1.variableName);
      if (variables1.length > 0) {
        const variable1 = variables1[variables1.length - 1]!;
        if (variable1.value && !isUnknownValue(variable1.value)) {
          resolvedValue1 = variable1.value;
        }
      }
    }

    if (value2.variableName) {
      const variables2 = getVariablesFromEnv(given.env, value2.variableName);
      if (variables2.length > 0) {
        const variable2 = variables2[variables2.length - 1]!;
        if (variable2.value && !isUnknownValue(variable2.value)) {
          resolvedValue2 = variable2.value;
        }
      }
    }

    // If both values resolved to concrete values, compare those
    if (resolvedValue1 && resolvedValue2) {
      return areValuesEqual(
        { value: resolvedValue1, env: expected.env },
        { value: resolvedValue2, env: given.env }
      );
    }

    // If only one resolved, they're not equal
    if (resolvedValue1 || resolvedValue2) {
      return false;
    }

    // return false;
    // If neither resolved, fall back to type compatibility
    // NOTE: This is an assumption. If we return false here, it might cause the
    // "Maximum Call Stack Exceeded" exception due to the evaluateComptFunctionCall
    // recursively evalauting the `recur` function.
    return areTypesCompatible(
      { type: value1.type, env: expected.env },
      { type: value2.type, env: given.env },
      true
    );
  }
  // Handle the case where only one value is unknown - try to resolve it
  else if (isUnknownValue(value1) && !isUnknownValue(value2)) {
    // Try to resolve the unknown value from its environment
    if (value1.variableName) {
      const variables1 = getVariablesFromEnv(expected.env, value1.variableName);
      if (variables1.length > 0) {
        const variable1 = variables1[variables1.length - 1]!;
        if (variable1.value && !isUnknownValue(variable1.value)) {
          return areValuesEqual(
            { value: variable1.value, env: expected.env },
            { value: value2, env: given.env }
          );
        }
      }
    }
    return false;
  } else if (!isUnknownValue(value1) && isUnknownValue(value2)) {
    // Try to resolve the unknown value from its environment
    if (value2.variableName) {
      const variables2 = getVariablesFromEnv(given.env, value2.variableName);
      if (variables2.length > 0) {
        const variable2 = variables2[variables2.length - 1]!;
        if (variable2.value && !isUnknownValue(variable2.value)) {
          return areValuesEqual(
            { value: value1, env: expected.env },
            { value: variable2.value, env: given.env }
          );
        }
      }
    }
    return false;
  } else {
    return false;
  }
}
