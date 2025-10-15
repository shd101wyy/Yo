import { Environment, getVariablesFromEnv } from "../env";
import { formatErrorMessages } from "../error";
import { exprToString } from "../expr";
import { stringIsOperator, Token } from "../token";
import { TypeValue } from "../type-value";
import {
  isNumberValue,
  isTypeValue,
  isUnknownValue,
  valueToString,
} from "../value";
import { ValueTag } from "../value-tag";
import {
  createF64Type,
  createI32Type,
  createMutPtrType,
  createSliceType,
  createU8Type,
} from "./creators";
import {
  ArrayType,
  ClosureType,
  DynType,
  EnumType,
  FunctionParameter,
  FunctionType,
  FutureType,
  ModuleElement,
  ModuleType,
  MutPtrType,
  SliceType,
  SomeType,
  StructType,
  TupleElement,
  TupleType,
  Type,
  UnionType,
} from "./definitions";
import {
  isARCType,
  isArrayType,
  isBooleanType,
  isCCompatibleType,
  isCharType,
  isClosureType,
  isComptFloatType,
  isComptIntType,
  isComptStringType,
  isDynType,
  isEnumType,
  isExprListType,
  isExprType,
  isF32Type,
  isF64Type,
  isFloatType,
  isFunctionType,
  isI16Type,
  isI32Type,
  isI64Type,
  isI8Type,
  isIntegerType,
  isIsizeType,
  isModuleType,
  isMutPtrType,
  isObjectType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  isU16Type,
  isU32Type,
  isU64Type,
  isU8Type,
  isUnionType,
  isUnitType,
  isUsizeType,
} from "./guards";
import { TypeTag } from "./tags";

/**
 * Check if the type of the value requires to use the compt modifier.
 * For example:
 *   compt(x): Type
 *   compt(x): compt_int
 */
export function typeRequiresComptModifier(type?: Type): boolean {
  return (
    isTypeHierarchyType(type) ||
    isModuleType(type) ||
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isComptStringType(type) ||
    isExprListType(type) ||
    isExprType(type)
  );
}

export function typeProhibitsComptModifier(type?: Type): boolean {
  return isCCompatibleType(type);
}

/**
 * Check if the type contains `object`
 * @param type
 */
export function typeContainsARCType(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) {
    return false;
  }

  if (checkedTypes.includes(type)) {
    return false;
  } else {
    checkedTypes.push(type);
  }

  if (isARCType(type)) {
    return true;
  }

  // Recursively check in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsARCType((type as ArrayType).elementType, checkedTypes);
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeContainsARCType(element.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeContainsARCType(element.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeContainsARCType(element.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) =>
          typeContainsARCType(param.type, checkedTypes)
        )
      );
    case TypeTag.Module:
      return (type as ModuleType).elements.some((element) =>
        typeContainsARCType(element.type, checkedTypes)
      );
    case TypeTag.Function: {
      return !!(type as FunctionType).isClosure;
    }
    // No need to consider ptr/ref types, as they are not owning types
    default:
      return false; // For other types, no references are present
  }
}

/**
 * Check if a type contains SomeType.
 */
export function typeContainsSomeType(
  type?: Type,
  checkedTypes: Type[] = []
): boolean {
  if (!type) {
    return false;
  }

  if (checkedTypes.includes(type)) {
    return false; // Prevent infinite recursion on circular types
  }

  checkedTypes.push(type);

  // Check if the type is a SomeType
  if (isSomeType(type)) {
    return true;
  }

  // Recursively check for SomeType in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsSomeType(
        (type as ArrayType).elementType,
        checkedTypes
      );
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeContainsSomeType(element.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeContainsSomeType(element.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) =>
          typeContainsSomeType(param.type, checkedTypes)
        )
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeContainsSomeType(element.type, checkedTypes)
      );
    case TypeTag.Function: {
      const functionType = type as FunctionType;
      return (
        functionType.forallParameters.length > 0 ||
        functionType.parameters.some((parameter) =>
          typeContainsSomeType(parameter.type, checkedTypes)
        ) ||
        typeContainsSomeType(functionType.return.type, checkedTypes)
      );
    }
    case TypeTag.Module:
      return (type as ModuleType).elements.some((element) =>
        typeContainsSomeType(element.type, checkedTypes)
      );
    case TypeTag.MutPtr:
      return typeContainsSomeType((type as MutPtrType).type, checkedTypes);
    case TypeTag.Future:
      return typeContainsSomeType(
        (type as FutureType).elementType,
        checkedTypes
      );
    default:
      return false; // For other types, no SomeType is present
  }
}

/**
 * Get all SomeTypes contained within a type.
 * @param type
 */
