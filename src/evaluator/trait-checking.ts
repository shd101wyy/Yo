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

import { synthesizeTypes } from "./types/synthesizer";
import { type Environment, getWhereClauseConstraintsForSomeType } from "../env";
import { formatErrorMessage } from "../error";
import type { Token } from "../token";
import { areTypesCompatible } from "../types/compatibility";
import type {
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
  isFunctionType,
  isFutureTraitType,
  isSourceNamespaceType,
  isPtrType,
  isSomeType,
  isStructType,
  isTypeHierarchyType,
} from "../types/guards";
import { TypeTag } from "../types/tags";
import { typeContainsSomeType, typeToString } from "../types/utils";
import { isTraitValue, isTypeValue, type TraitValue } from "../value";
import type { EvaluatorContext } from "./context";
import {
  findAssociatedTypeFromGenericImpls,
  findMatchingGenericImpl,
  findMatchingNegativeGenericImpl,
  hasNegativeImpl,
  isConcreteImplBeingRegistered,
} from "./values/impl";

/**
 * Recursion guard to prevent infinite loops when checking trait implementations.
 * This can happen with impls that have where clauses referencing the same trait.
 * For example: impl(forall(T : Type), where(T <: Runtime), *(T), Runtime())
 * When checking if *(SomeType) implements Runtime, it would recursively check
 * if SomeType implements Runtime, which could loop indefinitely.
 */
const traitCheckRecursionGuard = new Set<string>();

/**
 * Tracks concrete impls currently being registered.
 * Used to handle recursive types (e.g., TreeNode: Clone where TreeNode contains Box(TreeNode)).
 * When `impl(TreeNode, Clone(...))` is being processed, its function bodies are validated
 * before the impl is formally registered. This set lets `typeImplementsTrait` return `true`
 * for `TreeNode: Clone` during that window.
 *
 * Key format: `${typeId}:${traitTypeId}`
 */
const currentlyRegisteringConcreteImpls = new Set<string>();

export function markConcreteImplBeingRegistered(
  typeId: string,
  traitId: string
): void {
  currentlyRegisteringConcreteImpls.add(`${typeId}:${traitId}`);
}

export function unmarkConcreteImplBeingRegistered(
  typeId: string,
  traitId: string
): void {
  currentlyRegisteringConcreteImpls.delete(`${typeId}:${traitId}`);
}

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

  // Module structs (formerly SourceNamespaceType) are always comptime-only.
  if (isSourceNamespaceType(type)) {
    return true;
  }

  switch (type.tag) {
    // Comptime-only types - always return true
    case TypeTag.ComptimeInt:
    case TypeTag.ComptimeFloat:
    case TypeTag.ComptimeString:
    case TypeTag.Type:
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
    case TypeTag.Str:
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

  // Module structs (formerly SourceNamespaceType) are always comptime-only, never runtime.
  if (isSourceNamespaceType(type)) {
    return false;
  }

  switch (type.tag) {
    // Comptime-only types - do NOT implement Runtime
    case TypeTag.ComptimeInt:
    case TypeTag.ComptimeFloat:
    case TypeTag.ComptimeString:
    case TypeTag.Type:
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
    case TypeTag.Str:
    case TypeTag.Function:
    case TypeTag.Union: {
      return true;
    }
  }

  return undefined;
}

/**
 * Check if a concrete type satisfies associated type constraints on a specialized trait.
 * e.g., for Iterator(Item := i32), verify that targetType's Iterator.Item resolves to i32.
 *
 * Returns `{ satisfied, env }` where `env` includes any SomeType bindings produced by
 * matching constraint types against resolved associated types (e.g., `Item := A` against
 * `Item = i32` produces `A = i32` via synthesizeTypes).
 */
