import { type Environment, getVariablesFromEnv } from "./env";
import { type EvaluatorContext } from "./evaluator/context";
import { type Expr, exprsAreEqual, exprToString } from "./expr";
import type { FunctionValue } from "./function-value";
import { stringIsOperator } from "./token";
import type { TypeValue } from "./type-value";
import { areTypesCompatible } from "./types/compatibility";
import {
  createBooleanType,
  createComptimeFloatType,
  createComptimeIntType,
  createComptimeListType,
  createComptimeStringType,
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
} from "./types/creators";
import type {
  ArrayType,
  ComptimeListType,
  EnumType,
  ExprType,
  FunctionType,
  PtrType,
  StructType,
  TraitType,
  TupleType,
  Type,
} from "./types/definitions";
import {
  isExprType,
  isFunctionType,
  isTypeHierarchyType,
} from "./types/guards";
import { typeOfType } from "./types/hierarchy";
import { typeToString } from "./types/utils";
import type { UnitValue } from "./unit-value";
import { ValueTag } from "./value-tag";

export type ComptimeStringValue = {
  tag: ValueTag.ComptimeString;
  type: Type;
  value: string;
};

export type NumberValue = {
  tag:
    | ValueTag.ComptimeInt
    | ValueTag.ComptimeFloat
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
  value: number | bigint;
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
  /**
   * Ordinary runtime structs always store concrete field values. Imported
   * source-module namespaces reuse StructValue and can expose runtime
   * declarations before codegen has a compile-time value for them.
   */
  fields: (Value | undefined)[];
  /**
   * Source-module-level `:=` initialization expressions that need to be
   * emitted as file-scope static variables with initialization in main().
   * Only present for imported source-module namespace structs.
   */
  moduleLevelInitExprs?: Expr[];
  /**
   * True while the source module is still being evaluated (used for circular
   * import detection). When a field is not found on a loading source module, a
   * specific error is shown.
   */
  isLoading?: boolean;
};

export type EnumValue = {
  tag: ValueTag.Enum;
  type: EnumType;
  variantName: string;
  fields: Value[];
};

