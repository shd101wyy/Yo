import { Environment, getVariablesFromEnv } from "../env";
import { exprToString } from "../expr";
import { TypeValue } from "../type-value";
import { valueToString } from "../value";
import { ValueTag } from "../value-tag";
import { createF64Type, createI32Type } from "./creators";
import {
  ArrayType,
  EnumType,
  FunctionParameter,
  FunctionType,
  LiteralType,
  ModuleElement,
  ModuleType,
  MutPtrType,
  MutRefType,
  PtrType,
  RefType,
  SomeType,
  StructType,
  TupleElement,
  TupleType,
  Type,
  UnionType,
} from "./definitions";
import {
  isArrayType,
  isComptFloatType,
  isComptIntType,
  isComptStringType,
  isEnumType,
  isExprListType,
  isExprType,
  isFloatType,
  isIntegerType,
  isModuleType,
  isMutRefType,
  isRefType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
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

/**
 * Check if a type contains reference types.
 */
export function typeContainsReference(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Check if the type is a reference type
  if (isRefType(type) || isMutRefType(type)) {
    return true;
  }

  // Recursively check for references in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsReference((type as ArrayType).elementType);
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) => typeContainsReference(param.type))
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    case TypeTag.Module:
      return (type as ModuleType).elements.some((element) =>
        typeContainsReference(element.type)
      );
    default:
      return false; // For other types, no references are present
  }
}

/**
 * Check if a type contains SomeType.
 */
export function typeContainsSomeType(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Check if the type is a SomeType
  if (isSomeType(type)) {
    return true;
  }

  // Recursively check for SomeType in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsSomeType((type as ArrayType).elementType);
    case TypeTag.Tuple:
      return (type as TupleType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    case TypeTag.Struct:
      return (type as StructType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.elements?.some((param) => typeContainsSomeType(param.type))
      );
    case TypeTag.Union:
      return (type as UnionType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    case TypeTag.Module:
      return (type as ModuleType).elements.some((element) =>
        typeContainsSomeType(element.type)
      );
    default:
      return false; // For other types, no SomeType is present
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
export function convertComptTypeToRuntimeType(type: Type): Type {
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
  } else {
    // No change
    return type;
  }
}

/**
 * Set a type as linear.
 */
export function setTypeAsLinear(type: Type): Type {
  return {
    ...type,
    forceLinear: true,
  };
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
      return 64; // Platform dependent, simplified to 64-bit
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
  parameter: FunctionParameter
): string {
  let label = parameter.label;
  if (parameter.isMutable) {
    label = `mut(${label})`;
  }
  if (parameter.isQuote) {
    label = `quote(${label})`;
  } else if (parameter.isCompileTimeOnly) {
    label = `compt(${label})`;
  }

  const typeStr = typeToString(parameter.type);

  const defaultValueStr = parameter.exprs.defaultValueExpr
    ? exprToString(parameter.exprs.defaultValueExpr)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeStr}) ?= ${defaultValueStr}`;
  } else {
    // typeStr is always defined here
    return `${label}: ${typeStr}`;
  }
}
/**
 * Convert a tuple element to string representation.
 * NOTE: Don't use element.exprs
 */
export function tupleElementToString(element: TupleElement): string {
  let label = element.label;
  if (element.isImplicit) {
    label = `?${label}`;
  }
  if (element.isCompileTimeOnly) {
    label = `@(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeToString(element.type)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label}: ${typeToString(element.type)}) = ${assignedValueStr}`;
  }

  return `${label}: ${typeToString(element.type)}`;
}

/**
 * Convert a module element to string representation.
 */
function moduleElementToString(element: ModuleElement): string {
  let label = element.label;
  if (element.isImplicit) {
    label = `?${label}`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label}: ${typeToString(element.type)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label}: ${typeToString(element.type)}) = ${assignedValueStr}`;
  }

  return `${label}: ${typeToString(element.type)}`;
}

/**
 * Convert a Type object to a human-readable string representation.
 */