function checkAssociatedTypeConstraints(
  targetType: Type,
  traitType: TraitType,
  env: Environment
): { satisfied: boolean; env: Environment } {
  if (
    !traitType.associatedTypeConstraints ||
    traitType.associatedTypeConstraints.length === 0
  ) {
    return { satisfied: true, env };
  }

  for (const constraint of traitType.associatedTypeConstraints) {
    // Try to resolve the associated type from the target type
    let resolvedType: Type | undefined;

    // 1. Check direct trait fields on targetType
    if (targetType.trait) {
      for (const field of targetType.trait.fields) {
        // Direct associated type field (e.g., from anonymous trait flattening)
        if (
          field.label === constraint.label &&
          field.assignedValue &&
          isTypeValue(field.assignedValue)
        ) {
          resolvedType = field.assignedValue.value;
          break;
        }
        // Look inside TraitValues whose trait matches the constraint's trait
        if (field.assignedValue && isTraitValue(field.assignedValue)) {
          const traitValue = field.assignedValue as TraitValue;
          if (traitValue.type.id === traitType.id) {
            for (let i = 0; i < traitValue.type.fields.length; i++) {
              const traitField = traitValue.type.fields[i]!;
              if (traitField.label === constraint.label) {
                const fieldValue = traitValue.fields[i];
                if (fieldValue && isTypeValue(fieldValue)) {
                  resolvedType = fieldValue.value;
                }
                break;
              }
            }
          }
          if (resolvedType) break;
        }
      }
    }

    // 2. Check generic impls
    if (!resolvedType) {
      const result = findAssociatedTypeFromGenericImpls({
        concreteType: targetType,
        propertyName: constraint.label,
        env,
      });
      if (result && isTypeValue(result.value)) {
        resolvedType = result.value.value;
      }
    }

    if (!resolvedType) {
      return { satisfied: false, env };
    }

    // Check if the resolved type matches the constraint
    if (
      !areTypesCompatible(
        { type: constraint.constraintType, env },
        { type: resolvedType, env }
      )
    ) {
      return { satisfied: false, env };
    }

    // Propagate SomeType bindings from constraint matching.
    // e.g., constraint `Item := SomeType_A` resolved to `i32` → binds A=i32.
    const { expectedEnv } = synthesizeTypes(
      { type: constraint.constraintType, env },
      { type: resolvedType, env }
    );
    env = expectedEnv;
  }

  return { satisfied: true, env };
}

/**
 * Check if a type implements a specific trait.
 *
 * Returns both an `implemented` boolean and the updated `env` with any
 * type bindings inferred during trait matching propagated back. When a
 * where-clause constraint such as `where(Self <: Iterator(Item := A))`
 * is checked against a target type whose impl provides `Iterator(Item := i32)`,
 * the SomeType `A` gets bound to `i32` in the returned env via synthesizeTypes.
 *
 * Use `typeImplementsTraitBool` when only the boolean result is needed.
 */