export type TraitValue = {
  tag: ValueTag.Trait;
  type: TraitType;
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

export type ComptimeListValue = {
  tag: ValueTag.ComptimeList;
  type: ComptimeListType;
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
  /**
   * When true, this UnknownValue represents a runtime computation result
   * (e.g., from Index trait dispatch) that cannot be used for compile-time
   * evaluation. When false/undefined, it's a compile-time placeholder
   * (e.g., from CTFE analysis) that CAN be used for comptime functions.
   */
  isRuntimeOnly?: boolean;
  /**
   * Mutual-recursion bridge. When an UnknownValue stands for a
   * `comptime(name) : (fn ...)` variable that will be assigned a
   * FunctionValue later, the assignment back-patches this field with the
   * eventual funcId. Codegen then uses it to emit a direct call instead
   * of treating the callee as a runtime fn-pointer (which would emit the
   * raw `name` identifier with no declaration).
   */
  resolvedFuncValueId?: string;
};

/**
 * Compile-time pointer value that stores a reference to a value.
 * Used for compile-time pointer operations like &(x) and y.*
 * The targetValue array is shared with the source, enabling mutable reference semantics.
 */
export type PtrValue = {
  tag: ValueTag.Ptr;
  type: PtrType;
  /**
   * Reference to the value being pointed to, wrapped in a single-element array.
   * This is the same array object as the source variable's value array,
   * allowing mutations through the pointer to affect the original.
   * For simple variables, this contains the value directly.
   * For array element pointers, this contains the ArrayValue.
   */
  targetValue: [Value];
  /**
   * Index into the target. For simple variable pointers, this is 0.
   * For array element pointers like &(arr(2)), this is 2 and targetValue[0] is the ArrayValue.
   */
  targetIndex: number;
};

export type Value =
  | TypeValue
  | ComptimeStringValue
  | ComptimeListValue
  | NumberValue
  | UnitValue
  | BooleanValue
  | ArrayValue
  | TupleValue
  | StructValue
  | EnumValue
  | TraitValue
  | FunctionValue
  | ExprValue
  | UnknownValue
  | PtrValue;

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
    case ValueTag.ComptimeInt:
    case ValueTag.ComptimeFloat: {
      return value.value.toString();
    }
    case ValueTag.ComptimeString: {
      return JSON.stringify(value.value);
    }
    case ValueTag.ComptimeList: {
      return `comptime_list(${value.elements.map(valueToString).join(", ")})`;
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
      return typeof value.value === "bigint"
        ? value.value.toString()
        : value.value.toString();
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
          return `${label}: ${valueToString(element)}`;
        })
        .join(", ")})`;
    }
    case ValueTag.Enum: {
      if (value.fields.length === 0) {
        return `.${value.variantName}`;
      }

      const variant = value.type.variants.find(
        (_variant) => _variant.name === value.variantName
      );
      return `.${value.variantName}(${value.fields
        .map((element, index) => {
          let label = variant?.fields![index]!.label ?? `_`;
          if (stringIsOperator(label)) {
            label = `(${label})`;
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
    case ValueTag.Trait: {
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
      return `<comptime ${typeToString(value.type)}>`;
    }
    case ValueTag.Ptr: {
      const target = value.targetValue[0];
      if (isArrayValue(target)) {
        return `<ptr to ${valueToString(target.elements[value.targetIndex])}>`;
      }
      return `<ptr to ${valueToString(target)}>`;
    }
    default: {
      throw new Error(`valueToString: Unsupported value`);
    }
  }
}

export function isTypeValue(value?: Value): value is TypeValue {
  return value?.tag === ValueTag.Type;
}

export function isComptimeIntValue(value?: Value): value is NumberValue {
  return value?.tag === ValueTag.ComptimeInt;
}

export function isComptimeFloatValue(value?: Value): value is NumberValue {
  return value?.tag === ValueTag.ComptimeFloat;
}

export function isComptimeStringValue(
  value?: Value
): value is ComptimeStringValue {
  return value?.tag === ValueTag.ComptimeString;
}

export function isComptimeListValue(value?: Value): value is ComptimeListValue {
  return value?.tag === ValueTag.ComptimeList;
}

export function isExprListValue(value?: Value): value is ComptimeListValue {
  return isComptimeListValue(value) && isExprType(value.type.childType);
}

export function isNumberValue(value?: Value): value is NumberValue {
  return (
    value?.tag === ValueTag.ComptimeInt ||
    value?.tag === ValueTag.ComptimeFloat ||
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

export function isTraitValue(value?: Value): value is TraitValue {
  return value?.tag === ValueTag.Trait;
}

export function isPtrValue(value?: Value): value is PtrValue {
  return value?.tag === ValueTag.Ptr;
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

export function createComptimeStringValue(value: string): ComptimeStringValue {
  return {
    tag: ValueTag.ComptimeString,
    type: createComptimeStringType(),
    value,
  };
}

export function createComptimeListValue(
  childType: Type,
  elements: Value[]
): ComptimeListValue {
  return {
    tag: ValueTag.ComptimeList,
    type: createComptimeListType(childType),
    elements,
  };
}

// TODO: Check the value boundaries for number values
export function createNumberValue(
  tag: NumberValue["tag"],
  value: number | bigint
) {
  let numberType: Type;
  if (tag === ValueTag.ComptimeInt) {
    numberType = createComptimeIntType();
  } else if (tag === ValueTag.ComptimeFloat) {
    numberType = createComptimeFloatType();
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

export function createComptimeIntValue(value: bigint): NumberValue {
  return createNumberValue(ValueTag.ComptimeInt, value);
}

export function createComptimeFloatValue(value: number): NumberValue {
  return createNumberValue(ValueTag.ComptimeFloat, value);
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
  {
    variableName,
    recursiveTypeRef,
    env,
    context,
  }: {
    variableName?: string;
    recursiveTypeRef?: {
      functionValue: FunctionValue;
      argValues: Value[];
    };
    env: Environment;
    context: EvaluatorContext;
  }
): UnknownValue | TypeValue {
  if (isTypeHierarchyType(type) && type.level === 0) {
    if (!variableName) {
      throw new Error(
        `createUnknownValue expects a variable name for type ${typeToString(type)}`
      );
    }

    // SomeType
    const someType = createSomeType(type, variableName, {
      recursiveTypeRef,
      env,
      context,
    });
    return createTypeValue(someType);
  }

  // Handle function-type kind annotations for HKT support.
  // When a generic parameter has a kind like `fn(comptime(T) : Type) -> comptime(Type)`,
  // create a SomeType with kindFunctionType set.
  if (isFunctionType(type) && variableName) {
    const funcType = type as FunctionType;
    // Check if return type is comptime Type (Type hierarchy)
    if (
      funcType.return.isCompileTimeOnly &&
      isTypeHierarchyType(funcType.return.type) &&
      funcType.return.type.level === 0
    ) {
      // Check that all parameters are comptime
      const allParamsComptime = funcType.parameters.every(
        (p) => p.isCompileTimeOnly
      );
      if (allParamsComptime) {
        // Create a SomeType with kindFunctionType
        const someType = createSomeType(
          funcType.return.type, // parentType is Type (level 0) — F IS a type
          variableName,
          { recursiveTypeRef, env, context }
        );
        someType.kindFunctionType = funcType;
        return createTypeValue(someType);
      }
    }
  }

  return {
    tag: ValueTag.Unknown,
    type,
    variableName,
  };
}

export function createStructValue(
  type: StructType,
  fields: (Value | undefined)[],
  moduleLevelInitExprs?: Expr[]
): StructValue {
  return {
    tag: ValueTag.Struct,
    type,
    fields,
    moduleLevelInitExprs:
      moduleLevelInitExprs && moduleLevelInitExprs.length > 0
        ? moduleLevelInitExprs
        : undefined,
  };
}

export function createTraitValue(
  type: TraitType,
  fields: (Value | undefined)[]
): TraitValue {
  return {
    tag: ValueTag.Trait,
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

export function createPtrValue(
  type: PtrType,
  targetValue: [Value],
  targetIndex: number = 0
): PtrValue {
  return {
    tag: ValueTag.Ptr,
    type,
    targetValue,
    targetIndex,
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
  } else if (isComptimeStringValue(value1) && isComptimeStringValue(value2)) {
    return value1.value === (value2 as ComptimeStringValue).value;
  } else if (isComptimeListValue(value1) && isComptimeListValue(value2)) {
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
    // Handle both number and bigint comparisons
    const v1 = value1.value;
    const v2 = value2.value;
    // If both are bigint or both are number, compare directly
    if (typeof v1 === typeof v2) {
      return v1 === v2;
    }
    // If one is bigint and one is number, convert to bigint for comparison
    const bigV1 = typeof v1 === "bigint" ? v1 : BigInt(v1);
    const bigV2 = typeof v2 === "bigint" ? v2 : BigInt(v2);
    return bigV1 === bigV2;
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
  } else if (isTraitValue(value1) && isTraitValue(value2)) {
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
        if (variable1.value && !isUnknownValue(variable1.value[0])) {
          resolvedValue1 = variable1.value[0];
        }
      }
    }

    if (value2.variableName) {
      const variables2 = getVariablesFromEnv(given.env, value2.variableName);
      if (variables2.length > 0) {
        const variable2 = variables2[variables2.length - 1]!;
        if (variable2.value && !isUnknownValue(variable2.value[0])) {
          resolvedValue2 = variable2.value[0];
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
    // "Maximum Call Stack Exceeded" exception due to the evaluateComptimeFunctionCall
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
        if (variable1.value && !isUnknownValue(variable1.value[0])) {
          return areValuesEqual(
            { value: variable1.value[0], env: expected.env },
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
        if (variable2.value && !isUnknownValue(variable2.value[0])) {
          return areValuesEqual(
            { value: value1, env: expected.env },
            { value: variable2.value[0], env: given.env }
          );
        }
      }
    }
    return false;
  } else if (isPtrValue(value1) && isPtrValue(value2)) {
    // Check if they point to the same element
    return (
      value1.targetValue === value2.targetValue &&
      value1.targetIndex === value2.targetIndex
    );
  } else {
    return false;
  }
}
