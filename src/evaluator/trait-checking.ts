/**
 * Type trait checking functions with full generic impl support.
 *
 * These functions check if types implement specific traits (Comptime, Runtime, Send)
 * and properly handle generic impls from the registry.
 *
 * This file exists to break the circular dependency between types/utils.ts and
 * evaluator/values/impl.ts. The core trait-checking logic needs access to the
 * generic impl registry, which is in the evaluator layer.
 */

import { Environment } from "../env";
import { formatErrorMessage } from "../error";
import {
  DynType,
  getTraitTypeFromEnv,
  getValueOfSomeTypeFromEnv,
  isDynType,
  isFnTraitType,
  isFutureTraitType,
  isSomeType,
  isTypeHierarchyType,
  SomeType,
  TraitType,
  Type,
  typeContainsSomeType,
  TypeTag,
} from "../types";
import { areTypesCompatible } from "../types/compatibility";
import { isTraitValue, TraitValue } from "../value";
import { findMatchingGenericImpl } from "./values/impl";

/**
 * Check if a type implements a specific trait.
 * This is the core implementation that handles both direct trait fields
 * and generic impls.
 */
export function typeImplementsTraitWithGenericImpls({
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

  // Check generic impl registry for matching patterns
  // Guard against types containing unresolved SomeTypes
  if (isSomeType(targetType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, targetType);
    if (isSomeType(resolvedType)) {
      return false;
    }
    targetType = resolvedType;
  }

  if (typeContainsSomeType(targetType)) {
    return false;
  }

  const result = findMatchingGenericImpl({
    concreteType: targetType,
    traitType,
    env,
  });
  return result !== undefined;
}

/**
 * Check if a type implements the Comptime trait.
 *
 * Comptime types can be used at compile-time.
 * Examples: i32, bool, Type, comptime_int, comptime_float, comptime_string
 * Non-examples: void (runtime-only type)
 */
export function typeImplementsComptime(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  switch (type.tag) {
    // Comptime-only types - always return true
    case TypeTag.ComptimeInt:
    case TypeTag.ComptimeFloat:
    case TypeTag.ComptimeString:
    case TypeTag.Type:
    case TypeTag.Module:
    case TypeTag.Trait:
    case TypeTag.Expr:
    case TypeTag.ComptimeList: {
      return true;
    }

    // Runtime-only types - always return false
    case TypeTag.Iso:
    case TypeTag.Dyn:
    case TypeTag.Void:
    case TypeTag.Union:
    case TypeTag.Char: // C-compatible types (platform-dependent size, runtime only)
    case TypeTag.Short:
    case TypeTag.UShort:
    case TypeTag.Int:
    case TypeTag.UInt:
    case TypeTag.Long:
    case TypeTag.ULong:
    case TypeTag.LongLong:
    case TypeTag.ULongLong:
    case TypeTag.LongDouble: {
      return false;
    }

    // Primitive types available in both contexts - return true
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
    case TypeTag.Function: {
      return true;
    }
  }

  if (isTypeHierarchyType(type)) {
    return true;
  }

  // For SomeType, check if Comptime is explicitly attached or negated
  if (isSomeType(type)) {
    const comptimeTraitType = getTraitTypeFromEnv(env, "Comptime");
    if (comptimeTraitType && type.negativeTraits) {
      for (const negativeTrait of type.negativeTraits) {
        if (negativeTrait.id === comptimeTraitType.id) {
          return false;
        }
      }
    }
    // Default: SomeType does NOT implement Comptime (runtime by default)
    return false;
  }

  const comptimeTraitType = getTraitTypeFromEnv(env, "Comptime");
  if (!comptimeTraitType) {
    return false;
  }

  return typeImplementsTraitWithGenericImpls({
    targetType: type,
    traitType: comptimeTraitType,
    env,
  });
}

/**
 * Check if a type implements the Runtime trait.
 *
 * Runtime types can be used at runtime.
 * Examples: i32, bool, *(i32), void
 * Non-examples: comptime_int, comptime_float, comptime_string, Type (compile-time-only types)
 */
export function typeImplementsRuntime(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  switch (type.tag) {
    // Comptime-only types - do NOT implement Runtime
    case TypeTag.ComptimeInt:
    case TypeTag.ComptimeFloat:
    case TypeTag.ComptimeString:
    case TypeTag.Type:
    case TypeTag.Module:
    case TypeTag.Trait:
    case TypeTag.Expr:
    case TypeTag.ComptimeList: {
      return false;
    }

    // Runtime-only types
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
    case TypeTag.Unit: // Types available in both contexts
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
    case TypeTag.Function:
    case TypeTag.Union: {
      return true;
    }
  }

  // For SomeType, default to Runtime (type parameters are runtime by default)
  // unless Runtime is explicitly in negativeTraits (e.g., where(T <: !(Runtime)))
  if (isSomeType(type)) {
    const runtimeTraitType = getTraitTypeFromEnv(env, "Runtime");
    if (runtimeTraitType && type.negativeTraits) {
      for (const negativeTrait of type.negativeTraits) {
        if (negativeTrait.id === runtimeTraitType.id) {
          return false;
        }
      }
    }
    // Default: SomeType implements Runtime
    return true;
  }

  const runtimeTraitType = getTraitTypeFromEnv(env, "Runtime");
  if (!runtimeTraitType) {
    return false;
  }

  return typeImplementsTraitWithGenericImpls({
    targetType: type,
    traitType: runtimeTraitType,
    env,
  });
}

/**
 * Check if a type implements the Send trait.
 *
 * Send types can be safely transferred between threads.
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

  return typeImplementsTraitWithGenericImpls({
    targetType: type,
    traitType: sendTraitType,
    env,
  });
}

/**
 * Check if a type is comptime-only (only available at compile-time, not runtime).
 */
export function typeIsComptimeOnly(
  type: Type | undefined,
  env: Environment
): boolean {
  return typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env);
}

/**
 * Check if a type is runtime-only (only available at runtime, not compile-time).
 */
export function typeIsRuntimeOnly(
  type: Type | undefined,
  env: Environment
): boolean {
  return !typeImplementsComptime(type, env) && typeImplementsRuntime(type, env);
}

/**
 * Check if a type implements Fn (is a function-like type).
 */
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
 * Check if a type implements Future (is a future-like type).
 */
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
 * Validate that a type can be used in at least one evaluation context (comptime or runtime).
 * Throws an error if the type has incompatible field contexts.
 */
export function validateTypeAvailability(
  type: Type,
  env: Environment,
  token: import("../token").Token
): void {
  if (!typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env)) {
    throw formatErrorMessage({
      token: token,
      errorMessage: `This type has incompatible field contexts and cannot be used in any evaluation context.
  
This typically happens when a struct/enum/array/tuple contains fields with conflicting availability:
- Compile-time only fields (e.g., comptime_int, Type, Module)
- Runtime only fields (e.g., *(T), [T], void, C-compatible types)

Consider restructuring the type to avoid mixing incompatible field types.`,
    });
  }
}