export function typeImplementsTrait({
  targetType,
  traitType,
  env,
}: {
  targetType: Type;
  traitType: TraitType;
  env: Environment;
}): { implemented: boolean; env: Environment } {
  // 0. Phase N: Negative-impl check — runs first, authoritative.
  // If the type has a registered negative impl for this trait (concrete or
  // generic), it does NOT implement the trait regardless of auto-derive.
  if (hasNegativeImpl(targetType.id, traitType.id)) {
    return { implemented: false, env };
  }
  if (
    isStructType(targetType) &&
    findMatchingNegativeGenericImpl(targetType, traitType, env)
  ) {
    return { implemented: false, env };
  }

  // 1. Comptime builtin check
  const comptimeTraitType = getTraitTypeFromEnv(env, "Comptime");
  if (comptimeTraitType && traitType.id === comptimeTraitType.id) {
    const builtin = typeImplementsComptimeBuiltin(targetType);
    if (builtin !== undefined) {
      return { implemented: builtin, env };
    }
  }

  // 2. Runtime builtin check
  const runtimeTraitType = getTraitTypeFromEnv(env, "Runtime");
  if (runtimeTraitType && traitType.id === runtimeTraitType.id) {
    const builtin = typeImplementsRuntimeBuiltin(targetType);
    if (builtin !== undefined) {
      return { implemented: builtin, env };
    }
  }

  // 3. Fn-trait satisfaction with binding propagation: synth the trait's call
  // type against the target function type so SomeTypes in parameter/return
  // positions (e.g. `Fn(a:A) -> B` against `fn(x:i32) -> i32`) get bound.
  // This mirrors Rust's rule that `fn` items implement `Fn`/`FnMut`/`FnOnce`.
  if (isFnTraitType(traitType) && isFunctionType(targetType)) {
    if (
      !areTypesCompatible(
        { type: traitType.isFn.callType, env },
        { type: targetType, env }
      )
    ) {
      return { implemented: false, env };
    }
    const { expectedEnv } = synthesizeTypes(
      { type: traitType.isFn.callType, env },
      { type: targetType, env }
    );
    return { implemented: true, env: expectedEnv };
  }

  // 4. Direct trait field match with associated-type binding propagation.
  // SomeTypes in the constraint trait (e.g. `Item := A`) get bound to the
  // impl's concrete values (e.g. `Item := i32`).
  if (targetType.trait) {
    const expectedTraitWithReceiver: TraitType = {
      ...traitType,
      receiverType: targetType,
    };
    for (const field of targetType.trait.fields) {
      if (!field.assignedValue || !isTraitValue(field.assignedValue)) {
        continue;
      }
      const fieldTraitType = (field.assignedValue as TraitValue).type;
      if (
        !areTypesCompatible(
          { type: expectedTraitWithReceiver, env },
          { type: fieldTraitType, env }
        )
      ) {
        continue;
      }
      const assocResult = checkAssociatedTypeConstraints(
        targetType,
        traitType,
        env
      );
      if (!assocResult.satisfied) {
        continue;
      }
      const { expectedEnv } = synthesizeTypes(
        { type: expectedTraitWithReceiver, env: assocResult.env },
        { type: fieldTraitType, env: assocResult.env }
      );
      return { implemented: true, env: expectedEnv };
    }
  }

  // 5. DynType: check required traits and their selfConstraints.
  // If Dyn(TraitA) and TraitA has where(Self <: TraitB), then Dyn(TraitA) implements TraitB.
  if (isDynType(targetType)) {
    for (const { traitType: requiredTrait } of targetType.requiredTraits) {
      if (requiredTrait.id === traitType.id) {
        return { implemented: true, env };
      }
      if (requiredTrait.selfConstraints) {
        for (const constraint of requiredTrait.selfConstraints) {
          if (constraint.id === traitType.id) {
            return { implemented: true, env };
          }
        }
      }
    }
    for (const { traitType: negativeTrait } of targetType.negativeTraits) {
      if (negativeTrait.id === traitType.id) {
        return { implemented: false, env };
      }
    }
  }

  // 6. SomeType where-clause check.
  // Constraints are stored in the current env frames (not on SomeType itself).
  if (isSomeType(targetType)) {
    let foundRequiredTraitInConstraints = false;
    let foundNegativeTraitInConstraints = false;

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

    if (targetType.negativeTraits) {
      for (const negativeTraitEntry of targetType.negativeTraits) {
        if (negativeTraitEntry.traitType.id === traitType.id) {
          foundNegativeTraitInConstraints = true;
        }
      }
    }

    if (foundRequiredTraitInConstraints) {
      return { implemented: !foundNegativeTraitInConstraints, env };
    } else if (foundNegativeTraitInConstraints) {
      return { implemented: false, env };
    }
  }

  // 7. Resolve SomeType to its concrete type before checking generic impls.
  if (isSomeType(targetType)) {
    const resolvedType = getValueOfSomeTypeFromEnv(env, targetType);
    if (isSomeType(resolvedType)) {
      return { implemented: false, env };
    }
    targetType = resolvedType;
  }

  // 7.5. Check if this concrete impl is currently being registered.
  // This handles recursive types: when `impl(TreeNode, Clone(...))` is being
  // evaluated, its function bodies see `Box(TreeNode): Clone` which requires
  // `TreeNode: Clone` — but that impl is in progress. Return true to unblock.
  if (
    currentlyRegisteringConcreteImpls.has(`${targetType.id}:${traitType.id}`)
  ) {
    return { implemented: true, env };
  }

  // 7.5. Check if a non-generic concrete impl for this type+trait is currently
  // being registered (handles recursive types like TreeNode containing Box(Self)
  // with derive(TreeNode, Clone)). The impl hasn't been added to the registry yet
  // but is guaranteed to exist once registration completes.
  if (isConcreteImplBeingRegistered(targetType.id, traitType.typeName ?? "")) {
    return { implemented: true, env };
  }

  // 8. Generic impl registry.
  // Use a recursion guard to prevent infinite loops when checking impls with
  // where clauses — e.g. `impl(forall(T), where(T <: Runtime), *(T), Runtime())`
  // would recurse when checking if *(SomeType) implements Runtime.
  const guardKey = `${targetType.id}:${traitType.id}`;
  if (traitCheckRecursionGuard.has(guardKey)) {
    return { implemented: false, env };
  }
  traitCheckRecursionGuard.add(guardKey);
  try {
    const result = findMatchingGenericImpl({
      concreteType: targetType,
      traitType,
      env,
    });
    if (result === undefined) {
      return { implemented: false, env };
    }
    const assocResult = checkAssociatedTypeConstraints(
      targetType,
      traitType,
      env
    );
    return {
      implemented: assocResult.satisfied,
      env: assocResult.env,
    };
  } finally {
    traitCheckRecursionGuard.delete(guardKey);
  }
}