export function getAllSomeTypes(type: Type): Set<SomeType> {
  const result = new Set<SomeType>();

  function helper(t: Type) {
    if (isSomeType(t)) {
      result.add(t);
    }

    switch (t.tag) {
      case TypeTag.Array:
        helper((t as ArrayType).elementType);
        break;
      case TypeTag.Tuple:
        (t as TupleType).elements.forEach((element) => helper(element.type));
        break;
      case TypeTag.Struct:
        (t as StructType).elements.forEach((element) => helper(element.type));
        break;
      case TypeTag.Enum:
        (t as EnumType).variants.forEach((variant) => {
          variant.elements?.forEach((param) => helper(param.type));
        });
        break;
      case TypeTag.Union:
        (t as UnionType).elements.forEach((element) => helper(element.type));
        break;
      case TypeTag.Module:
        (t as ModuleType).elements.forEach((element) => helper(element.type));
        break;
      case TypeTag.MutPtr:
        helper((t as MutPtrType).type);
        break;
      case TypeTag.Future:
        helper((t as FutureType).elementType);
        break;
      default:
        break; // For other types, do nothing
    }
  }

  helper(type);
  return result;
}

/**
 * Check if a type contains unknown values.
 */
export function typeRequiresInference(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Recursively check for unknown values in complex types
  switch (type.tag) {
    case TypeTag.Array: {
      const arrayType = type as ArrayType;
      return (
        isUnknownValue(arrayType.length) ||
        typeRequiresInference(arrayType.elementType)
      );
    }
    // NOTE: Let's only support ArrayType for now.
    /*
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) => typeRequiresInference(param.type))
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Module:
      return (type as ModuleType).elements.some((element) =>
        typeRequiresInference(element.type)
      );
    case TypeTag.Function: {
      const functionType = type as FunctionType;
      return (
        functionType.parameters.some((param) =>
          typeRequiresInference(param.type)
        ) ||
        typeRequiresInference(functionType.return.type) ||
        functionType.forallParameters.some((param) =>
          typeRequiresInference(param.type)
        ) ||
        functionType.implicitParameters.some((param) =>
          typeRequiresInference(param.type)
        ) ||
        (functionType.variadicParameter
          ? typeRequiresInference(functionType.variadicParameter.type)
          : false)
      );
    }
    case TypeTag.Ptr:
      return typeRequiresInference((type as PtrType).type);
    case TypeTag.MutPtr:
      return typeRequiresInference((type as MutPtrType).type);
    case TypeTag.Ref:
      return typeRequiresInference((type as RefType).type);
    case TypeTag.MutRef:
      return typeRequiresInference((type as MutRefType).type);
    */
    case TypeTag.SomeType:
      // SomeType represents unknown/inferable types
      return true;
    case TypeTag.Closure: {
      const closureType = type as ClosureType;
      return (
        typeRequiresInference(closureType.captureType) ||
        typeRequiresInference(closureType.callType)
      );
    }
    case TypeTag.Future:
      return typeRequiresInference((type as FutureType).elementType);
    default:
      return false; // For other types, no unknown values are present
  }
}

/**
 * Get the value of a SomeType from the environment.
 */
export function getValueOfSomeTypeFromEnv(
  env: Environment,
  someType: SomeType
): Type {
  let someTypeValue: TypeValue | undefined = undefined;
  do {
    const variables = getVariablesFromEnv(env, someType.name, (variable) => {
      return variable.value?.tag === ValueTag.Type;
      // cannot use "isTypeValue" function here due to circular dependency
    });
    if (!variables.length) {
      // NOTE: This might be SomeType defined from "forall"
      // So it doesn't exist in the env.
      return someType; // Return itself
      // return undefined;
    }

    someTypeValue = variables[variables.length - 1]!.value as TypeValue;

    // This if condition is used to prevent the infinite loop
    if (someTypeValue.value === someType) {
      return someType; // Returned itself actually
    }
    if (isSomeType(someTypeValue.value)) {
      someType = someTypeValue.value;
    } else {
      break;
    }
  } while (isSomeType(someType));
  return someTypeValue.value;
}

/**
 * Convert compt types to their runtime equivalents.
 */
export function convertComptTypeToRuntimeType(
  type: Type,
  expectedType?: Type
): Type {
  if (isComptIntType(type)) {
    return createI32Type();
  } else if (isComptFloatType(type)) {
    return createF64Type();
  } else if (isArrayType(type)) {
    type.elementType = convertComptTypeToRuntimeType(type.elementType);
    return type;
  } else if (isTupleType(type)) {
    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: convertComptTypeToRuntimeType(element.type),
      };
    });
    return type;
  } else if (isStructType(type)) {
    // To prevent circular reference issues
    if (isObjectType(type)) {
      return type;
    }

    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: convertComptTypeToRuntimeType(element.type),
      };
    });
    return type;
  } else if (isEnumType(type)) {
    type.variants = type.variants.map((variant) => {
      if (variant.elements) {
        variant.elements = variant.elements.map((param) => {
          return {
            ...param,
            type: convertComptTypeToRuntimeType(param.type),
          };
        });
      }
      return variant;
    });
    return type;
  } else if (isComptStringType(type)) {
    if (expectedType) {
      // Check if it's
      // - *(u8)
      // - *(char)
      if (
        isMutPtrType(expectedType) && // *(u8) or *(char)
        (isU8Type(expectedType.type) || isCharType(expectedType.type))
      ) {
        return expectedType;
      }
    }

    // Convert the compt_string to *([u8]);
    return createMutPtrType(createSliceType(createU8Type()));
  } else {
    // No change
    return type;
  }
}

