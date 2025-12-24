import { Environment, getVariablesFromEnv } from "../env";
import { formatErrorMessages } from "../error";
import { Expr, exprToString } from "../expr";
import { stringIsOperator, Token } from "../token";
import { TypeValue } from "../type-value";
import {
  isModuleValue,
  isNumberValue,
  isTypeValue,
  isUnknownValue,
  ModuleValue,
  valueToString,
} from "../value";
import { ValueTag } from "../value-tag";
import { areTypesCompatible } from "./compatibility";
import {
  createF64Type,
  createI32Type,
  createSliceType,
  createU8Type,
} from "./creators";
import {
  ArrayType,
  ComptListType,
  DynType,
  EnumType,
  FnModuleType,
  FunctionParameter,
  FunctionType,
  FutureModuleType,
  IsoType,
  ModuleField,
  ModuleType,
  PtrType,
  SomeType,
  StructType,
  TupleType,
  Type,
  TypeField,
  UnionType,
} from "./definitions";
import {
  isArrayType,
  isBooleanType,
  isCCompatibleType,
  isCharType,
  isComptFloatType,
  isComptIntType,
  isComptListType,
  isComptStringType,
  isDynType,
  isEnumType,
  isExprType,
  isF32Type,
  isF64Type,
  isFloatType,
  isFnModuleType,
  isFunctionType,
  isFutureModuleType,
  isGcType,
  isI16Type,
  isI32Type,
  isI64Type,
  isI8Type,
  isIntegerType,
  isIsizeType,
  isModuleType,
  isObjectType,
  isPtrType,
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
  isVoidType,
} from "./guards";
import { TypeTag } from "./tags";

/**
 * Get a module type from the environment by name (e.g., "Copy", "Send").
 * Returns undefined if not found.
 */
export function getModuleTypeFromEnv(
  env: Environment,
  moduleName: string
): ModuleType | undefined {
  const variables = getVariablesFromEnv(env, moduleName);
  if (variables.length === 0) {
    return undefined;
  }
  const variable = variables[variables.length - 1]!;
  if (variable.value && isTypeValue(variable.value)) {
    const typeValue = variable.value as TypeValue;
    if (isModuleType(typeValue.value)) {
      return typeValue.value;
    }
  }
  return undefined;
}

/**
 * Check if a type implements a specific module.
 * This is the core implementation used by typeImplementsCopy and typeImplementsSend.
 */