/**
 * Boolean wrapper around typeImplementsTrait for callers that only need
 * a yes/no answer and do not require associated-type binding propagation.
 */
export function typeImplementsTraitBool({
  targetType,
  traitType,
  env,
}: {
  targetType: Type;
  traitType: TraitType;
  env: Environment;
}): boolean {
  return typeImplementsTrait({ targetType, traitType, env }).implemented;
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
        !typeImplementsTraitBool({
          targetType,
          traitType: constraintTrait,
          env,
        })
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
        typeImplementsTraitBool({ targetType, traitType: constraintTrait, env })
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

  return typeImplementsTraitBool({
    targetType: type,
    traitType: comptimeTraitType,
    env,
  });
}

/**
 * Validate that all SomeTypes within a type have the Comptime constraint.
 *
 * Unlike typeImplementsComptime which relies on the generic impl registry
 * (and may fail due to impl registration order), this function does structural
 * checking: it walks the type tree and verifies each SomeType has a Comptime
 * constraint. For compound types like *(T), it checks inner types recursively.
 *
 * Use this at trait/function definition time where impls may not be registered yet.
 *
 * Returns the first SomeType missing Comptime, or undefined if all are valid.
 */
export function findSomeTypeMissingComptimeConstraint(
  type: Type,
  env: Environment
): SomeType | undefined {
  // For concrete types that are always comptime, no constraint needed
  const builtin = typeImplementsComptimeBuiltin(type);
  if (builtin === true) {
    return undefined;
  }
  if (builtin === false) {
    // Runtime-only type can't be comptime regardless — but this function
    // is about SomeType constraints. If there's no SomeType involved,
    // the regular typeProhibitsComptimeModifier check handles this case.
    return undefined;
  }

  // SomeType — check if it has Comptime constraint
  if (isSomeType(type)) {
    const comptimeTraitType = getTraitTypeFromEnv(env, "Comptime");
    if (!comptimeTraitType) {
      return type;
    }

    // Check requiredTraits
    for (const entry of type.requiredTraits) {
      if (entry.traitType.id === comptimeTraitType.id) {
        return undefined;
      }
    }

    // Check where-clause constraints
    const whereConstraints = getWhereClauseConstraintsForSomeType(env, type);
    if (whereConstraints) {
      for (const trait of whereConstraints.requiredTraits) {
        if (trait.id === comptimeTraitType.id) {
          return undefined;
        }
      }
    }

    // No Comptime constraint found
    return type;
  }

  // Pointer *(T) — T must implement Comptime
  if (isPtrType(type)) {
    return findSomeTypeMissingComptimeConstraint(type.childType, env);
  }

  // For other compound types (arrays, slices, structs, enums), we don't
  // have a structural rule for determining Comptime — they depend on their
  // generic impl. At definition time, we can only check that any SomeTypes
  // directly appearing have the constraint. The generic impl registry
  // will enforce this at specialization time.

  return undefined;
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

  return typeImplementsTraitBool({
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
/**
 * Set of type IDs currently undergoing Send auto-derivation.
 * Used to break cycles in self-referential types like `atomic object(_next: Option(Self))`.
 * When a type is in this set and encountered during Send checking, it's assumed to be Send.
 */
const sendDerivationInProgress = new Set<string>();

/**
 * Mark a type as currently undergoing Send auto-derivation.
 * Call `endSendDerivation(id)` when done.
 */
export function beginSendDerivation(typeId: string): void {
  sendDerivationInProgress.add(typeId);
}

/**
 * Remove a type from the Send auto-derivation in-progress set.
 */
export function endSendDerivation(typeId: string): void {
  sendDerivationInProgress.delete(typeId);
}

export function typeImplementsSend(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  // Break cycles: if this type is currently being checked for Send derivation,
  // optimistically assume it implements Send. This handles self-referential types
  // like `atomic object(_next: Option(Self))` where the Send check would recurse.
  if (sendDerivationInProgress.has(type.id)) {
    return true;
  }

  const sendTraitType = getTraitTypeFromEnv(env, "Send");
  if (!sendTraitType) {
    return false;
  }

  return typeImplementsTraitBool({
    targetType: type,
    traitType: sendTraitType,
    env,
  });
}

/**
 * Check if a type implements the Dispose trait.
 */
export function typeImplementsDispose(
  type: Type | undefined,
  env: Environment
): boolean {
  if (!type) {
    return false;
  }

  const disposeTraitType = getTraitTypeFromEnv(env, "Dispose");
  if (!disposeTraitType) {
    return false;
  }

  return typeImplementsTraitBool({
    targetType: type,
    traitType: disposeTraitType,
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

  return typeImplementsTraitBool({
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
    // Look through resolvedConcreteType chain - a forall SomeType may have its
    // Fn trait constraint stored on a wrapper Impl(Fn(...)) SomeType assigned as
    // resolvedConcreteType (see anonymous-function.ts where wrapperType has its
    // resolvedConcreteType set to an implFnWrapper).
    if (isSomeType(type) && type.resolvedConcreteType) {
      return typeImplementsFn(type.resolvedConcreteType);
    }
  }

  return false;
}

/**
 * Extract FnTraitType from a type (e.g., from Impl(Fn(...) -> ...) or Dyn(Fn(...) -> ...) or FnTraitType directly)
 * Returns the FnTraitType if found, otherwise undefined.
 */
export function extractFnTraitFromType(
  type: Type,
  env?: Environment
): FnTraitType | undefined {
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
    // Look through resolvedConcreteType chain (see typeImplementsFn for context).
    if (isSomeType(type) && type.resolvedConcreteType) {
      const fromConcrete = extractFnTraitFromType(
        type.resolvedConcreteType,
        env
      );
      if (fromConcrete) return fromConcrete;
    }
  }
  // A forall parameter `F : Type` constrained as `where(F <: (Fn(...) -> ...))`
  // stores the Fn trait constraint in env.whereClauseConstraints, NOT in
  // F.requiredTraits. Without checking here, lambda type-resolution at call
  // sites that pass `f : F` would fail with "Expected a function type".
  if (env && isSomeType(type)) {
    const constraints = getWhereClauseConstraintsForSomeType(env, type);
    if (constraints) {
      for (const traitType of constraints.requiredTraits) {
        if (isFnTraitType(traitType)) {
          return traitType;
        }
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
  _context?: EvaluatorContext
): void {
  // If the type still contains SomeType placeholders, defer availability checks.
  if (typeContainsSomeType(type)) {
    return;
  }

  if (!typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env)) {
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
