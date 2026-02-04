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

import { Environment, getWhereClauseConstraintsForSomeType } from "../env";
import { formatErrorMessage } from "../error";
import { Token } from "../token";
import { areTypesCompatible } from "../types/compatibility";
import {
  DynType,
  FnTraitType,
  FutureTraitType,
  SomeType,
  TraitType,
  Type,
} from "../types/definitions";
import {
  getTraitTypeFromEnv,
  getValueOfSomeTypeFromEnv,
} from "../types/env-lookup";
import {
  isDynType,
  isFnTraitType,
  isFutureTraitType,
  isSomeType,
  isStructType,
  isTypeHierarchyType,
} from "../types/guards";
import { TypeTag } from "../types/tags";
import { typeContainsSomeType, typeToString } from "../types/utils";
import { isTraitValue, TraitValue } from "../value";
import { EvaluatorContext } from "./context";
import { findMatchingGenericImpl } from "./values/impl";

/**
 * Recursion guard to prevent infinite loops when checking trait implementations.
 * This can happen with impls that have where clauses referencing the same trait.
 * For example: impl(forall(T : Type), where(T <: Runtime), *(T), Runtime())
 * When checking if *(SomeType) implements Runtime, it would recursively check
 * if SomeType implements Runtime, which could loop indefinitely.
 */
const traitCheckRecursionGuard = new Set<string>();