/**
 * Get the bit size of an integer type.
 */
export function getIntegerTypeBits(type: Type): number {
  switch (type.tag) {
    case TypeTag.U8:
    case TypeTag.I8:
      return 8;
    case TypeTag.U16:
    case TypeTag.I16:
      return 16;
    case TypeTag.U32:
    case TypeTag.I32:
      return 32;
    case TypeTag.U64:
    case TypeTag.I64:
      return 64;
    case TypeTag.Usize:
    case TypeTag.Isize:
      return getTargetPointerSizeBits(); // Platform dependent, use configured pointer size
    default:
      throw new Error(`Not an integer type: ${type.tag}`);
  }
}

/**
 * Get the value range of an integer type.
 */
export function getIntegerTypeRange(type: Type): { min: bigint; max: bigint } {
  const bits = getIntegerTypeBits(type);

  if (
    type.tag === TypeTag.U8 ||
    type.tag === TypeTag.U16 ||
    type.tag === TypeTag.U32 ||
    type.tag === TypeTag.U64 ||
    type.tag === TypeTag.Usize
  ) {
    // Unsigned types
    return {
      min: BigInt(0),
      max: (BigInt(1) << BigInt(bits)) - BigInt(1),
    };
  } else {
    // Signed types
    const maxPositive = (BigInt(1) << BigInt(bits - 1)) - BigInt(1);
    return {
      min: -(BigInt(1) << BigInt(bits - 1)),
      max: maxPositive,
    };
  }
}

/**
 * Check if compt_int can be cast to a target type.
 */
export function canComptIntCastTo(targetType: Type): boolean {
  return isIntegerType(targetType) || isComptIntType(targetType);
}

/**
 * Check if compt_float can be cast to a target type.
 */
export function canComptFloatCastTo(targetType: Type): boolean {
  return isFloatType(targetType) || isComptFloatType(targetType);
}

/**
 * Convert a function parameter to string representation.
 */
export function functionParameterToString(
  parameter: FunctionParameter,
  visited: Set<string> = new Set()
): string {
  let label = parameter.label;

  if (parameter.isQuote) {
    label = `quote(${label})`;
  } else if (parameter.isCompileTimeOnly) {
    label = `compt(${label})`;
  }

  const typeStr = typeToString(parameter.type, visited);

  const defaultValueStr = parameter.exprs.defaultValueExpr
    ? exprToString(parameter.exprs.defaultValueExpr)
    : "";

  if (defaultValueStr) {
    return `(${label} : ${typeStr}) ?= ${defaultValueStr}`;
  } else {
    // typeStr is always defined here
    return `${label} : ${typeStr}`;
  }
}
/**
 * Convert a tuple element to string representation.
 * NOTE: Don't use element.exprs
 */
export function tupleElementToString(
  element: TupleElement,
  visited: Set<string> = new Set()
): string {
  let label = element.label;
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }
  if (element.isImplicit) {
    label = `given(${label})`;
  }
  if (element.isCompileTimeOnly) {
    label = `compt(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeToString(element.type, visited)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label}: ${typeToString(element.type, visited)}) = ${assignedValueStr}`;
  }

  return `${label}: ${typeToString(element.type, visited)}`;
}

/**
 * Convert a module element to string representation.
 */
function moduleElementToString(
  element: ModuleElement,
  visited: Set<string> = new Set()
): string {
  let label = element.label;
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }
  if (element.isImplicit) {
    label = `given(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeToString(element.type, visited)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label}: ${typeToString(element.type, visited)}) = ${assignedValueStr}`;
  }

  return `${label}: ${typeToString(element.type, visited)}`;
}