export function typeImplementsModuleInternal({
  targetType,
  moduleType,
  env,
}: {
  targetType: Type;
  moduleType: ModuleType;
  env: Environment;
}): boolean {
  const expectedModuleWithReceiver: ModuleType = {
    ...moduleType,
    receiverType: targetType,
  };

  const targetModule = targetType.module;
  if (targetModule) {
    for (const field of targetModule.fields) {
      if (!field.assignedValue || !isModuleValue(field.assignedValue)) {
        continue;
      }

      const fieldModuleValue = field.assignedValue as ModuleValue;
      const fieldModuleType = fieldModuleValue.type;

      if (
        areTypesCompatible(
          { type: expectedModuleWithReceiver, env },
          { type: fieldModuleType, env }
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a type implements the Copy trait.
 *
 * Copy types can be implicitly duplicated without consuming the original.
 * Primitives (i32, boolean, etc.), pointers (*T), and structs where all fields are Copy
 * implement Copy.
 */
/*
export function typeImplementsCopy(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  const copyModuleType = getModuleTypeFromEnv(env, "Copy");
  if (!copyModuleType) {
    return false;
  }

  return typeImplementsModuleInternal({
    targetType: type,
    moduleType: copyModuleType,
    env,
  });
}
*/

/**
 * Check if a type implements the Send trait.
 *
 * Send types can be safely transferred between threads.
 * Primitives, Send pointers (where T is not Gc and T implements Send),
 * and structs where all fields are Send implement Send.
 */
export function typeImplementsSend(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  const sendModuleType = getModuleTypeFromEnv(env, "Send");
  if (!sendModuleType) {
    return false;
  }

  return typeImplementsModuleInternal({
    targetType: type,
    moduleType: sendModuleType,
    env,
  });
}

export function typeImplementsFn(
  type: Type | undefined
): type is (SomeType | DynType) & { isFn: true } {
  if (!type) {
    return false;
  }

  // Check requiredModules for SomeType and DynType (e.g., Impl(Fn(...)) or Dyn(Fn(...)))
  if (isSomeType(type) || isDynType(type)) {
    const requiredModules = (type as SomeType | DynType).requiredModules;
    if (requiredModules) {
      for (const moduleType of requiredModules) {
        if (isFnModuleType(moduleType)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract FnModuleType from a type (e.g., from Impl(Fn(...) -> ...) or Dyn(Fn(...) -> ...) or FnModuleType directly)
 * Returns the FnModuleType if found, otherwise undefined.
 */
export function extractFnModuleFromType(type: Type): FnModuleType | undefined {
  // If the type is already a FnModuleType, return it directly
  if (isFnModuleType(type)) {
    return type;
  }

  // Check requiredModules for SomeType and DynType
  if (isSomeType(type) || isDynType(type)) {
    const requiredModules = (type as SomeType | DynType).requiredModules;
    if (requiredModules) {
      for (const moduleType of requiredModules) {
        if (isFnModuleType(moduleType)) {
          return moduleType;
        }
      }
    }
  }

  return undefined;
}

export function typeImplementsFuture(
  type: Type | undefined
): type is (SomeType | DynType) & { isFuture: true } {
  if (!type) {
    return false;
  }

  // Check requiredModules for SomeType and DynType (e.g., Impl(Fn(...)) or Dyn(Fn(...)))
  if (isSomeType(type) || isDynType(type)) {
    const requiredModules = (type as SomeType | DynType).requiredModules;
    if (requiredModules) {
      for (const moduleType of requiredModules) {
        if (isFutureModuleType(moduleType)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract FutureModuleType from a type (e.g., from Impl(Future(T)) or Dyn(Future(T)) or FutureModuleType directly)
 * Returns the FutureModuleType if found, otherwise undefined.
 */
export function extractFutureModuleFromType(
  type: Type
): FutureModuleType | undefined {
  // If the type is already a FutureModuleType, return it directly
  if (isFutureModuleType(type)) {
    return type;
  }

  // Check requiredModules for SomeType and DynType
  if (isSomeType(type) || isDynType(type)) {
    const requiredModules = (type as SomeType | DynType).requiredModules;
    if (requiredModules) {
      for (const moduleType of requiredModules) {
        if (isFutureModuleType(moduleType)) {
          return moduleType;
        }
      }
    }
  }

  return undefined;
}

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
    isComptListType(type) ||
    isExprType(type)
  );
}

export function typeProhibitsComptModifier(type?: Type): boolean {
  return isCCompatibleType(type);
}

/**
 * Check if the type contains `object` or `Dyn`
 * @param type
 */
export function typeContainsGcType(
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

  if (isGcType(type)) {
    return true;
  }

  // Recursively check in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsGcType((type as ArrayType).childType, checkedTypes);
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsGcType(field.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsGcType(field.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some((field) =>
        typeContainsGcType(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsGcType(param.type, checkedTypes)
        )
      );
    case TypeTag.Iso:
      // Iso itself is GC type (atomic RC), check inner type
      return typeContainsGcType((type as IsoType).childType, checkedTypes);
    case TypeTag.Module:
      return false; // Modules do not own references
    case TypeTag.Function: {
      return false; // Regular functions are not reference types
    }
    case TypeTag.SomeType: {
      const someType = type as SomeType;
      if (typeImplementsFuture(someType)) {
        return true; // All Future types are reference counted
      }
      if (someType.resolvedConcreteType) {
        return typeContainsGcType(someType.resolvedConcreteType, checkedTypes);
      } else {
        // Conservatively return true because we don't know at
        return true;
      }
    }
    // case TypeTag.SomeType: { // NOTE: SomeType is now handled in isGcType
    //   // SomeType conservatively returns true because we don't know at
    //   // generation time whether the concrete type will contain GC types.
    //   // This ensures Box(SomeType_V) generates proper ___dispose code.
    //   return true;
    // }
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
    // If it's an extern type, it's concrete at codegen time, so don't count it
    // eg:
    //
    //    extern("yo", YO_THREAD_SYNC_TYPE: Type);
    //
    // YO_THREAD_SYNC_TYPE is SomeType but concrete
    if (type.isExtern) {
      return false;
    }

    if (type.resolvedConcreteType) {
      return typeContainsSomeType(type.resolvedConcreteType, checkedTypes);
    }

    {
      // FIXME: The check here is essentially wrong

      // Treat Impl(Fn(...)) as concrete at codegen time.
      // Codegen lowers such SomeType to the corresponding FnModuleType.
      if (typeImplementsFn(type)) {
        return false;
      }

      // Treat Impl(Future(...)) as concrete at codegen time.
      // Codegen generates state machine structs for Futures.
      if (typeImplementsFuture(type)) {
        return false;
      }
    }

    return true;
  }

  // Recursively check for SomeType in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsSomeType((type as ArrayType).childType, checkedTypes);
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsSomeType(field.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some((field) =>
        typeContainsSomeType(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsSomeType(param.type, checkedTypes)
        )
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsSomeType(field.type, checkedTypes)
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
      return (type as ModuleType).fields.some((field) =>
        typeContainsSomeType(field.type, checkedTypes)
      );
    case TypeTag.Ptr:
      return typeContainsSomeType((type as PtrType).childType, checkedTypes);

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
  const visited = new Set<Type>();

  function helper(t: Type) {
    // Prevent infinite recursion on circular/self-referential types
    if (t && visited.has(t)) {
      return;
    }

    if (t) {
      visited.add(t);
    }

    if (isSomeType(t)) {
      if (result.has(t)) {
        return; // Already checked
      }
      if (!t.resolvedConcreteType) {
        result.add(t);
      }
    }

    switch (t.tag) {
      case TypeTag.Array:
        helper((t as ArrayType).childType);
        break;
      case TypeTag.Tuple:
        (t as TupleType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Struct:
        (t as StructType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Enum:
        (t as EnumType).variants.forEach((variant) => {
          variant.fields?.forEach((param) => helper(param.type));
        });
        break;
      case TypeTag.Union:
        (t as UnionType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Module:
        (t as ModuleType).fields.forEach((field) => helper(field.type));
        break;
      case TypeTag.Ptr:
        helper((t as PtrType).childType);
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
        typeRequiresInference(arrayType.childType)
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
    case TypeTag.Ptr:
      return typeRequiresInference((type as PtrType).type);
    case TypeTag.Gc:
      return typeRequiresInference((type as RefType).type);
    case TypeTag.MutRef:
      return typeRequiresInference((type as MutRefType).type);
    */
    case TypeTag.SomeType:
      // SomeType represents unknown/inferable types
      return true;
    case TypeTag.Module: {
      // For FnModuleType, check if the function signature requires inference
      const moduleType = type as ModuleType;
      if (moduleType.isFn) {
        return typeRequiresInference(moduleType.isFn.callType);
      }
      return false;
    }
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
  // Track visited SomeTypes to detect cycles (e.g., A -> B -> A)
  const visited = new Set<SomeType>();

  do {
    // If we've already visited this SomeType, we have a cycle - return it as-is
    if (visited.has(someType)) {
      return someType;
    }
    visited.add(someType);

    const variables = getVariablesFromEnv(env, someType.name, (variable) => {
      return variable.value?.tag === ValueTag.Type;
      // cannot use "isTypeValue" function here due to circular dependency
    });
    if (!variables.length) {
      // NOTE: This might be SomeType defined from "forall"
      // So it doesn't exist in the env.
      return someType; // Return itself
    }

    someTypeValue = variables[variables.length - 1]!.value as TypeValue;

    // If the resolved value is the same object as current someType, return it
    if (someTypeValue.value === someType) {
      return someType;
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
 * If expr is provided and a conversion happens, sets expr.$.convertedRuntimeType
 */
export function convertComptTypeToRuntimeType({
  type,
  expectedType,
  expr,
  env,
}: {
  type: Type;
  expectedType?: Type;
  expr?: Expr;
  env: Environment;
}): Type {
  let convertedType: Type | undefined;

  if (isComptIntType(type)) {
    convertedType = createI32Type();
  } else if (isComptFloatType(type)) {
    convertedType = createF64Type();
  } else if (isArrayType(type)) {
    type.childType = convertComptTypeToRuntimeType({
      type: type.childType,
      expectedType: undefined,
      expr: undefined,
      env,
    });
    return type;
  } else if (isTupleType(type)) {
    type.fields = type.fields.map((field) => {
      return {
        ...field,
        type: convertComptTypeToRuntimeType({
          type: field.type,
          expectedType: undefined,
          expr: undefined,
          env,
        }),
      };
    });
    return type;
  } else if (isStructType(type)) {
    // To prevent circular reference issues
    if (isObjectType(type)) {
      return type;
    }

    type.fields = type.fields.map((field) => {
      return {
        ...field,
        type: convertComptTypeToRuntimeType({
          type: field.type,
          expectedType: undefined,
          expr: undefined,
          env,
        }),
      };
    });
    return type;
  } else if (isEnumType(type)) {
    type.variants = type.variants.map((variant) => {
      if (variant.fields) {
        variant.fields = variant.fields.map((param) => {
          return {
            ...param,
            type: convertComptTypeToRuntimeType({
              type: param.type,
              expectedType: undefined,
              expr: undefined,
              env,
            }),
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
        (isU8Type(expectedType.childType) || isCharType(expectedType.childType))
      ) {
        convertedType = expectedType;
      } else if (isSliceType(expectedType)) {
        // [u8] in Yo is a fat pointer (the slice value itself)
        convertedType = expectedType;
      }
    }

    if (!convertedType) {
      // Default: Convert the compt_string to [u8]
      convertedType = createSliceType(createU8Type());
    }
  } else {
    // No change
    return type;
  }

  // If we have a converted type and an expr, store the conversion info
  if (convertedType && expr?.$) {
    expr.$.convertedRuntimeType = convertedType;
  }

  return convertedType ?? type;
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
export function tupleFieldToString(
  element: TypeField,
  visited: Set<string> = new Set()
): string {
  let label = element.label;
  if (stringIsOperator(label)) {
    label = `(${label})`;
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
  element: ModuleField,
  visited: Set<string> = new Set()
): string {
  let label = element.label;
  if (stringIsOperator(label)) {
    label = `(${label})`;
  }

  const defaultValueStr = element.defaultValue
    ? valueToString(element.defaultValue)
    : "";

  const assignedValueStr = element.assignedValue
    ? valueToString(element.assignedValue)
    : "";

  if (defaultValueStr) {
    return `(${label} : ${typeToString(element.type, visited)}) ?= ${defaultValueStr}`;
  }

  if (assignedValueStr) {
    return `(${label} : ${typeToString(element.type, visited)}) = ${assignedValueStr}`;
  }

  return `${label} : ${typeToString(element.type, visited)}`;
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

  const paramsString = [typeParams, params, variadicParam]
    .filter((x) => !!x)
    .join(", ");
  const from = func.SelfType?.typeName;
  const fnKind = "fn";
  return `${from ? `(${from}) ` : ""}${fnKind}(${paramsString}) -> ${returnString}`;
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
    case TypeTag.Bool: {
      return "bool";
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
      return `[${typeToString((type as ArrayType).childType, visited)}; ${valueToString(
        (type as ArrayType).length
      )}]`;
    }

    case TypeTag.Slice: {
      const sliceType = type as ArrayType;
      return `[${typeToString(sliceType.childType, visited)}]`;
    }

    case TypeTag.Tuple: {
      if ((type as TupleType).fields.length === 0) {
        return "()";
      }
      return `(${(type as TupleType).fields
        .map((element) => tupleFieldToString(element, visited))
        .join(", ")}${(type as TupleType).fields.length === 1 ? "," : ""})`;
    }

    case TypeTag.Struct: {
      const structType = type as StructType;
      if (structType.typeName) {
        return structType.typeName;
      }

      return `${structType.typeName ? `(${structType.typeName}) ` : ""}${structType.isReferenceSemantics ? "object" : structType.isNewtype ? "newtype" : "struct"}(${structType.fields.map((field) => tupleFieldToString(field, visited)).join(", ")})`;
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
            variant.fields
              ? `(${variant.fields.map((field) => tupleFieldToString(field, visited)).join(", ")})`
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

      const fields = unionType.fields;
      return `${unionType.typeName ? `(${unionType.typeName}) ` : ""}${
        unionType.typeName ? "union" : unionType.id
      }(${fields.map((field) => tupleFieldToString(field, visited)).join(", ")})`;
    }

    case TypeTag.Module: {
      const moduleType = type as ModuleType;

      // Check if it's a FnModuleType (closure/function module)
      if (isFnModuleType(moduleType)) {
        // Display as Fn(...) -> ReturnType
        return `Fn${functionTypeToString(moduleType.isFn.callType, visited).slice(2)}`; // Remove "fn" prefix and add "Fn"
      }

      // Check if it's a FutureModuleType
      if (isFutureModuleType(moduleType)) {
        return `Future(${typeToString(moduleType.isFuture.outputType, visited)})`;
      }

      let moduleTypeString: string;
      if (moduleType.typeName) {
        moduleTypeString = moduleType.typeName;
      } else {
        moduleTypeString = `${
          moduleType.typeName ? `(${moduleType.typeName}) ` : ""
        }module(${moduleType.fields.map((field) => moduleElementToString(field, visited)).join(", ")})`;
      }

      if (moduleType.receiverType) {
        moduleTypeString = `(${typeToString(moduleType.receiverType, visited)} <: ${moduleTypeString})`;
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

    case TypeTag.SomeType: {
      const someType = type as SomeType;
      // If typeName is available, use it
      if (someType.typeName) {
        return someType.typeName;
      }
      if (someType.functionApplication) {
        return exprToString(someType.functionApplication);
      }
      // Display as Impl(Module1, Module2, ..., !NegModule1, !NegModule2, ...) with the required and negative modules
      const allModuleStrings: string[] = [];
      if (someType.requiredModules && someType.requiredModules.length > 0) {
        for (const mt of someType.requiredModules) {
          allModuleStrings.push(typeToString(mt, visited));
        }
      }
      if (someType.negativeModules && someType.negativeModules.length > 0) {
        for (const mt of someType.negativeModules) {
          allModuleStrings.push(`!(${typeToString(mt, visited)})`);
        }
      }
      if (allModuleStrings.length > 0) {
        return `${someType.name || "Impl"}(${allModuleStrings.join(", ")})`;
      }
      return someType.name || "Impl()";
    }

    case TypeTag.Ptr: {
      const ptrType = type as PtrType;
      return `*(${typeToString(ptrType.childType, visited)})`;
    }

    case TypeTag.Iso: {
      const isoType = type as IsoType;
      return `Iso(${typeToString(isoType.childType, visited)})`;
    }

    case TypeTag.Expr: {
      return "Expr";
    }

    case TypeTag.ComptList: {
      return `ComptList(${typeToString((type as ComptListType).childType)})`;
    }

    case TypeTag.Dyn: {
      const dynType = type as DynType;
      // If typeName is available, use it
      if (dynType.typeName) {
        return dynType.typeName;
      }
      // Display as Dyn(Module1, Module2, ..., !NegModule1, !NegModule2, ...) with the required and negative modules
      const allModuleStrings: string[] = [];
      for (const mt of dynType.requiredModules) {
        allModuleStrings.push(typeToString(mt, visited));
      }
      if (dynType.negativeModules && dynType.negativeModules.length > 0) {
        for (const mt of dynType.negativeModules) {
          allModuleStrings.push(`!(${typeToString(mt, visited)})`);
        }
      }
      return `Dyn(${allModuleStrings /*.slice(1)*/
        .join(", ")})`;
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
  const elementSize = getSizeOfType(type.childType);
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
  for (const field of type.fields) {
    const fieldSize = getSizeOfType(field.type);
    if (fieldSize === null) {
      return null; // If any field size is unknown, return null
    }
    if (fieldSize === -1) {
      return -1; // If any field size is dynamic, return -1
    }
    totalSize += fieldSize; // Accumulate the size of each field
  }
  return totalSize; // Return total size in bits
}

function getStructTypeSize(type: StructType): number | null {
  let totalSize = 0;
  for (const field of type.fields) {
    const fieldSize = getSizeOfType(field.type);
    if (fieldSize === null) {
      return null; // If any field size is unknown, return null
    }
    if (fieldSize === -1) {
      return -1; // If any field size is dynamic, return -1
    }
    totalSize += fieldSize; // Accumulate the size of each field
  }
  return totalSize; // Return total size in bits
}

function getEnumTypeSize(type: EnumType): number | null {
  let maxSize = 0;
  let maxAlignment = 0;

  for (const variant of type.variants) {
    let variantSize: number = 0;
    if (variant.fields) {
      for (const field of variant.fields) {
        const fieldSize = getSizeOfType(field.type);
        if (fieldSize === null) {
          return null; // If any parameter size is unknown, return null
        }
        if (fieldSize === -1) {
          return -1; // If any parameter size is dynamic, return -1
        }
        variantSize += fieldSize; // Accumulate the size of each parameter

        // Track maximum alignment requirement
        const fieldAlignment = getAlignmentOfType(field.type);
        if (fieldAlignment === null) {
          return null;
        }
        maxAlignment = Math.max(maxAlignment, fieldAlignment * 8); // Convert bytes to bits
      }
    }
    maxSize = Math.max(maxSize, variantSize); // Track the maximum size of variants
  }

  const tagSize = Math.ceil(Math.ceil(Math.log2(type.variants.length)) / 8) * 8; // Size of the tag in bits
  const tagAlignment = 32; // Tag is typically int (4 bytes = 32 bits)

  // The union must be aligned to its largest member's alignment
  const dataAlignment = Math.max(maxAlignment, 8); // At least 1 byte alignment

  // Calculate total size with proper alignment:
  // 1. Tag takes tagSize bits
  // 2. Padding after tag to align data to dataAlignment
  // 3. Data takes maxSize bits
  // 4. Final struct alignment to the largest alignment requirement

  const structAlignment = Math.max(tagAlignment, dataAlignment);

  // Align tag end to data alignment
  const tagSizeBytes = tagSize / 8;
  const dataAlignmentBytes = dataAlignment / 8;
  const paddingAfterTag =
    ((dataAlignmentBytes - (tagSizeBytes % dataAlignmentBytes)) %
      dataAlignmentBytes) *
    8;

  const totalBeforeAlignment = tagSize + paddingAfterTag + maxSize;

  // Align total size to struct alignment
  const totalBytes = totalBeforeAlignment / 8;
  const structAlignmentBytes = structAlignment / 8;
  const finalPadding =
    ((structAlignmentBytes - (totalBytes % structAlignmentBytes)) %
      structAlignmentBytes) *
    8;

  return totalBeforeAlignment + finalPadding; // Return total size in bits
}

function getUnionType(type: UnionType): number | null {
  let maxSize = 0;
  for (const field of type.fields) {
    const fieldSize = getSizeOfType(field.type);
    if (fieldSize === null) {
      return null; // If any field size is unknown, return null
    }
    if (fieldSize === -1) {
      return -1; // If any field size is dynamic, return -1
    }
    maxSize = Math.max(maxSize, fieldSize); // Find the maximum size among elements
  }
  return maxSize; // Return the maximum size in bits
}

/**
 * Get the alignment of a type in bytes.
 * null = unknown/indeterminate alignment.
 * @param type
 */
export function getAlignmentOfType(type: Type): number | null {
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
    isComptListType(type) ||
    isModuleType(type) ||
    isExprType(type) // ^ disallowed in the runtime
  ) {
    return 1; // Minimal alignment for compile-time only types
  } else if (isBooleanType(type)) {
    return 1; // Bool is 1 byte aligned
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
    return getAlignmentOfType(type.childType); // Array alignment is element alignment
  } else if (isTupleType(type)) {
    // Tuple alignment is the maximum alignment of its fields
    let maxAlign = 1;
    for (const field of type.fields) {
      const fieldAlign = getAlignmentOfType(field.type);
      if (fieldAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, fieldAlign);
    }
    return maxAlign;
  } else if (isStructType(type)) {
    // Check if it's reference semantics - if so, return pointer alignment
    if (type.isReferenceSemantics) {
      return getTargetPointerSizeBytes();
    }
    if (type.isNewtype) {
      return getAlignmentOfType(type.fields[0]!.type);
    }
    // Struct alignment is the maximum alignment of its fields
    let maxAlign = 1;
    for (const field of type.fields) {
      const fieldAlign = getAlignmentOfType(field.type);
      if (fieldAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, fieldAlign);
    }
    return maxAlign;
  } else if (isEnumType(type)) {
    // Enum alignment is the maximum alignment of its variants
    let maxAlign = 1;
    for (const variant of type.variants) {
      if (variant.fields) {
        for (const field of variant.fields) {
          const fieldAlign = getAlignmentOfType(field.type);
          if (fieldAlign === null) {
            return null;
          }
          maxAlign = Math.max(maxAlign, fieldAlign);
        }
      }
    }
    return maxAlign;
  } else if (isUnionType(type)) {
    // Union alignment is the maximum alignment of its fields
    let maxAlign = 1;
    for (const field of type.fields) {
      const fieldAlign = getAlignmentOfType(field.type);
      if (fieldAlign === null) {
        return null;
      }
      maxAlign = Math.max(maxAlign, fieldAlign);
    }
    return maxAlign;
  } else if (isFunctionType(type)) {
    return getTargetPointerSizeBytes(); // Functions are treated as pointers, so pointer-aligned
  } else if (isPtrType(type)) {
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
    isComptListType(type) ||
    isModuleType(type) ||
    isExprType(type) // ^ disallowed in the runtime
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
    if (type.isReferenceSemantics) {
      return getTargetPointerSizeBits();
    }
    if (type.isNewtype) {
      return getSizeOfType(type.fields[0]!.type);
    }
    return getStructTypeSize(type);
  } else if (isEnumType(type)) {
    return getEnumTypeSize(type);
  } else if (isUnionType(type)) {
    return getUnionType(type);
  } else if (isFunctionType(type)) {
    return getTargetPointerSizeBits(); // Functions are treated as pointers, so return pointer size
  } else if (isPtrType(type)) {
    return getTargetPointerSizeBits(); // Pointer and reference types have pointer size
  }

  return null;
}

export function prohibitVoidType(type: Type, token: Token): void {
  if (isVoidType(type)) {
    throw formatErrorMessages([
      {
        token,
        errorMessage: `Cannot use 'void' type here.
Please consider use 'unit' type instead.
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
export function canTypeFormGcCycle(
  type: Type,
  visitedTypes = new Set<string>()
): boolean {
  if (!isObjectType(type)) {
    return false; // Only objects can form cycles through reference counting
  }

  // Avoid infinite recursion by tracking visited types
  if (visitedTypes.has(type.id)) {
    return true; // We found a cycle back to a type we're already analyzing
  }

  visitedTypes.add(type.id);

  try {
    // Check all fields in the struct
    for (const field of type.fields) {
      if (typeCanFormCyclicGcReference(field.type, type, visitedTypes)) {
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
function typeCanFormCyclicGcReference(
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
    return canTypeFormGcCycle(type, new Set(visitedTypes));
  }

  // Check through enum variants
  if (isEnumType(type)) {
    for (const variant of type.variants) {
      if (variant.fields) {
        for (const field of variant.fields) {
          if (
            typeCanFormCyclicGcReference(
              field.type,
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

  if (isSomeType(type)) {
    if (type.resolvedConcreteType) {
      return typeCanFormCyclicGcReference(
        type.resolvedConcreteType,
        originalRefStruct,
        visitedTypes
      );
    } else {
      return true; // Be conservative
    }
  }

  // Check through arrays
  if (isArrayType(type)) {
    return typeCanFormCyclicGcReference(
      type.childType,
      originalRefStruct,
      visitedTypes
    );
  }

  // Check through slices
  if (isSliceType(type)) {
    return typeCanFormCyclicGcReference(
      type.childType,
      originalRefStruct,
      visitedTypes
    );
  }

  // Check through tuples
  if (isTupleType(type)) {
    for (const field of type.fields) {
      if (
        typeCanFormCyclicGcReference(
          field.type,
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
    for (const field of type.fields) {
      if (
        typeCanFormCyclicGcReference(
          field.type,
          originalRefStruct,
          visitedTypes
        )
      ) {
        return true;
      }
    }
  }

  // Check through dynamic types - they can contain object types
  if (isDynType(type)) {
    return true;
  }

  // Ptr and MutRef are raw pointers/references - they don't participate in ARC
  // so they don't form reference counting cycles.
  if (isPtrType(type)) {
    return false;
  }

  // Other types (primitives, functions, etc.) cannot form cycles
  return false;
}

/**
 * Check if a type contains Self (directly or nested in compound types)
 * This is used for object-safety checks - methods returning types containing Self
 * cannot be called on Dyn values because different implementations return different types.
 *
 * @param type The type to check
 * @param selfType The SelfType to check against (from the function's type)
 * @returns true if the type contains Self anywhere in its structure
 */
export function typeContainsSelfTypeForDynamicDispatchCheck(
  type: Type,
  selfType: Type | undefined
): boolean {
  if (!selfType) {
    return false; // No Self type defined, so can't contain it
  }

  // Direct match: type IS Self
  if (type.id === selfType.id) {
    return true;
  }

  // Check compound types recursively
  if (isArrayType(type)) {
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.childType,
      selfType
    );
  }

  if (isSliceType(type)) {
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.childType,
      selfType
    );
  }

  if (isPtrType(type)) {
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.childType,
      selfType
    );
  }

  if (isTupleType(type)) {
    return type.fields.some((elem) =>
      typeContainsSelfTypeForDynamicDispatchCheck(elem.type, selfType)
    );
  }

  if (isStructType(type)) {
    return type.fields.some((field) =>
      typeContainsSelfTypeForDynamicDispatchCheck(field.type, selfType)
    );
  }

  if (isUnionType(type)) {
    return type.fields.some((t) =>
      typeContainsSelfTypeForDynamicDispatchCheck(t.type, selfType)
    );
  }

  if (isEnumType(type)) {
    return type.variants.some((variant) =>
      variant.fields?.some((field) =>
        typeContainsSelfTypeForDynamicDispatchCheck(field.type, selfType)
      )
    );
  }

  if (isFunctionType(type)) {
    // Only check return type, not parameters
    // Parameters with Self are fine - they're passed as void* boxes
    // The problem is only with return types (caller doesn't know concrete type)
    return typeContainsSelfTypeForDynamicDispatchCheck(
      type.return.type,
      selfType
    );
  }

  // Other types (primitives, modules, etc.) don't contain Self
  return false;
}