function typeImplementsComptimeBuiltin(
  type: Type | undefined
): boolean | undefined {
  if (!type) {
    return false;
  }

  // Object types (reference semantics) are always runtime types.
  if (isStructType(type) && type.isReferenceSemantics) {
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

  return undefined;
}

function typeImplementsRuntimeBuiltin(
  type: Type | undefined
): boolean | undefined {
  if (!type) {
    return false;
  }

  // Object types (reference semantics) are always runtime types.
  if (isStructType(type) && type.isReferenceSemantics) {
    return true;
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
    case TypeTag.LongDouble: {
      return true;
    }

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
    case TypeTag.Function:
    case TypeTag.Union: {
      return true;
    }
  }

  return undefined;
}

/**
 * Check if a type implements a specific trait.
 * This is the core implementation that handles both direct trait fields
 * and generic impls.
 */
export function typeImplementsTrait({
  targetType,
  traitType,
  env,
}: {
  targetType: Type;
  traitType: TraitType;
  env: Environment;
}): boolean {
  const comptimeTraitType = getTraitTypeFromEnv(env, "Comptime");
  if (comptimeTraitType && traitType.id === comptimeTraitType.id) {
    const builtin = typeImplementsComptimeBuiltin(targetType);
    if (builtin !== undefined) {
      return builtin;
    }
  }

  const runtimeTraitType = getTraitTypeFromEnv(env, "Runtime");
  if (runtimeTraitType && traitType.id === runtimeTraitType.id) {
    const builtin = typeImplementsRuntimeBuiltin(targetType);
    if (builtin !== undefined) {
      return builtin;
    }
  }

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

  // Check where clause constraints for SomeType
  // Constraints are stored in the current env frames (not on SomeType)
  if (isSomeType(targetType)) {
    // QUESTION: Should we check this?
    // if (targetType.resolvedConcreteType) {
    //   // If resolvedConcreteType is set, check that type instead
    //   return typeImplementsTrait({
    //     targetType: targetType.resolvedConcreteType,
    //     traitType,
    //     env,
    //   });
    // }

    let foundRequiredTraitInConstraints = false;
    let foundNegativeTraitInConstraints = false;
    // Check if the trait is in requiredTraits (SomeType-level + where-clause constraints)
    for (const requiredTraitEntry of targetType.requiredTraits) {
      if (requiredTraitEntry.traitType.id === traitType.id) {
        foundRequiredTraitInConstraints = true;
      }
    }

    const whereConstraints = getWhereClauseConstraintsForSomeType(
      env,
      targetType
    );
    if (whereConstraints) {
      for (const requiredTrait of whereConstraints.requiredTraits) {
        if (requiredTrait.id === traitType.id) {
          foundRequiredTraitInConstraints = true;
        }
      }
      for (const negativeTrait of whereConstraints.negativeTraits) {
        if (negativeTrait.id === traitType.id) {
          foundNegativeTraitInConstraints = true;
        }
      }
    }

    // Check if the trait is in negativeTraits (SomeType-level)
    if (targetType.negativeTraits) {
      for (const negativeTraitEntry of targetType.negativeTraits) {
        if (negativeTraitEntry.traitType.id === traitType.id) {
          foundNegativeTraitInConstraints = true;
        }
      }
    }

    if (foundRequiredTraitInConstraints) {
      if (foundNegativeTraitInConstraints) {
        return false;
      } else {
        return true;
      }
    } else if (foundNegativeTraitInConstraints) {
      return false;
    }
  }

  // Check generic impl registry for matching patterns
  // Guard against unresolved SomeTypes
  if (isSomeType(targetType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, targetType);
    if (isSomeType(resolvedType)) {
      return false;
    }
    targetType = resolvedType;
  }

  // Use recursion guard to prevent infinite loops when checking impls with where clauses
  // Example: impl(forall(T : Type), where(T <: Runtime), *(T), Runtime()) would cause
  // infinite recursion when checking if *(SomeType) implements Runtime
  const guardKey = `${targetType.id}:${traitType.id}`;
  if (traitCheckRecursionGuard.has(guardKey)) {
    return false;
  }
  traitCheckRecursionGuard.add(guardKey);
  try {
    const result = findMatchingGenericImpl({
      concreteType: targetType,
      traitType,
      env,
    });
    return result !== undefined;
  } finally {
    traitCheckRecursionGuard.delete(guardKey);
  }
}

/**
 * Check if a type implements all the selfConstraints of a trait type.
 * Also checks that the type does NOT implement any negativeSelfConstraints.
 * Throws an error if any constraint is not satisfied.
 */
export function checkTypeImplementsSelfConstraints({
  targetType,
  traitType,
  env,
  errorToken,
}: {
  targetType: Type;
  traitType: TraitType;
  env: Environment;
  errorToken: Token;
}): void {
  // Check positive constraints (must implement)
  if (traitType.selfConstraints && traitType.selfConstraints.length > 0) {
    for (const constraintTrait of traitType.selfConstraints) {
      if (
        !typeImplementsTrait({ targetType, traitType: constraintTrait, env })
      ) {
        throw formatErrorMessage({
          token: errorToken,
          errorMessage: `Type "${typeToString(targetType)}" does not implement required constraint "${constraintTrait.typeName ?? typeToString(constraintTrait)}" from trait "${traitType.typeName ?? typeToString(traitType)}"'s where clause.`,
        });
      }
    }
  }

  // Check negative constraints (must NOT implement)
  if (
    traitType.negativeSelfConstraints &&
    traitType.negativeSelfConstraints.length > 0
  ) {
    for (const constraintTrait of traitType.negativeSelfConstraints) {
      if (
        typeImplementsTrait({ targetType, traitType: constraintTrait, env })
      ) {
        throw formatErrorMessage({
          token: errorToken,
          errorMessage: `Type "${typeToString(targetType)}" implements "${constraintTrait.typeName ?? typeToString(constraintTrait)}" but the trait "${traitType.typeName ?? typeToString(traitType)}"'s where clause requires it to NOT implement this trait.`,
        });
      }
    }
  }
}

/**
 * Check if a type implements the Comptime trait.
 *
 * Comptime types can be used at compile-time.
 * Examples: i32, bool, Type, comptime_int, comptime_float, comptime_string
 * Non-examples: void (runtime-only type)
 */
export function typeImplementsComptime(type: Type, env: Environment): boolean {
  const builtin = typeImplementsComptimeBuiltin(type);
  if (builtin !== undefined) {
    return builtin;
  }

  const comptimeTraitType = getTraitTypeFromEnv(env, "Comptime");
  if (!comptimeTraitType) {
    return false;
  }

  return typeImplementsTrait({
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
export function typeImplementsRuntime(type: Type, env: Environment): boolean {
  const builtin = typeImplementsRuntimeBuiltin(type);
  if (builtin !== undefined) {
    return builtin;
  }

  const runtimeTraitType = getTraitTypeFromEnv(env, "Runtime");
  if (!runtimeTraitType) {
    return false;
  }

  return typeImplementsTrait({
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

  return typeImplementsTrait({
    targetType: type,
    traitType: sendTraitType,
    env,
  });
}

/**
 * Check if a type implements the Acyclic trait.
 *
 * Acyclic types cannot form reference cycles through reference counting.
 * Primitives, value types (structs without reference semantics),
 * and object types that don't reference back to themselves implement Acyclic.
 */
export function typeImplementsAcyclic(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  const acyclicTraitType = getTraitTypeFromEnv(env, "Acyclic");
  if (!acyclicTraitType) {
    return false;
  }

  return typeImplementsTrait({
    targetType: type,
    traitType: acyclicTraitType,
    env,
  });
}

/**
 * Check if a type is comptime-only (only available at compile-time, not runtime).
 */
export function typeIsComptimeOnly(type: Type, env: Environment): boolean {
  return typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env);
}

/**
 * Check if a type is runtime-only (only available at runtime, not compile-time).
 */
export function typeIsRuntimeOnly(type: Type, env: Environment): boolean {
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
    for (const { traitType } of type.requiredTraits) {
      if (isFnTraitType(traitType)) {
        return true;
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
    for (const { traitType } of type.requiredTraits) {
      if (isFnTraitType(traitType)) {
        return traitType;
      }
    }
  }

  return undefined;
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
    for (const { traitType } of type.requiredTraits) {
      if (isFutureTraitType(traitType)) {
        return true;
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
    for (const { traitType } of type.requiredTraits) {
      if (isFutureTraitType(traitType)) {
        return traitType;
      }
    }
  }

  return undefined;
}

/**
 * Validate that a type can be used in at least one evaluation context (comptime or runtime).
 * Throws an error if the type has incompatible field contexts.
 */
export function validateTypeAvailability(
  type: Type,
  env: Environment,
  token: Token,
  context?: EvaluatorContext
): void {
  // If the type still contains SomeType placeholders, defer availability checks.
  if (typeContainsSomeType(type)) {
    if (context?.pendingTypeAvailabilityChecks) {
      const alreadyDeferred = context.pendingTypeAvailabilityChecks.some(
        (entry) => entry.type === type
      );
      if (!alreadyDeferred) {
        context.pendingTypeAvailabilityChecks.push({ type, token });
      }
    }
    return;
  }

  if (!typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env)) {
    if (context?.pendingTypeAvailabilityChecks) {
      const alreadyDeferred = context.pendingTypeAvailabilityChecks.some(
        (entry) => entry.type === type
      );
      if (!alreadyDeferred) {
        context.pendingTypeAvailabilityChecks.push({ type, token });
      }
      return;
    }
    throw formatErrorMessage({
      token: token,
      errorMessage: `Type ${typeToString(type)} has incompatible field contexts and cannot be used in any evaluation context.
  
This typically happens when a struct/enum/array/tuple contains fields with conflicting availability:
- Compile-time only fields (e.g., comptime_int, Type, Module)
- Runtime only fields (e.g., *(T), [T], void, C-compatible types)

Consider restructuring the type to avoid mixing incompatible field types.`,
    });
  }
}