function functionTypeToString(
  func: FunctionType,
  visited: Set<string> = new Set()
): string {
  const params = func.parameters
    .map((param) => functionParameterToString(param, visited))
    .join(", ");

  const typeParams =
    func.forallParameters.length > 0
      ? `forall(${func.forallParameters
          .map((param) => functionParameterToString(param, visited))
          .join(", ")})`
      : "";
  const implicitParams =
    func.implicitParameters.length > 0
      ? `using(${func.implicitParameters
          .map((param) => functionParameterToString(param, visited))
          .join(", ")})`
      : "";
  let variadicParam = "";
  if (func.variadicParameter) {
    if (func.variadicParameter.label === "...") {
      variadicParam = "...";
    } else if (func.variadicParameter.isQuote) {
      variadicParam = `...(quote(${func.variadicParameter.label}))`;
    } else if (func.variadicParameter.isCompileTimeOnly) {
      variadicParam = `...(compt(${func.variadicParameter.label}))`;
    } else {
      variadicParam = `...(${func.variadicParameter.label})`;
    }
  }

  const returnTypeString = typeToString(func.return.type, visited);
  let returnString = returnTypeString;
  if (func.return.isUnquote) {
    if (func.return.label) {
      returnString = `(unquote(${func.return.label}) : ${returnTypeString})`;
    } else {
      returnString = `unquote(${returnTypeString})`;
    }
  } else if (func.return.isCompileTimeOnly) {
    if (func.return.label) {
      returnString = `(compt(${func.return.label}) : ${returnTypeString})`;
    } else {
      returnString = `compt(${returnTypeString})`;
    }
  }

  const paramsString = [typeParams, params, variadicParam, implicitParams]
    .filter((x) => !!x)
    .join(", ");
  const from = func.SelfType?.typeName ?? func.ModuleType?.typeName;
  const fnKind = "fn";
  return `${from ? `(${from}) ` : ""}${fnKind}(${paramsString}) ${func.isClosure ? "=>" : "->"} ${returnString}`;
}

/**
 * Convert a Type object to a human-readable string representation.
 */
export function typeToString(
  type: Type,
  visited: Set<string> = new Set()
): string {
  // Check for circular references using type ID
  if (type.id && visited.has(type.id)) {
    // Return a placeholder for circular references
    return type.typeName || `<circular:${type.tag}>`;
  }

  // Add current type to visited set if it has an ID
  if (type.id) {
    visited.add(type.id);
  }

  try {
    return typeToStringInternal(type, visited);
  } finally {
    // Remove from visited set when done (for proper cleanup)
    if (type.id) {
      visited.delete(type.id);
    }
  }
}

/**
 * Internal implementation of typeToString with cycle detection
 */
