import { Environment, getVariablesFromEnv } from "../env";
import { formatErrorMessages } from "../error";
import { exprToString } from "../expr";
import { stringIsOperator, Token } from "../token";
import { TypeValue } from "../type-value";
import { isNumberValue, valueToString } from "../value";
import { ValueTag } from "../value-tag";
import {
  createF64Type,
  createI32Type,
  createRefType,
  createSliceType,
  createU8Type,
} from "./creators";
import {
  ArrayType,
  EnumType,
  FunctionParameter,
  FunctionType,
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
  isBooleanType,
  isCCompatibleType,
  isCharType,
  isComptFloatType,
  isComptIntType,
  isComptStringType,
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
  isMutRefType,
  isPtrType,
  isRefType,
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

  // Check if the type is a closure type (closures capture variables by reference)
  if (
    isFunctionType(type) &&
    (type as FunctionType).closureKind !== undefined
  ) {
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
        isPtrType(expectedType) && // *(u8) or *(char)
        (isU8Type(expectedType.type) || isCharType(expectedType.type))
      ) {
        return expectedType;
      }
    }

    // Convert the compt_string to &([u8]);
    return createRefType(createSliceType(createU8Type()));
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
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }
  if (element.isImplicit) {
    label = `implicit(${label})`;
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
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }
  if (element.isImplicit) {
    label = `implicit(${label})`;
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
      return `[${typeToString((type as ArrayType).elementType)}; ${valueToString(
        (type as ArrayType).length
      )}]`;
    }

    case TypeTag.Slice: {
      const sliceType = type as ArrayType;
      return `[${typeToString(sliceType.elementType)}]`;
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
        structType.typeName ? "struct" : structType.id
      }(${structType.elements.map(tupleElementToString).join(", ")})`;
    }

    case TypeTag.Enum: {
      const enumType = type as EnumType;

      if (enumType.typeName) {
        if (enumType.requiredVariantNames ?? enumType.selectedVariantName) {
          return `${enumType.typeName} (${
            enumType.requiredVariantNames
              ? `${enumType.requiredVariantNames.map((name) => `.${name}`).join(" | ")} required`
              : `.${enumType.selectedVariantName} selected`
          })`;
        }

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
      if (unionType.typeName) {
        return unionType.typeName;
      }

      const elements = unionType.elements;
      return `${unionType.typeName ? `(${unionType.typeName}) ` : ""}${
        unionType.typeName ? "union" : unionType.id
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

      let returnTypeString = typeToString(func.return.type);
      if (func.return.isUnquote) {
        returnTypeString = `unquote(${returnTypeString})`;
      } else if (func.return.isCompileTimeOnly) {
        returnTypeString = `compt(${returnTypeString})`;
      }

      const paramsString = [typeParams, params, variadicParam, implicitParams]
        .filter((x) => !!x)
        .join(", ");
      const from = func.SelfType?.typeName ?? func.ModuleType?.typeName;
      const arrow = func.closureKind !== undefined ? "=>" : "->";
      return `${from ? `(${from}) ` : ""}(${paramsString}) ${arrow} ${returnTypeString}`;
    }

    /*
    case TypeTag.Literal: {
      const literal = type as LiteralType;
      return `${literal.value}:${typeToString(literal.type)}`;
    }
    */

    case TypeTag.SomeType: {
      const someType = type as SomeType;
      // const parentType = someType.parentType;
      // TODO: Display the interfaces implemented
      return someType.name;
      // return `${someType.name}(${someType.id})`;
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

/**
 * Get the size of a pointer in bits.
 */
export function getPtrSize(): null {
  // Assuming a pointer size of 64 bits (8 bytes) for most modern systems
  // return 64;

  return null; // Pointer size is not known at compile time. Let's leave the C Compiler to determine its real size
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
    return getPtrSize(); // Pointer size (usually 64 bits)
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
    return getStructTypeSize(type);
  } else if (isEnumType(type)) {
    return getEnumTypeSize(type);
  } else if (isUnionType(type)) {
    return getUnionType(type);
  } else if (isFunctionType(type)) {
    return getPtrSize(); // Functions are treated as pointers, so return pointer size
  } else if (
    isMutPtrType(type) ||
    isPtrType(type) ||
    isMutRefType(type) ||
    isRefType(type)
  ) {
    return getPtrSize(); // Pointer and reference types have pointer size
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
