import { Environment, getVariablesFromEnv } from "../env";
import { formatErrorMessages } from "../error";
import { Expr, exprToString } from "../expr";
import { stringIsOperator, Token } from "../token";
import { TypeValue } from "../type-value";
import {
  isNumberValue,
  isTraitValue,
  isTypeValue,
  isUnknownValue,
  TraitValue,
  valueToString,
} from "../value";
import { ValueTag } from "../value-tag";
import { areTypesCompatible } from "./compatibility";
import { BOTH_AVAILABLE, COMPTIME_ONLY, RUNTIME_ONLY } from "./constants";
import { createF64Type, createI32Type, createStrType } from "./creators";
import {
  ArrayType,
  ComptListType,
  DynType,
  EnumType,
  FnTraitType,
  FunctionParameter,
  FunctionType,
  FutureTraitType,
  IsoType,
  ModuleField,
  ModuleType,
  PtrType,
  SomeType,
  StructType,
  TraitType,
  TupleType,
  Type,
  TypeAvailability,
  TypeField,
  UnionType,
} from "./definitions";
import {
  isArrayType,
  isBooleanType,
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
  isFnTraitType,
  isFunctionType,
  isFutureTraitType,
  isI16Type,
  isI32Type,
  isI64Type,
  isI8Type,
  isIntegerType,
  isIsizeType,
  isModuleType,
  isObjectType,
  isPtrType,
  isRcType,
  isSliceType,
  isSomeType,
  isStructType,
  isTraitType,
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
export function getTraitTypeFromEnv(
  env: Environment,
  traitName: string
): TraitType | undefined {
  const variables = getVariablesFromEnv(env, traitName);
  if (variables.length === 0) {
    return undefined;
  }
  const variable = variables[variables.length - 1]!;
  if (variable.value && isTypeValue(variable.value)) {
    const typeValue = variable.value as TypeValue;
    if (isTraitType(typeValue.value)) {
      return typeValue.value;
    }
  }
  return undefined;
}

/**
 * Check if a type implements a specific module.
 * This is the core implementation used by typeImplementsCopy and typeImplementsSend.
 */
export function typeImplementsTraitInternal({
  targetType,
  traitType,
  env,
}: {
  targetType: Type;
  traitType: TraitType;
  env: Environment;
}): boolean {
  const expectedTraitWithReceiver: TraitType = {
    ...traitType,
    receiverType: targetType,
  };

  const targetTrait = targetType.trait;
  if (targetTrait) {
    for (const field of targetTrait.fields) {
      if (!field.assignedValue || !isTraitValue(field.assignedValue)) {
        continue;
      }

      const fieldTraitValue = field.assignedValue as TraitValue;
      const fieldTraitType = fieldTraitValue.type;

      if (
        areTypesCompatible(
          { type: expectedTraitWithReceiver, env },
          { type: fieldTraitType, env }
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

  const copyModuleType = getTraitTypeFromEnv(env, "Copy");
  if (!copyModuleType) {
    return false;
  }

  return typeImplementsTraitInternal({
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
 * Primitives, Send pointers (where T is not Rc and T implements Send),
 * and structs where all fields are Send implement Send.
 */
export function typeImplementsSend(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  const sendTraitType = getTraitTypeFromEnv(env, "Send");
  if (!sendTraitType) {
    return false;
  }

  return typeImplementsTraitInternal({
    targetType: type,
    traitType: sendTraitType,
    env,
  });
}

export function typeImplementsFn(
  type: Type | undefined
): type is (SomeType | DynType) & { isFn: true } {
  if (!type) {
    return false;
  }

  // Check requiredTraits for SomeType and DynType (e.g., Impl(Fn(...)) or Dyn(Fn(...)))
  if (isSomeType(type) || isDynType(type)) {
    const requiredTraits = (type as SomeType | DynType).requiredTraits;
    if (requiredTraits) {
      for (const traitType of requiredTraits) {
        if (isFnTraitType(traitType)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract FnTraitType from a type (e.g., from Impl(Fn(...) -> ...) or Dyn(Fn(...) -> ...) or FnTraitType directly)
 * Returns the FnTraitType if found, otherwise undefined.
 */
export function extractFnTraitFromType(type: Type): FnTraitType | undefined {
  // If the type is already a FnTraitType, return it directly
  if (isFnTraitType(type)) {
    return type;
  }

  // Check requiredTraits for SomeType and DynType
  if (isSomeType(type) || isDynType(type)) {
    const requiredTraits = (type as SomeType | DynType).requiredTraits;
    if (requiredTraits) {
      for (const traitType of requiredTraits) {
        if (isFnTraitType(traitType)) {
          return traitType;
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

  // Check requiredTraits for SomeType and DynType (e.g., Impl(Fn(...)) or Dyn(Fn(...)))
  if (isSomeType(type) || isDynType(type)) {
    const requiredTraits = (type as SomeType | DynType).requiredTraits;
    if (requiredTraits) {
      for (const traitType of requiredTraits) {
        if (isFutureTraitType(traitType)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract FutureTraitType from a type (e.g., from Impl(Future(T)) or Dyn(Future(T)) or FutureTraitType directly)
 * Returns the FutureTraitType if found, otherwise undefined.
 */
export function extractFutureTraitFromType(
  type: Type
): FutureTraitType | undefined {
  // If the type is already a FutureTraitType, return it directly
  if (isFutureTraitType(type)) {
    return type;
  }

  // Check requiredTraits for SomeType and DynType
  if (isSomeType(type) || isDynType(type)) {
    const requiredTraits = (type as SomeType | DynType).requiredTraits;
    if (requiredTraits) {
      for (const traitType of requiredTraits) {
        if (isFutureTraitType(traitType)) {
          return traitType;
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
 *
 * This includes:
 * - Primitive comptime-only types (Type, compt_int, compt_float, etc.)
 * - Compound types that are comptime-only (structs with compt_int fields, etc.)
 */
export function typeRequiresComptModifier(type?: Type): boolean {
  if (!type) {
    return false;
  }

  // Check if compound types are comptime-only based on their availability
  // A type with availability { comptime: true, runtime: false } is comptime-only
  return isComptimeOnlyType(type);
}

export function typeProhibitsComptModifier(type?: Type): boolean {
  if (!type) {
    return false;
  }

  return isRuntimeOnlyType(type);
}

/**
 * Determine the TypeAvailability for a given type and validate it.
 * This computes the availability and throws an error if invalid (no context available).
 *
 * For compound types (struct, enum, array, tuple), this computes the intersection
 * of field availabilities and validates that at least one context remains available.
 *
 * @param type The type to determine availability for
 * @param errorToken Optional token for error reporting
 * @returns The computed TypeAvailability
 * @throws Error if the availability is invalid (both comptime and runtime are false)
 */
export function determineTypeAvailability(
  type: Type,
  errorToken?: Token
): TypeAvailability {
  let availability: TypeAvailability;

  // Determine availability based on type tag
  switch (type.tag) {
    // Comptime-only types
    case TypeTag.ComptInt:
    case TypeTag.ComptFloat:
    case TypeTag.ComptString:
    case TypeTag.Type:
    case TypeTag.Module:
    case TypeTag.Trait:
    case TypeTag.Expr:
    case TypeTag.ComptList:
      availability = COMPTIME_ONLY;
      break;

    // Runtime-only types
    case TypeTag.Ptr:
    case TypeTag.Slice:
    case TypeTag.Iso:
    case TypeTag.Dyn:
    case TypeTag.Void:
    case TypeTag.Char: // C-compatible types (platform-dependent size, runtime only)
    case TypeTag.Short:
    case TypeTag.UShort:
    case TypeTag.Int:
    case TypeTag.UInt:
    case TypeTag.Long:
    case TypeTag.ULong:
    case TypeTag.LongLong:
    case TypeTag.ULongLong:
    case TypeTag.LongDouble:
      availability = RUNTIME_ONLY;
      break;

    // Types available in both contexts
    case TypeTag.Unit:
    case TypeTag.Bool:
    case TypeTag.Usize:
    case TypeTag.Isize:
    case TypeTag.U8:
    case TypeTag.I8:
    case TypeTag.U16:
    case TypeTag.I16:
    case TypeTag.U32:
    case TypeTag.I32:
    case TypeTag.U64:
    case TypeTag.I64:
    case TypeTag.F32:
    case TypeTag.F64:
      availability = BOTH_AVAILABLE;
      break;

    // Compound types - compute from fields
    case TypeTag.Struct:
      availability = computeStructTypeAvailability(type as StructType);
      break;
    case TypeTag.Enum:
      availability = computeEnumTypeAvailability(type as EnumType);
      break;
    case TypeTag.Array:
      availability = computeArrayTypeAvailability(type as ArrayType);
      break;
    case TypeTag.Tuple:
      availability = computeTupleTypeAvailability(type as TupleType);
      break;
    case TypeTag.Union:
      // Union types are runtime-only (as specified in the design)
      availability = RUNTIME_ONLY;
      break;

    // Function types: can be used in both contexts (function references)
    case TypeTag.Function:
      availability = BOTH_AVAILABLE;
      break;

    // SomeType: defaults to both contexts unless we know more
    case TypeTag.SomeType: {
      const someType = type as SomeType;
      // If we have a resolved concrete type, use its availability
      if (someType.resolvedConcreteType) {
        availability = determineTypeAvailability(
          someType.resolvedConcreteType,
          errorToken
        );
      } else {
        // Otherwise, assume both contexts are available
        availability = BOTH_AVAILABLE;
      }
      break;
    }

    default:
      // Default to both contexts for unknown types
      availability = BOTH_AVAILABLE;
  }

  // Validate the availability
  if (!isValidAvailability(availability)) {
    const typeName = type.typeName || typeToString(type);
    const errorMessage = `Type '${typeName}' has incompatible field contexts and cannot be used in any evaluation context.\n\nThis typically happens when a struct/enum/array contains fields with conflicting availability:\n- Compile-time only fields (e.g., compt_int, Type, Module)\n- Runtime only fields (e.g., *(T), [T], void, C-compatible types)\n\nConsider restructuring the type to avoid mixing incompatible field types.`;

    if (errorToken) {
      throw formatErrorMessages([
        {
          token: errorToken,
          errorMessage,
        },
      ]);
    } else {
      throw new Error(errorMessage);
    }
  }

  return availability;
}

/**
 * Get the TypeAvailability for a given type.
 * Simply returns the availability field from the type.
 */
export function getTypeAvailability(type: Type): TypeAvailability {
  return type.availability;
}

/**
 * Compute the intersection of two TypeAvailabilities.
 * Returns an availability where both comptime and runtime are true only if they are true in both inputs.
 */
export function computeIntersectionAvailability(
  a: TypeAvailability,
  b: TypeAvailability
): TypeAvailability {
  return {
    comptime: a.comptime && b.comptime,
    runtime: a.runtime && b.runtime,
  };
}

/**
 * Check if a TypeAvailability is valid (at least one context is available).
 */
export function isValidAvailability(availability: TypeAvailability): boolean {
  return availability.comptime || availability.runtime;
}

/**
 * Check if a type is comptime-only (cannot be used at runtime).
 */
export function isComptimeOnlyType(type: Type): boolean {
  return type.availability.comptime && !type.availability.runtime;
}

/**
 * Check if a type is runtime-only (cannot be used at compile time).
 */
export function isRuntimeOnlyType(type: Type): boolean {
  return !type.availability.comptime && type.availability.runtime;
}

/**
 * Compute the TypeAvailability for a struct type based on its fields.
 */
export function computeStructTypeAvailability(
  structType: StructType
): TypeAvailability {
  const fields = structType.fields;

  // Empty struct can be used in both contexts
  if (fields.length === 0) {
    return BOTH_AVAILABLE;
  }

  // Start with both contexts available
  let result: TypeAvailability = { ...BOTH_AVAILABLE };

  // Intersect with each non-compile-time-only field's availability
  for (const field of fields) {
    // Skip compile-time-only fields (they don't affect runtime representation)
    if (field.isCompileTimeOnly) {
      continue;
    }

    const fieldAvailability = field.type.availability;
    result = computeIntersectionAvailability(result, fieldAvailability);

    // Early exit if availability becomes invalid
    if (!isValidAvailability(result)) {
      break;
    }
  }

  return result;
}

/**
 * Compute the TypeAvailability for an enum type based on its variants.
 */
export function computeEnumTypeAvailability(
  enumType: EnumType
): TypeAvailability {
  const variants = enumType.variants;

  // Empty enum can be used in both contexts
  if (variants.length === 0) {
    return BOTH_AVAILABLE;
  }

  // Start with both contexts available
  let result: TypeAvailability = { ...BOTH_AVAILABLE };

  // Intersect with each variant's fields' availabilities
  for (const variant of variants) {
    if (variant.fields) {
      for (const field of variant.fields) {
        const fieldAvailability = field.type.availability;
        result = computeIntersectionAvailability(result, fieldAvailability);

        // Early exit if availability becomes invalid
        if (!isValidAvailability(result)) {
          return result;
        }
      }
    }
  }

  return result;
}

/**
 * Compute the TypeAvailability for a tuple type based on its fields.
 */
export function computeTupleTypeAvailability(
  tupleType: TupleType
): TypeAvailability {
  const fields = tupleType.fields;

  // Empty tuple can be used in both contexts
  if (fields.length === 0) {
    return BOTH_AVAILABLE;
  }

  // Start with both contexts available
  let result: TypeAvailability = { ...BOTH_AVAILABLE };

  // Intersect with each field's availability
  for (const field of fields) {
    // Skip compile-time-only fields
    if (field.isCompileTimeOnly) {
      continue;
    }

    const fieldAvailability = field.type.availability;
    result = computeIntersectionAvailability(result, fieldAvailability);

    // Early exit if availability becomes invalid
    if (!isValidAvailability(result)) {
      break;
    }
  }

  return result;
}

/**
 * Compute the TypeAvailability for an array type based on its child type.
 */
export function computeArrayTypeAvailability(
  arrayType: ArrayType
): TypeAvailability {
  return arrayType.childType.availability;
}

/**
 * Update the availability of a type after its fields/variants have been modified.
 * This should be called after adding/removing fields to compound types.
 *
 * @param type The type to update
 * @returns The updated type (mutated in place)
 */
export function updateTypeAvailability(type: Type): Type {
  switch (type.tag) {
    case TypeTag.Struct:
      type.availability = computeStructTypeAvailability(type as StructType);
      break;
    case TypeTag.Enum:
      type.availability = computeEnumTypeAvailability(type as EnumType);
      break;
    case TypeTag.Tuple:
      type.availability = computeTupleTypeAvailability(type as TupleType);
      break;
    case TypeTag.Array:
      type.availability = computeArrayTypeAvailability(type as ArrayType);
      break;
    case TypeTag.Union:
      // Union types are always runtime-only
      type.availability = RUNTIME_ONLY;
      break;
    // Other types have fixed availability based on their tag
    default:
      // No-op for primitive types and other types
      break;
  }
  return type;
}

/**
 * Check if the type contains `object` or `Dyn`
 * @param type
 */
export function typeContainsRcType(
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

  if (type.isExtern) {
    // NOTE: Extern types, mostly the SomeType, don't need Rc
    return false;
  }

  if (isRcType(type)) {
    return true;
  }

  // Recursively check in complex types
  switch (type.tag) {
    case TypeTag.Array:
      return typeContainsRcType((type as ArrayType).childType, checkedTypes);
    case TypeTag.Tuple:
      return (type as TupleType).fields.some((field) =>
        typeContainsRcType(field.type, checkedTypes)
      );
    case TypeTag.Union:
      return (type as UnionType).fields.some((field) =>
        typeContainsRcType(field.type, checkedTypes)
      );
    case TypeTag.Struct:
      return (type as StructType).fields.some((field) =>
        typeContainsRcType(field.type, checkedTypes)
      );
    case TypeTag.Enum:
      return (type as EnumType).variants.some((variant) =>
        variant.fields?.some((param) =>
          typeContainsRcType(param.type, checkedTypes)
        )
      );
    case TypeTag.Iso:
      // Iso itself is GC type (atomic RC), check inner type
      return typeContainsRcType((type as IsoType).childType, checkedTypes);
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
        return typeContainsRcType(someType.resolvedConcreteType, checkedTypes);
      } else {
        // Conservatively return true because we don't know at
        return true;
      }
    }
    // case TypeTag.SomeType: { // NOTE: SomeType is now handled in isRcType
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
      // Codegen lowers such SomeType to the corresponding FnTraitType.
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
 * Check if a type contains any Unknown values (e.g., array length is Unknown).
 * Used to determine if we should fully specialize a generic impl method or not.
 */
export function typeContainsUnknownValue(type: Type): boolean {
  if (isArrayType(type)) {
    if (isUnknownValue(type.length)) {
      return true;
    }
    return typeContainsUnknownValue(type.childType);
  }
  if (isPtrType(type)) {
    return typeContainsUnknownValue(type.childType);
  }
  if (isSliceType(type)) {
    return typeContainsUnknownValue(type.childType);
  }
  if (isTupleType(type)) {
    return type.fields.some((f) => typeContainsUnknownValue(f.type));
  }
  if (isStructType(type)) {
    return type.fields.some((f) => typeContainsUnknownValue(f.type));
  }
  if (isEnumType(type)) {
    return type.variants.some((v) =>
      v.fields?.some((param) => typeContainsUnknownValue(param.type))
    );
  }
  if (isUnionType(type)) {
    return type.fields.some((f) => typeContainsUnknownValue(f.type));
  }

  // Add other cases as needed
  return false;
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
      return false;
    }
    case TypeTag.Trait: {
      // For FnTraitType, check if the function signature requires inference
      const traitType = type as TraitType;
      if (traitType.isFn) {
        return typeRequiresInference(traitType.isFn.callType);
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
      // Default: Convert the compt_string to str from prelude
      convertedType = createStrType(env);
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

      return `${enumType.typeName ? `(${enumType.typeName}) ` : ""}enum(${enumType.variants
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

      let moduleTypeString: string;
      if (moduleType.typeName) {
        moduleTypeString = moduleType.typeName;
      } else {
        moduleTypeString = `${
          moduleType.typeName ? `(${moduleType.typeName}) ` : ""
        }module(${moduleType.fields.map((field) => moduleElementToString(field, visited)).join(", ")})`;
      }

      return moduleTypeString;
    }

    case TypeTag.Trait: {
      const traitType = type as TraitType;

      // Check if it's a FnTraitType (closure/function trait)
      if (isFnTraitType(traitType)) {
        // Display as Fn(...) -> ReturnType
        return `Fn${functionTypeToString(traitType.isFn.callType, visited).slice(2)}`; // Remove "fn" prefix and add "Fn"
      }

      // Check if it's a FutureTraitType
      if (isFutureTraitType(traitType)) {
        return `Future(${typeToString(traitType.isFuture.outputType, visited)})`;
      }

      let traitTypeString: string;
      if (traitType.typeName) {
        traitTypeString = traitType.typeName;
      } else {
        traitTypeString = `${
          traitType.typeName ? `(${traitType.typeName}) ` : ""
        }trait(${traitType.fields.map((field) => moduleElementToString(field, visited)).join(", ")})`;
      }

      if (traitType.receiverType) {
        traitTypeString = `(${typeToString(traitType.receiverType, visited)} <: ${traitTypeString})`;
      }

      return traitTypeString;
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
      if (someType.requiredTraits && someType.requiredTraits.length > 0) {
        for (const mt of someType.requiredTraits) {
          allModuleStrings.push(typeToString(mt, visited));
        }
      }
      if (someType.negativeTraits && someType.negativeTraits.length > 0) {
        for (const mt of someType.negativeTraits) {
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
      for (const mt of dynType.requiredTraits) {
        allModuleStrings.push(typeToString(mt, visited));
      }
      if (dynType.negativeTraits && dynType.negativeTraits.length > 0) {
        for (const mt of dynType.negativeTraits) {
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
    isTraitType(type) ||
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
    isTraitType(type) ||
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
export function canTypeFormRcCycle(
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
      if (typeCanFormCyclicRcReference(field.type, type, visitedTypes)) {
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
function typeCanFormCyclicRcReference(
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
    return canTypeFormRcCycle(type, new Set(visitedTypes));
  }

  // Check through enum variants
  if (isEnumType(type)) {
    for (const variant of type.variants) {
      if (variant.fields) {
        for (const field of variant.fields) {
          if (
            typeCanFormCyclicRcReference(
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
      return typeCanFormCyclicRcReference(
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
    return typeCanFormCyclicRcReference(
      type.childType,
      originalRefStruct,
      visitedTypes
    );
  }

  // Check through slices
  if (isSliceType(type)) {
    return typeCanFormCyclicRcReference(
      type.childType,
      originalRefStruct,
      visitedTypes
    );
  }

  // Check through tuples
  if (isTupleType(type)) {
    for (const field of type.fields) {
      if (
        typeCanFormCyclicRcReference(
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
        typeCanFormCyclicRcReference(
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