export function typeToString(type: Type): string {
  if (!type) {
    return "unknown";
  }

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

  switch (type.tag) {
    // Primitive types
    case TypeTag.Unit: {
      return "unit";
    }
    case TypeTag.Boolean: {
      return "boolean";
    }
    case TypeTag.Char: {
      return "char";
    }
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
    case TypeTag.Free: {
      return "Free";
    }
    case TypeTag.Linear: {
      return "Linear";
    }
    case TypeTag.Type: {
      if ("level" in type && typeof type.level === "number" && type.level > 0) {
        return `Type(${type.level})`;
      }
      return "Type";
    }

    // Complex types
    case TypeTag.Array: {
      return `Array(${typeToString((type as ArrayType).elementType)}, ${valueToString(
        (type as ArrayType).length
      )})`;
    }

    case TypeTag.Tuple: {
      if ((type as TupleType).elements.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).elements
        .map(tupleElementToString)
        .join(", ")}${(type as TupleType).elements.length === 1 ? "," : ""})`;
    }

    case TypeTag.Struct: {
      const structType = type as StructType;
      if (structType.typeName) {
        return structType.typeName;
      }

      return `${structType.typeName ? `(${structType.typeName}) ` : ""}${
        structType.typeName ? "struct" : structType.typeId
      }(${structType.elements.map(tupleElementToString).join(", ")})`;
    }

    case TypeTag.Enum: {
      const enumType = type as EnumType;
      if (enumType.typeName) {
        return enumType.typeName;
      }

      return `${
        enumType.typeName ? `(${enumType.typeName}) ` : ""
      }enum(${enumType.variants
        .map((variant) => {
          return `${variant.name}${
            variant.elements
              ? `(${variant.elements.map(tupleElementToString).join(", ")})`
              : ""
          }`;
        })
        .join(", ")})`;
    }

    case TypeTag.Union: {
      const unionType = type as UnionType;
      const elements = unionType.elements;
      return `${unionType.typeName ? `(${unionType.typeName}) ` : ""}${
        unionType.typeName ? "union" : unionType.typeId
      }(${elements.map(tupleElementToString).join(", ")})`;
    }

    case TypeTag.Module: {
      const moduleType = type as ModuleType;
      return `${
        moduleType.typeName ? `(${moduleType.typeName}) ` : ""
      }module(${moduleType.elements.map(moduleElementToString).join(", ")})`;
    }

    case TypeTag.Function: {
      const func = type as FunctionType;
      const params = func.parameters.map(functionParameterToString).join(", ");

      const typeParams =
        func.typeParameters.length > 0
          ? `forall(${func.typeParameters
              .map(functionParameterToString)
              .join(", ")})`
          : "";
      const implicitParams =
        func.implicitParameters.length > 0
          ? `implicit(${func.implicitParameters
              .map(functionParameterToString)
              .join(", ")})`
          : "";

      let returnTypeString = typeToString(func.return.type);
      if (func.return.isUnquote) {
        returnTypeString = `unquote(${returnTypeString})`;
      } else if (func.return.isCompileTimeOnly) {
        returnTypeString = `compt(${returnTypeString})`;
      }

      const paramsString = [typeParams, params, implicitParams]
        .filter((x) => !!x)
        .join(", ");
      const from = func.SelfType?.typeName ?? func.ModuleType?.typeName;
      return `${from ? `(${from}) ` : ""}(${paramsString}) -> ${returnTypeString}`;
    }

    case TypeTag.Literal: {
      const literal = type as LiteralType;
      return `${literal.value}:${typeToString(literal.type)}`;
    }

    case TypeTag.SomeType: {
      const someType = type as SomeType;
      // const parentType = someType.parentType;
      // TODO: Display the interfaces implemented
      return someType.name;
      // return `${someType.name}(${someType.typeId})`;
      // return `some(${parentType.tag})`;
    }

    case TypeTag.Ptr: {
      return `*(${typeToString((type as PtrType).type)})`;
    }

    case TypeTag.MutPtr: {
      return `*!(${typeToString((type as MutPtrType).type)})`;
    }

    case TypeTag.Ref: {
      return `&(${typeToString((type as RefType).type)})`;
    }

    case TypeTag.MutRef: {
      return `&!(${typeToString((type as MutRefType).type)})`;
    }

    case TypeTag.Expr: {
      return "Expr";
    }

    default: {
      return `${type.tag}`;
    }
  }
}