function typeToStringInternal(type: Type, visited: Set<string>): string {
  if (!type) {
    return "unknown";
  }

  /*
  if (type.typeName) {
    if (
      isEnumType(type) &&
      (type.requiredVariantNames ?? type.selectedVariantName)
    ) {
      return `${type.typeName} (${
        type.requiredVariantNames
          ? `${type.requiredVariantNames.map((name) => `.${name}`).join(" | ")} required`
          : `.${type.selectedVariantName} selected`
      })`;
    }

    return type.typeName;
  }
  */

  switch (type.tag) {
    // Primitive types
    case TypeTag.Unit: {
      return "unit";
    }
    case TypeTag.Boolean: {
      return "boolean";
    }
    /*
    case TypeTag.Char: {
      return "char";
    }
    */
    case TypeTag.Usize: {
      return "usize";
    }
    case TypeTag.Isize: {
      return "isize";
    }
    case TypeTag.U8: {
      return "u8";
    }
    case TypeTag.I8: {
      return "i8";
    }
    case TypeTag.U16: {
      return "u16";
    }
    case TypeTag.I16: {
      return "i16";
    }
    case TypeTag.U32: {
      return "u32";
    }
    case TypeTag.I32: {
      return "i32";
    }
    case TypeTag.U64: {
      return "u64";
    }
    case TypeTag.I64: {
      return "i64";
    }
    case TypeTag.F32: {
      return "f32";
    }
    case TypeTag.F64: {
      return "f64";
    }

    // Type universes
    case TypeTag.Type: {
      if ("level" in type && typeof type.level === "number" && type.level > 0) {
        return `Type(${type.level})`;
      }
      return "Type";
    }

    // Complex types
    case TypeTag.Array: {
      return `[${typeToString((type as ArrayType).elementType, visited)}; ${valueToString(
        (type as ArrayType).length
      )}]`;
    }

    case TypeTag.Slice: {
      const sliceType = type as ArrayType;
      return `[${typeToString(sliceType.elementType, visited)}]`;
    }

    case TypeTag.Tuple: {
      if ((type as TupleType).elements.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).elements
        .map((element) => tupleElementToString(element, visited))
        .join(", ")}${(type as TupleType).elements.length === 1 ? "," : ""})`;
    }

    case TypeTag.Struct: {
      const structType = type as StructType;
      if (structType.typeName) {
        return structType.typeName;
      }

      return `${structType.typeName ? `(${structType.typeName}) ` : ""}${structType.isReferenceSemantics ? "object" : "struct"}(${structType.elements.map((element) => tupleElementToString(element, visited)).join(", ")})`;
    }

    case TypeTag.Enum: {
      const enumType = type as EnumType;

      if (enumType.typeName) {
        const enumName = enumType.typeName;

        if (enumType.requiredVariantNames ?? enumType.selectedVariantName) {
          return `${enumName} (${
            enumType.requiredVariantNames
              ? `${enumType.requiredVariantNames.map((name) => `.${name}`).join(" | ")} required`
              : `.${enumType.selectedVariantName} selected`
          })`;
        }

        return enumName;
      }

      return `${
        enumType.typeName ? `(${enumType.typeName}) ` : ""
      }enum(${enumType.variants
        .map((variant) => {
          return `${variant.name}${
            variant.elements
              ? `(${variant.elements.map((element) => tupleElementToString(element, visited)).join(", ")})`
              : ""
          }`;
        })
        .join(", ")})`;
    }

    case TypeTag.Union: {
      const unionType = type as UnionType;
      if (unionType.typeName) {
        return unionType.typeName;
      }

      const elements = unionType.elements;
      return `${unionType.typeName ? `(${unionType.typeName}) ` : ""}${
        unionType.typeName ? "union" : unionType.id
      }(${elements.map((element) => tupleElementToString(element, visited)).join(", ")})`;
    }

    case TypeTag.Module: {
      const moduleType = type as ModuleType;
      let moduleTypeString: string;
      if (moduleType.typeName) {
        moduleTypeString = moduleType.typeName;
      } else {
        moduleTypeString = `${
          moduleType.typeName ? `(${moduleType.typeName}) ` : ""
        }module(${moduleType.elements.map((element) => moduleElementToString(element, visited)).join(", ")})`;
      }

      if (moduleType.subtype) {
        moduleTypeString = `(${typeToString(moduleType.subtype, visited)} <: ${moduleTypeString})`;
      }

      return moduleTypeString;
    }

    case TypeTag.Function: {
      const func = type as FunctionType;
      if (func.typeName) {
        return func.typeName;
      }
      return functionTypeToString(func, visited);
    }
    case TypeTag.Closure: {
      const closureType = type as ClosureType;
      // Format the call type with closure kind
      const callType = closureType.callType;
      return functionTypeToString(callType, visited);
    }

    /*
    case TypeTag.Literal: {
      const literal = type as LiteralType;
      return `${literal.value}:${typeToString(literal.type)}`;
    }
    */

    case TypeTag.SomeType: {
      const someType = type as SomeType;
      if (someType.functionApplication) {
        return exprToString(someType.functionApplication);
      }
      // const parentType = someType.parentType;
      // TODO: Display the interfaces implemented
      return someType.name;
      // return `${someType.name}(${someType.id})`;
      // return `some(${parentType.tag})`;
    }

    case TypeTag.MutPtr: {
      const mutPtrType = type as MutPtrType;
      return `*(${typeToString(mutPtrType.type, visited)})`;
    }

    case TypeTag.Expr: {
      return "Expr";
    }

    case TypeTag.Dyn: {
      const dynType = type as DynType;
      return `Dyn(${dynType.moduleTypes
        .slice(1) // skip the baseModuleType which contains ___dup, ___drop, ___dispose
        .map((mt) => typeToString(mt, visited))
        .join(", ")})`;
    }

    case TypeTag.Future: {
      const futureType = type as FutureType;
      return `Future(${typeToString(futureType.elementType, visited)})`;
    }

    default: {
      return `${type.tag}`;
    }
  }
}

/**
 * Get the target pointer size in bits. Can be customized for different architectures.
 * Default is 64 bits (8 bytes) for modern 64-bit systems.
 */
let targetPointerSizeBits = 64;

/**
 * Set the target pointer size in bits.
 */
export function setTargetPointerSize(bits: number): void {
  if (bits <= 0 || bits % 8 !== 0) {
    throw new Error(
      `Invalid pointer size: ${bits} bits. Must be positive and divisible by 8.`
    );
  }
  targetPointerSizeBits = bits;
}

/**
 * Get the target pointer size in bits.
 */
export function getTargetPointerSizeBits(): number {
  return targetPointerSizeBits;
}

/**
 * Get the target pointer size in bytes.
 */
export function getTargetPointerSizeBytes(): number {
  return targetPointerSizeBits / 8;
}

function getArrayTypeSize(type: ArrayType): number | null {
  const elementSize = getSizeOfType(type.elementType);
  if (elementSize === null) {
    return null; // If the element size is unknown, return null
  }
  if (elementSize === -1) {
    return -1; // If the element size is dynamic, return -1
  }

  const lengthValue = type.length;
  if (isNumberValue(lengthValue)) {
    const length = BigInt(lengthValue.value);
    if (length < 0) {
      throw new Error("Array length cannot be negative");
    }
    return Number(length) * elementSize; // Return total size in bits
  }
  // If the length is not a number, return null to represent an unknown size
  return null;
}

function getTupleTypeSize(type: TupleType): number | null {
  let totalSize = 0;
  for (const element of type.elements) {
    const elementSize = getSizeOfType(element.type);
    if (elementSize === null) {
      return null; // If any element size is unknown, return null
    }
    if (elementSize === -1) {
      return -1; // If any element size is dynamic, return -1
    }
    totalSize += elementSize; // Accumulate the size of each element
  }
  return totalSize; // Return total size in bits
}

function getStructTypeSize(type: StructType): number | null {
  let totalSize = 0;
  for (const element of type.elements) {
    const elementSize = getSizeOfType(element.type);
    if (elementSize === null) {
      return null; // If any element size is unknown, return null
    }
    if (elementSize === -1) {
      return -1; // If any element size is dynamic, return -1
    }
    totalSize += elementSize; // Accumulate the size of each element
  }
  return totalSize; // Return total size in bits
}

function getEnumTypeSize(type: EnumType): number | null {
  let maxSize = 0;
  for (const variant of type.variants) {
    let variantSize: number = 0;
    if (variant.elements) {
      for (const param of variant.elements) {
        const paramSize = getSizeOfType(param.type);
        if (paramSize === null) {
          return null; // If any parameter size is unknown, return null
        }
        if (paramSize === -1) {
          return -1; // If any parameter size is dynamic, return -1
        }
        variantSize += paramSize; // Accumulate the size of each parameter
      }
    }
    maxSize = Math.max(maxSize, variantSize); // Track the maximum size of variants
  }

  const tagSize = Math.ceil(Math.ceil(Math.log2(type.variants.length)) / 8) * 8; // Size of the tag in bits
  return maxSize + tagSize; // Return total size in bits (max variant size + tag size)
}

function getUnionType(type: UnionType): number | null {
  let maxSize = 0;
  for (const element of type.elements) {
    const elementSize = getSizeOfType(element.type);
    if (elementSize === null) {
      return null; // If any element size is unknown, return null
    }
    if (elementSize === -1) {
      return -1; // If any element size is dynamic, return -1
    }
    maxSize = Math.max(maxSize, elementSize); // Find the maximum size among elements
  }
  return maxSize; // Return the maximum size in bits
}

/**
 * Get the alignment of a type in bytes.
 * null = unknown/indeterminate alignment.
 * @param type
 */
export function getAlignmentOfType(type: Type): number | null {
  if (type.isDynamicSized) {
    return null; // Dynamic sized types have unknown alignment
  }
  if (isSomeType(type)) {
    // SomeType is a placeholder, so it has unknown alignment
    return null;
  }

  if (
    isUnitType(type) || // Unit type has no alignment requirement
    isTypeHierarchyType(type) ||
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isComptStringType(type) ||
    isModuleType(type) ||
    isExprType(type) ||
    isExprListType(type) // ^ disallowed in the runtime
  ) {
    return 1; // Minimal alignment for compile-time only types
  } else if (isBooleanType(type)) {
    return 1; // Boolean is 1 byte aligned
  } else if (isUsizeType(type) || isIsizeType(type)) {
    return getTargetPointerSizeBytes(); // Pointer-sized integers are pointer-aligned
  } else if (isU8Type(type) || isI8Type(type)) {
    return 1; // 1 byte aligned
  } else if (isU16Type(type) || isI16Type(type)) {
    return 2; // 2 byte aligned
  } else if (isU32Type(type) || isI32Type(type)) {
    return 4; // 4 byte aligned
  } else if (isU64Type(type) || isI64Type(type)) {
    return 8; // 8 byte aligned
  } else if (isF32Type(type)) {
    return 4; // 4 byte aligned
  } else if (isF64Type(type)) {
    return 8; // 8 byte aligned
  } else if (isArrayType(type)) {
    return getAlignmentOfType(type.elementType); // Array alignment is element alignment
  } else if (isTupleType(type)) {
    // Tuple alignment is the maximum alignment of its elements
    let maxAlign = 1;
    for (const element of type.elements) {
      const elementAlign = getAlignmentOfType(element.type);
      if (elementAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, elementAlign);
    }
    return maxAlign;
  } else if (isStructType(type)) {
    // Check if it's reference semantics - if so, return pointer alignment
    if ((type as StructType).isReferenceSemantics) {
      return getTargetPointerSizeBytes();
    }
    // Struct alignment is the maximum alignment of its elements
    let maxAlign = 1;
    for (const element of type.elements) {
      const elementAlign = getAlignmentOfType(element.type);
      if (elementAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, elementAlign);
    }
    return maxAlign;
  } else if (isEnumType(type)) {
    // Enum alignment is the maximum alignment of its variants
    let maxAlign = 1;
    for (const variant of type.variants) {
      if (variant.elements) {
        for (const param of variant.elements) {
          const paramAlign = getAlignmentOfType(param.type);
          if (paramAlign === null) {
            return null;
          }
          maxAlign = Math.max(maxAlign, paramAlign);
        }
      }
    }
    return maxAlign;
  } else if (isUnionType(type)) {
    // Union alignment is the maximum alignment of its elements
    let maxAlign = 1;
    for (const element of type.elements) {
      const elementAlign = getAlignmentOfType(element.type);
      if (elementAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, elementAlign);
    }
    return maxAlign;
  } else if (isFunctionType(type)) {
    return getTargetPointerSizeBytes(); // Functions are treated as pointers, so pointer-aligned
  } else if (isMutPtrType(type)) {
    return getTargetPointerSizeBytes(); // Pointer and reference types are pointer-aligned
  }

  return null;
}

/**
 *
 *  Get the size of a type in bits.
 *  null = unknown/indeterminate size.
 *  -1   = dynamic/runtime-determined size.
 *  0    = zero size or no runtime size.
 * @param type
 */
export function getSizeOfType(type: Type): number | null {
  if (type.isDynamicSized) {
    return -1; // Dynamic sized types have size -1
    // eg, Slice, Void, Dyn
  }
  if (isSomeType(type)) {
    // SomeType is a placeholder, so it has unknown size
    return null;
  }

  if (
    isUnitType(type) || // Unit type has no size
    isTypeHierarchyType(type) ||
    isComptIntType(type) ||
    isComptFloatType(type) ||
    isComptStringType(type) ||
    isModuleType(type) ||
    isExprType(type) ||
    isExprListType(type) // ^ disallowed in the runtime
  ) {
    return 0;
  } else if (isBooleanType(type)) {
    return 8; // Assuming boolean is represented as 1 byte (8 bits)
  } else if (isUsizeType(type) || isIsizeType(type)) {
    return getTargetPointerSizeBits(); // Pointer size (usually 64 bits)
  } else if (isU8Type(type) || isI8Type(type)) {
    return 8; // 1 byte (8 bits)
  } else if (isU16Type(type) || isI16Type(type)) {
    return 16; // 2 bytes (16 bits)
  } else if (isU32Type(type) || isI32Type(type)) {
    return 32; // 4 bytes (32 bits)
  } else if (isU64Type(type) || isI64Type(type)) {
    return 64; // 8 bytes (64 bits)
  } else if (isF32Type(type)) {
    return 32; // 4 bytes (32 bits)
  } else if (isF64Type(type)) {
    return 64; // 8 bytes (64 bits)
  } else if (isArrayType(type)) {
    return getArrayTypeSize(type);
  } else if (isTupleType(type)) {
    return getTupleTypeSize(type);
  } else if (isStructType(type)) {
    // Check if it's reference semantics - if so, return pointer size
    if ((type as StructType).isReferenceSemantics) {
      return getTargetPointerSizeBits();
    }
    return getStructTypeSize(type);
  } else if (isEnumType(type)) {
    return getEnumTypeSize(type);
  } else if (isUnionType(type)) {
    return getUnionType(type);
  } else if (isFunctionType(type)) {
    return getTargetPointerSizeBits(); // Functions are treated as pointers, so return pointer size
  } else if (isMutPtrType(type)) {
    return getTargetPointerSizeBits(); // Pointer and reference types have pointer size
  }

  return null;
}

export function prohibitDynamicSizedType(type: Type, token: Token): void {
  if (type.isDynamicSized) {
    throw formatErrorMessages([
      {
        token,
        errorMessage: `Cannot use the DST (Dynamic Sized Type) directly:
${typeToString(type)}

Please consider using a pointer or reference to this type instead, like:
&(${typeToString(type)}), *(${typeToString(type)}), etc
`,
      },
    ]);
  }
}

/**
 * Check if a object type could potentially form cycles.
 * This is used to determine which object types need GC tracking.
 *
 * A object can form cycles if:
 * 1. It contains a direct or indirect reference to itself
 * 2. It references other object types that could reference back to it
 *
 * This uses a depth-first search with cycle detection to avoid infinite recursion.
 */
export function canRefStructFormCycles(
  type: StructType,
  visitedTypes = new Set<string>()
): boolean {
  // Only objects can form cycles through reference counting
  if (!type.isReferenceSemantics) {
    return false;
  }

  // Avoid infinite recursion by tracking visited types
  if (visitedTypes.has(type.id)) {
    return true; // We found a cycle back to a type we're already analyzing
  }

  visitedTypes.add(type.id);

  try {
    // Check all fields in the struct
    for (const element of type.elements) {
      if (typeCanReferenceCyclicRefStruct(element.type, type, visitedTypes)) {
        return true;
      }
    }

    return false;
  } finally {
    visitedTypes.delete(type.id); // Clean up for other paths
  }
}

/**
 * Helper function to check if a type can reference back to a cyclic object.
 * This traverses through containers (enums, arrays, etc.) to find object references.
 */
function typeCanReferenceCyclicRefStruct(
  type: Type,
  originalRefStruct: StructType,
  visitedTypes: Set<string>
): boolean {
  // If this type is the same as the original object, we have a direct self-reference
  if (isStructType(type) && type.id === originalRefStruct.id) {
    return true;
  }

  // If this is a different object, check if it could form cycles with the original
  if (isStructType(type) && type.isReferenceSemantics) {
    return canRefStructFormCycles(type, new Set(visitedTypes));
  }

  // Check through enum variants
  if (isEnumType(type)) {
    for (const variant of type.variants) {
      if (variant.elements) {
        for (const element of variant.elements) {
          if (
            typeCanReferenceCyclicRefStruct(
              element.type,
              originalRefStruct,
              visitedTypes
            )
          ) {
            return true;
          }
        }
      }
    }
  }

  // Check through arrays
  if (isArrayType(type)) {
    return typeCanReferenceCyclicRefStruct(
      type.elementType,
      originalRefStruct,
      visitedTypes
    );
  }

  // Check through slices
  if (isSliceType(type)) {
    return typeCanReferenceCyclicRefStruct(
      (type as SliceType).elementType,
      originalRefStruct,
      visitedTypes
    );
  }

  // Check through tuples
  if (isTupleType(type)) {
    for (const element of type.elements) {
      if (
        typeCanReferenceCyclicRefStruct(
          element.type,
          originalRefStruct,
          visitedTypes
        )
      ) {
        return true;
      }
    }
  }

  // Check through unions
  if (isUnionType(type)) {
    for (const element of type.elements) {
      if (
        typeCanReferenceCyclicRefStruct(
          element.type,
          originalRefStruct,
          visitedTypes
        )
      ) {
        return true;
      }
    }
  }

  // Check through closures - they can capture object types
  if (isClosureType(type)) {
    return true;
  }

  // Check through dynamic types - they can contain object types
  if (isDynType(type)) {
    return true;
  }

  // MutPtr and MutRef are raw pointers/references - they don't participate in ARC
  // so they don't form reference counting cycles.
  if (isMutPtrType(type)) {
    return false;
  }

  // Other types (primitives, functions, etc.) cannot form cycles
  return false;
}

/**
 * This function will replace the SomeType with the resolved type from the environment.
 * The resolved type has to be a concrete type (not SomeType).
 * If it cannot be resolved, we throw error.
 * @param type
 * @param env
 */
export function resolveSomeTypeInType(
  type: Type,
  env: Environment,
  checkedTypes: Set<Type> = new Set()
): Type {
  if (checkedTypes.has(type)) {
    return type;
  }

  if (isSomeType(type)) {
    const typeName = type.name;
    const variables = getVariablesFromEnv(env, typeName);
    const variable = variables[variables.length - 1];
    if (!variable) {
      throw new Error(`Unresolved SomeType: ${typeName}`);
    } else if (!isTypeValue(variable.value)) {
      throw new Error(`Variable is not a type: ${typeName}`);
    } else {
      const resolvedType = variable.value.value;
      checkedTypes.add(type);
      return resolveSomeTypeInType(resolvedType, env);
    }
  } else if (isStructType(type)) {
    // To prevent circular reference issues
    /// if (isObjectType(type)) {
    ///   return type;
    /// }
    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: resolveSomeTypeInType(element.type, env),
      };
    });
  } else if (isEnumType(type)) {
    type.variants = type.variants.map((variant) => {
      if (variant.elements) {
        variant.elements = variant.elements.map((param) => {
          return {
            ...param,
            type: resolveSomeTypeInType(param.type, env),
          };
        });
      }
      return variant;
    });
  } else if (isUnionType(type)) {
    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: resolveSomeTypeInType(element.type, env),
      };
    });
  } else if (isArrayType(type)) {
    type.elementType = resolveSomeTypeInType(type.elementType, env);
  } else if (isSliceType(type)) {
    type.elementType = resolveSomeTypeInType(type.elementType, env);
  } else if (isTupleType(type)) {
    type.elements = type.elements.map((element) => {
      return {
        ...element,
        type: resolveSomeTypeInType(element.type, env),
      };
    });
  } else if (isMutPtrType(type)) {
    type.type = resolveSomeTypeInType(type.type, env);
  } else if (isFunctionType(type)) {
    type.parameters = type.parameters.map((param) => {
      return {
        ...param,
        type: resolveSomeTypeInType(param.type, env),
      };
    });
    type.return.type = resolveSomeTypeInType(type.return.type, env);
    type.implicitParameters = type.implicitParameters.map((param) => {
      return {
        ...param,
        type: resolveSomeTypeInType(param.type, env),
      };
    });
    type.forallParameters = type.forallParameters.map((param) => {
      return {
        ...param,
        type: resolveSomeTypeInType(param.type, env),
      };
    });
  } else if (isClosureType(type)) {
    type.callType = resolveSomeTypeInType(
      type.callType,
      env
    ) as FunctionType & { isClosure: true };
  }

  checkedTypes.add(type);
  return type;
}
