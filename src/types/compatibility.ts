import { type Environment, getWhereClauseConstraintsForSomeType } from "../env";
import { typeImplementsTraitBool } from "../evaluator/trait-checking";
import {
  canAssignTypeHierarchy,
  synthesizeTypes,
} from "../evaluator/types/synthesizer";
import { areValuesEqual } from "../value";
import type {
  FunctionType,
  SomeType,
  TraitType,
  Type,
  TypeApplicationType,
} from "./definitions";
import { getValueOfSomeTypeFromEnv } from "./env-lookup";
import {
  isArrayType,
  isCCompatibleType,
  isCharType,
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeListType,
  isComptimeStringType,
  isStrType,
  isDynType,
  isEnumType,
  isExprType,
  isFnTraitType,
  isFunctionType,
  isFutureTraitType,
  isIsoType,
  isSourceNamespaceType,
  isPrimitiveType,
  isPtrType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isTypeApplicationType,
  isTypeHierarchyType,
  isU8Type,
  isUnionType,
} from "./guards";
import { TypeTag } from "./tags";
import { typeContainsSomeType } from "./utils";

function getEffectiveRequiredTraitTypes(
  env: Environment,
  someType: SomeType
): TraitType[] {
  const traitMap = new Map<string, TraitType>();
  for (const entry of someType.requiredTraits ?? []) {
    traitMap.set(entry.traitType.id, entry.traitType);
  }

  const whereConstraints = getWhereClauseConstraintsForSomeType(env, someType);
  if (whereConstraints) {
    for (const traitType of whereConstraints.requiredTraits) {
      traitMap.set(traitType.id, traitType);
    }
  }

  return [...traitMap.values()];
}

function getEffectiveNegativeTraitTypes(
  env: Environment,
  someType: SomeType
): TraitType[] {
  const traitMap = new Map<string, TraitType>();
  for (const entry of someType.negativeTraits ?? []) {
    traitMap.set(entry.traitType.id, entry.traitType);
  }

  const whereConstraints = getWhereClauseConstraintsForSomeType(env, someType);
  if (whereConstraints) {
    for (const traitType of whereConstraints.negativeTraits) {
      traitMap.set(traitType.id, traitType);
    }
  }

  return [...traitMap.values()];
}

/**
 * Check if two types are compatible.
 * @param requireExactMatch If true, requires exact type equality rather than compatibility.
 *                          Used for method receivers and compile-time function cache comparisons.
 * @param visitedPairs Set of type ID pairs already being compared (for cycle detection)
 */
export function areTypesCompatible(
  expected: {
    type: Type;
    env: Environment;
  },
  given: {
    type: Type;
    env: Environment;
  },
  requireExactMatch = false,
  visitedPairs: Set<string> = new Set()
): boolean {
  // Cycle detection: only for types that can be recursive (struct, enum, union, object)
  // Don't apply to SomeType as the same SomeType ID can have different meanings in different contexts
  const expectedId = expected.type.id;
  const givenId = given.type.id;
  if (
    expectedId &&
    givenId &&
    (isStructType(expected.type) ||
      isEnumType(expected.type) ||
      isUnionType(expected.type)) &&
    (isStructType(given.type) ||
      isEnumType(given.type) ||
      isUnionType(given.type))
  ) {
    const pairKey = `${expectedId}:${givenId}`;
    if (visitedPairs.has(pairKey)) {
      // We're in a recursive comparison - assume compatible to break the cycle
      // This is safe because if the types were truly incompatible, we would have
      // found that out in a previous non-cyclic comparison path
      return true;
    }
    visitedPairs.add(pairKey);
  }

  if (isPrimitiveType(expected.type) && isPrimitiveType(given.type)) {
    return expected.type.tag === given.type.tag;
  }

  // str (builtin static string view): nominal by tag.
  if (isStrType(expected.type) && isStrType(given.type)) {
    return true;
  }

  // comptime_int can be converted to
  // - comptime_int
  // - u8
  // - i8
  // - u16
  // - i16
  // - u32
  // - i32
  // - u64
  // - i64
  // - usize
  // - isize
  if (
    (isComptimeIntType(expected.type) ||
      expected.type.tag === TypeTag.U8 ||
      expected.type.tag === TypeTag.I8 ||
      expected.type.tag === TypeTag.U16 ||
      expected.type.tag === TypeTag.I16 ||
      expected.type.tag === TypeTag.U32 ||
      expected.type.tag === TypeTag.I32 ||
      expected.type.tag === TypeTag.U64 ||
      expected.type.tag === TypeTag.I64 ||
      expected.type.tag === TypeTag.Usize ||
      expected.type.tag === TypeTag.Isize ||
      isCCompatibleType(expected.type)) &&
    isComptimeIntType(given.type)
  ) {
    if (requireExactMatch && !isComptimeIntType(expected.type)) {
      // If exact match is required, comptime_int cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // comptime_float can be converted to
  // - comptime_float
  // - f32
  // - f64
  if (
    (isComptimeFloatType(expected.type) ||
      expected.type.tag === TypeTag.F32 ||
      expected.type.tag === TypeTag.F64) &&
    isComptimeFloatType(given.type)
  ) {
    if (requireExactMatch && !isComptimeFloatType(expected.type)) {
      // If exact match is required, comptime_float cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // comptime_string can be converted to
  // - *(u8)    u8 pointer with \0 terminator
  // - *(char)  char pointer with \0 terminator
  // - str      static string view
  if (
    (isComptimeStringType(expected.type) ||
      (isPtrType(expected.type) && // *(u8) or *(char)
        (isU8Type(expected.type.childType) ||
          isCharType(expected.type.childType))) ||
      isStrType(expected.type)) && // str (builtin)
    isComptimeStringType(given.type)
  ) {
    return true;
  }

  // C compatible types can be converted to each other
  if (isCCompatibleType(expected.type) && isCCompatibleType(given.type)) {
    // C compatible types are compatible if they have the same tag
    return expected.type.tag === given.type.tag;
  }

  if (isExprType(expected.type) && isExprType(given.type)) {
    return true;
  }

  if (isComptimeListType(expected.type) && isComptimeListType(given.type)) {
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      requireExactMatch,
      visitedPairs
    );
  }

  if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Arrays must have same length and compatible element types
    return (
      areValuesEqual(
        { value: expected.type.length, env: expected.env },
        { value: given.type.length, env: given.env }
      ) &&
      areTypesCompatible(
        {
          type: expected.type.childType,
          env: expected.env,
        },
        { type: given.type.childType, env: given.env },
        requireExactMatch,
        visitedPairs
      )
    );
  }

  if (isTupleType(expected.type) && isTupleType(given.type)) {
    if (expected.type.fields.length !== given.type.fields.length) {
      return false;
    }
    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedTypeElement = expected.type.fields[i]!;
      const givenTypeElement = given.type.fields[i]!;

      if (
        !areTypesCompatible(
          { type: expectedTypeElement.type, env: expected.env },
          { type: givenTypeElement.type, env: given.env },
          requireExactMatch,
          visitedPairs
        )
      ) {
        return false;
      }

      // QUESTION: Should we check the label here?
      // NOTE: We don't check labels, as the Tuple is a structural type,
      //       not a nominal type.
    }
    return true;
  }

  if (isStructType(expected.type) && isStructType(given.type)) {
    /// if (
    ///   typeToString(expected.type).includes("Data") &&
    ///   typeToString(given.type).includes("Data")
    /// ) {
    ///   console.log(
    ///     `[DEBUG-COMPAT] Checking struct compatibility: expected=${typeToString(expected.type)}, given=${typeToString(given.type)}`
    ///   );
    ///   console.log(
    ///     `[DEBUG-COMPAT] ID match: ${expected.type.id === given.type.id}`
    ///   );
    ///   console.log(
    ///     `[DEBUG-COMPAT] expectedContainsSomeType: ${typeContainsSomeType(expected.type)}`
    ///   );
    ///   console.log(
    ///     `[DEBUG-COMPAT] givenContainsSomeType: ${typeContainsSomeType(given.type)}`
    ///   );
    /// }

    // Structs must have same fields and compatible types
    if (
      expected.type.fields.length !== given.type.fields.length ||
      // NOTE: Below is not necessarily true
      // We might compare Box(T) and Box(U), where T and U are SomeType.
      (expected.type.id !== given.type.id &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type) &&
        // If both structs come from the same type constructor (same funcId),
        // allow structural comparison even without SomeType in fields.
        // This handles cases like JoinHandle(T) where T is only used
        // in methods, not in struct fields themselves.
        !(
          expected.type.functionValue &&
          given.type.functionValue &&
          expected.type.functionValue.funcId === given.type.functionValue.funcId
        ))
    ) {
      return false;
    }

    if (expected.type.id === given.type.id) {
      return true;
    }

    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedFields = expected.type.fields[i]!;
      const givenFields = given.type.fields[i]!;

      if (
        expectedFields.label !== givenFields.label ||
        !areTypesCompatible(
          {
            type: expectedFields.type,
            env: expected.env,
          },
          { type: givenFields.type, env: given.env },
          requireExactMatch,
          visitedPairs
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (isEnumType(expected.type) && isEnumType(given.type)) {
    if (expected.type.id === given.type.id) {
      return true;
    }

    // Nominal check: if IDs differ and neither contains SomeType
    // and they don't share a type constructor, they are incompatible.
    if (
      expected.type.id !== given.type.id &&
      !typeContainsSomeType(expected.type) &&
      !typeContainsSomeType(given.type) &&
      !(
        expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue.funcId === given.type.functionValue.funcId
      )
    ) {
      return false;
    }

    // Check each variants
    if (expected.type.variants.length !== given.type.variants.length) {
      return false;
    }

    for (let i = 0; i < expected.type.variants.length; i++) {
      const expectedVariant = expected.type.variants[i]!;
      const givenVariant = given.type.variants[i]!;

      if (expectedVariant.name !== givenVariant.name) {
        return false;
      }

      if (expectedVariant.fields?.length !== givenVariant.fields?.length) {
        return false;
      }

      if (expectedVariant.fields) {
        for (let j = 0; j < expectedVariant.fields.length; j++) {
          const expectedFields = expectedVariant.fields![j]!;
          const givenFields = givenVariant.fields![j]!;

          if (
            expectedFields.label !== givenFields.label ||
            !areTypesCompatible(
              { type: expectedFields.type, env: expected.env },
              { type: givenFields.type, env: given.env },
              requireExactMatch,
              visitedPairs
            )
          ) {
            return false;
          }
        }
      }
    }

    if (
      expected.type.requiredVariantNames &&
      ((given.type.selectedVariantName &&
        !expected.type.requiredVariantNames.includes(
          given.type.selectedVariantName
        )) ||
        !given.type.selectedVariantName)
    ) {
      return false;
    } else if (!expected.type.selectedVariantName) {
      return true;
    } else {
      return false;
    }
  }

  if (isUnionType(expected.type) && isUnionType(given.type)) {
    // Unions must have same fields and compatible types
    if (
      expected.type.fields.length !== given.type.fields.length ||
      (expected.type.id !== given.type.id &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type))
    ) {
      return false;
    }

    if (expected.type.id === given.type.id) {
      return true;
    }

    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedFields = expected.type.fields[i]!;
      const givenFields = given.type.fields[i]!;

      if (
        expectedFields.label !== givenFields.label ||
        !areTypesCompatible(
          { type: expectedFields.type, env: expected.env },
          { type: givenFields.type, env: given.env },
          requireExactMatch,
          visitedPairs
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // Imported source namespaces are structural structs.
  if (
    isSourceNamespaceType(expected.type) &&
    isSourceNamespaceType(given.type)
  ) {
    // Source namespaces must have the same fields and compatible types.
    for (const expectedField of expected.type.fields) {
      const givenField = given.type.fields.find(
        (f) => f.label === expectedField.label
      );
      if (!givenField) {
        return false; // Field not found in given source namespace.
      }
      if (
        !areTypesCompatible(
          { type: expectedField.type, env: expected.env },
          { type: givenField.type, env: given.env },
          requireExactMatch,
          visitedPairs
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // NOTE: Trait type is now a NOMINAL type (compared by id).
  // Special cases: FnTraitType and FutureTraitType use structural comparison
  // because they are parameterized (e.g., Fn(x: i32) -> i32 vs Fn(y: string) -> string).
  if (isTraitType(expected.type)) {
    if (isTraitType(given.type)) {
      // Special case: FnTraitType uses structural comparison (function signature)
      if (isFnTraitType(expected.type)) {
        if (!isFnTraitType(given.type)) {
          return false; // Expected is callable but given is not
        }
        // Compare the function signatures
        if (
          !areFunctionTypesCompatible(
            { type: expected.type.isFn.callType, env: expected.env },
            { type: given.type.isFn.callType, env: given.env },
            requireExactMatch,
            visitedPairs
          )
        ) {
          return false;
        }
        // FnTraitType matched structurally
        return true;
      }

      // Special case: FutureTraitType uses structural comparison (output type + effects row)
      if (isFutureTraitType(expected.type)) {
        if (!isFutureTraitType(given.type)) {
          return false; // Expected is Future but given is not
        }
        // Compare the output types
        if (
          !areTypesCompatible(
            {
              type: expected.type.isFuture.outputType,
              env: expected.env,
            },
            { type: given.type.isFuture.outputType, env: given.env },
            requireExactMatch,
            visitedPairs
          )
        ) {
          return false;
        }
        // Compare the optional effect bundle. If either side omits its
        // effect annotation, treat the Futures as compatible — this keeps
        // unannotated `Future(T)` interoperable with annotated
        // `Future(T, E)` at use sites.
        const expectedEffect = expected.type.isFuture.effect;
        const givenEffect = given.type.isFuture.effect;
        if (expectedEffect && givenEffect) {
          if (
            !areTypesCompatible(
              { type: expectedEffect.type, env: expected.env },
              { type: givenEffect.type, env: given.env },
              requireExactMatch,
              visitedPairs
            )
          ) {
            return false;
          }
        }
        return true;
      }

      // Nominal comparison: modules are the same if they have the same id
      if (expected.type.id === given.type.id) {
        return true;
      }

      // Different ids = different modules (nominal typing)
      return false;
    }

    // QUESTION: Should we remove the check below?
    // Handle TypeHierarchyType with module
    if (
      isTypeHierarchyType(given.type) &&
      given.type.baseType &&
      given.type.baseType.trait &&
      isTraitType(expected.type)
    ) {
      // Compare the module from TypeHierarchyType with expected module
      return areTypesCompatible(
        { type: expected.type, env: expected.env },
        { type: given.type.baseType.trait, env: given.env },
        requireExactMatch,
        visitedPairs
      );
    }

    return false;
  }

  if (isFunctionType(expected.type) && isFunctionType(given.type)) {
    return areFunctionTypesCompatible(
      { type: expected.type, env: expected.env },
      { type: given.type, env: given.env },
      requireExactMatch,
      visitedPairs
    );
  }

  if (isTypeHierarchyType(expected.type) && isTypeHierarchyType(given.type)) {
    return canAssignTypeHierarchy(expected.type, given.type);
  }

  // *
  if (isPtrType(expected.type) && isPtrType(given.type)) {
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      true, // Always require exact match for pointer child types
      visitedPairs
    );
  }

  // Iso
  if (isIsoType(expected.type) && isIsoType(given.type)) {
    // Iso types must have compatible inner types
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      requireExactMatch,
      visitedPairs
    );
  }

  // void
  if (
    expected.type.tag === TypeTag.Void &&
    given.type.tag === TypeTag.Void
    // QUESTION: Do we need to check given.type if expected.type is already void?
    // For example: *(void) and *(i32) are compatible or not?
    // ANSWER: No, only void == void.
  ) {
    return true;
  }

  if (isDynType(expected.type) && isDynType(given.type)) {
    // Given type must implement ALL modules required by expected type
    // Example: expected `Dyn(Copy)` is compatible with given `Dyn(Copy, Send)`
    for (const { traitType: expectedTrait } of expected.type.requiredTraits) {
      const matchingGivenTrait = given.type.requiredTraits.find(
        ({ traitType: givenTrait }) =>
          areTypesCompatible(
            { type: expectedTrait, env: expected.env },
            { type: givenTrait, env: given.env },
            requireExactMatch,
            visitedPairs
          )
      );
      if (!matchingGivenTrait) {
        return false; // Expected module not found in given
      }
    }

    // Check negative modules: given must NOT implement any of expected's negative modules
    if (
      expected.type.negativeTraits &&
      expected.type.negativeTraits.length > 0
    ) {
      for (const { traitType: negativeTrait } of expected.type.negativeTraits) {
        const matchingGivenTrait = given.type.requiredTraits.find(
          ({ traitType: givenTrait }) =>
            areTypesCompatible(
              { type: negativeTrait, env: expected.env },
              { type: givenTrait, env: given.env },
              requireExactMatch,
              visitedPairs
            )
        );
        if (matchingGivenTrait) {
          return false; // Given implements a module that expected forbids
        }
      }
    }

    return true;
  }

  // Meet SomeType,
  // eg: x: T
  // here T should already be added to env by the if condition above ^^^
  if (isSomeType(expected.type)) {
    if (isDynType(given.type)) {
      // DynType is compatible with SomeType, but if the SomeType has
      // required traits, verify the DynType's traits satisfy them.
      if (expected.type.requiredTraits.length > 0) {
        for (const { traitType: requiredTrait } of expected.type
          .requiredTraits) {
          const satisfied = given.type.requiredTraits.some(
            ({ traitType: dynTrait }) =>
              areTypesCompatible(
                { type: requiredTrait, env: expected.env },
                { type: dynTrait, env: given.env },
                false,
                visitedPairs
              )
          );
          if (!satisfied) {
            return false;
          }
        }
      }
      return true;
    }

    if (isSomeType(given.type)) {
      // Check reference equality first
      if (expected.type === given.type) {
        return true;
      }

      if (expected.type.id === given.type.id) {
        if (!expected.type.resolvedConcreteType) {
          // given might or might not have resolvedConcreteType
          return true;
        } else {
          if (given.type.resolvedConcreteType) {
            return areTypesCompatible(
              { type: expected.type.resolvedConcreteType, env: expected.env },
              { type: given.type.resolvedConcreteType, env: given.env },
              requireExactMatch, // Pass through requireExactMatch for cache comparisons
              visitedPairs
            );
          } else {
            return false;
          }
        }
      }

      // When comparing two SomeTypes with different IDs:
      // - For cache comparisons (requireExactMatch=true): we need to check if they can unify
      // - Two type parameters can unify if they have compatible constraints (requiredTraits)
      //
      // The key insight is that even with requireExactMatch=true, two different type parameters
      // like T from impl(forall(T: Type), *(T), ...) and T from ArrayList should be allowed
      // to unify because they represent "any type" with the same constraints.
      //
      // We only reject if:
      // 1. They have different constraint counts (with requireExactMatch)
      // 2. Their constraints are incompatible
      // 3. Their resolvedConcreteTypes are incompatible

      // Check required modules compatibility:
      // Given type must implement ALL modules required by expected type
      // Example: expected `Impl(Send)` is compatible with given `Impl(Send, Copy)`
      // However, if requireExactMatch is true, the modules must match exactly (same count and types)

      // Use effective requiredTraits (SomeType + scoped where constraints)
      const expectedTraits = getEffectiveRequiredTraitTypes(
        expected.env,
        expected.type
      );
      const givenTraits = getEffectiveRequiredTraitTypes(given.env, given.type);

      // For exact matching (e.g., cache comparisons), require same number of traits.
      if (requireExactMatch && expectedTraits.length !== givenTraits.length) {
        return false;
      }

      // Check that all expected traits are present in given traits.
      for (const expectedTrait of expectedTraits) {
        const matchingGivenTrait = givenTraits.find((givenTrait) => {
          // Compare by trait compatibility.
          return areTypesCompatible(
            { type: expectedTrait, env: expected.env },
            { type: givenTrait, env: given.env },
            requireExactMatch,
            visitedPairs
          );
        });
        if (!matchingGivenTrait) {
          return false; // Expected module not found in given
        }
      }

      // Check negative modules: given must NOT implement any of expected's negative modules
      const expectedNegativeTraits = getEffectiveNegativeTraitTypes(
        expected.env,
        expected.type
      );
      if (expectedNegativeTraits.length > 0) {
        for (const negativeTrait of expectedNegativeTraits) {
          const matchingGivenTrait = givenTraits.find((givenTrait) =>
            areTypesCompatible(
              { type: negativeTrait, env: expected.env },
              { type: givenTrait, env: given.env },
              requireExactMatch,
              visitedPairs
            )
          );
          if (matchingGivenTrait) {
            return false; // Given implements a module that expected forbids
          }
        }
      }

      // If both have resolvedConcreteType, check they are compatible
      if (
        expected.type.resolvedConcreteType &&
        given.type.resolvedConcreteType
      ) {
        if (
          !areTypesCompatible(
            { type: expected.type.resolvedConcreteType, env: expected.env },
            { type: given.type.resolvedConcreteType, env: given.env },
            requireExactMatch, // Pass through requireExactMatch for cache comparisons
            visitedPairs
          )
        ) {
          return false;
        }
      } else if (requireExactMatch) {
        // For exact matching (cache comparisons), both must have resolvedConcreteType
        // or neither should have it
        if (
          expected.type.resolvedConcreteType ||
          given.type.resolvedConcreteType
        ) {
          return false;
        }
      }

      // If we got here, the required modules are compatible
      // The types are compatible if:
      // 1. They implement the same modules (checked above)
      // 2. resolvedConcreteType is compatible (checked above)
      // 3. No negative module violations (checked above)
      return true;
    } else {
      // Given is a concrete type, expected is SomeType (e.g., Impl(Trait))

      // If the SomeType already has a resolvedConcreteType, compare against that
      if (expected.type.resolvedConcreteType) {
        return areTypesCompatible(
          { type: expected.type.resolvedConcreteType, env: expected.env },
          given,
          requireExactMatch,
          visitedPairs
        );
      }

      // Check if given implements all required modules of expected
      const requiredTraitTypes = getEffectiveRequiredTraitTypes(
        expected.env,
        expected.type
      );

      // Unconstrained SomeType (bare forall type parameter like T : Type with no
      // required traits and no where-clause constraints) is compatible with any
      // concrete type. This is the semantics of a universal type parameter.
      // However, for exact matching (cache comparisons), an unconstrained SomeType
      // should NOT match a concrete type — they are different types.
      if (requiredTraitTypes.length === 0) {
        if (requireExactMatch) {
          return false;
        }
        return true;
      }
      if (requiredTraitTypes.length > 0) {
        // Check that given implements all required modules
        for (const requiredTrait of requiredTraitTypes) {
          if (
            !typeImplementsTraitBool({
              targetType: given.type,
              traitType: requiredTrait,
              env: expected.env,
            })
          ) {
            // Given doesn't implement this required module
            // Fall through to try getValueOfSomeTypeFromEnv as fallback
            break;
          }
        }
        // All required modules are implemented
        // Check negative modules if any
        const negativeTraitTypes = getEffectiveNegativeTraitTypes(
          expected.env,
          expected.type
        );
        if (negativeTraitTypes.length > 0) {
          for (const negativeTrait of negativeTraitTypes) {
            if (
              typeImplementsTraitBool({
                targetType: given.type,
                traitType: negativeTrait,
                env: expected.env,
              })
            ) {
              return false; // Given implements a forbidden module
            }
          }
        }
        // All checks passed - given type implements all required modules
        // and doesn't implement any forbidden modules
        let allModulesImplemented = true;
        for (const requiredTrait of requiredTraitTypes) {
          if (
            !typeImplementsTraitBool({
              targetType: given.type,
              traitType: requiredTrait,
              env: expected.env,
            })
          ) {
            allModulesImplemented = false;
            break;
          }
        }
        if (allModulesImplemented) {
          return true;
        }
      }

      // Fallback: try to resolve SomeType from env (for generic type parameters)
      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      if (expected.type === expectedType_) {
        // SomeType is unbound (not resolved in env). An unbound type parameter
        // cannot be proven compatible with any concrete type.
        return false;
      }
      return areTypesCompatible(
        { type: expectedType_, env: expected.env },
        given,
        requireExactMatch,
        visitedPairs
      );
    }
  } else if (isSomeType(given.type)) {
    // First check if the given SomeType has a resolvedConcreteType that matches expected
    // This is important for Future value types where the SomeType (Impl(Future(T)))
    // has a resolvedConcreteType (the capture struct) that should match the method parameter
    if (
      given.type.resolvedConcreteType &&
      areTypesCompatible(
        expected,
        { type: given.type.resolvedConcreteType, env: given.env },
        requireExactMatch,
        visitedPairs
      )
    ) {
      return true;
    }

    const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);
    if (given.type === givenType_) {
      // SomeType is unbound (not resolved in env). An unbound type parameter
      // cannot be proven compatible with any concrete type.
      return false;
    }
    return areTypesCompatible(
      expected,
      { type: givenType_, env: given.env },
      requireExactMatch,
      visitedPairs
    );
  }

  // TypeApplication compatibility: TypeApp(F, [A]) ≡ TypeApp(G, [B]) iff F≡G and A≡B
  if (
    isTypeApplicationType(expected.type) &&
    isTypeApplicationType(given.type)
  ) {
    const expectedApp = expected.type as TypeApplicationType;
    const givenApp = given.type as TypeApplicationType;

    // Same constructor (by SomeType identity)
    if (expectedApp.constructor.id !== givenApp.constructor.id) {
      return false;
    }

    // Same number of args
    if (expectedApp.args.length !== givenApp.args.length) {
      return false;
    }

    // All args compatible
    return expectedApp.args.every((expectedArg, i) =>
      areTypesCompatible(
        { type: expectedArg, env: expected.env },
        { type: givenApp.args[i]!, env: given.env },
        requireExactMatch,
        visitedPairs
      )
    );
  }

  return false;
}

/**
 * Check if two function types are compatible.
 * @param expectedType The expected function type.
 * @param givenType The given function type.
 * @param requireExactMatch If true, requires exact type equality rather than compatibility.
 * @returns
 */
export function areFunctionTypesCompatible(
  expected: {
    type: FunctionType;
    env: Environment;
  },
  given: {
    type: FunctionType;
    env: Environment;
  },
  requireExactMatch = false,
  visitedPairs: Set<string> = new Set()
): boolean {
  if (expected.type === given.type) {
    return true;
  }

  // §4 typing rule 5: subtyping `fn <: ctl`. A regular `fn(...) -> ret`
  // value is assignable to a `ctl(...) -> ret` slot (covariant — a
  // non-unwinder is valid where unwind is permitted). The reverse is
  // unsafe: a `ctl(...) -> ret` value MAY contain `unwind`, and a `fn`
  // slot expects calls that don't unwind. Reject `ctl → fn`.
  //
  // requireExactMatch overrides subtyping — both sides must agree.
  const expectedIsControl = expected.type.isControl === true;
  const givenIsControl = given.type.isControl === true;
  if (requireExactMatch) {
    if (expectedIsControl !== givenIsControl) {
      return false;
    }
  } else {
    if (givenIsControl && !expectedIsControl) {
      return false;
    }
  }

  // Check if the type parameters have the same count
  if (expected.type.parameters.length !== given.type.parameters.length) {
    return false;
  }

  // Check if the parameters have the same count
  if (
    expected.type.forallParameters.length !== given.type.forallParameters.length
  ) {
    return false;
  }

  // Synthesize the types
  try {
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type,
        env: expected.env,
      },
      {
        type: given.type,
        env: given.env,
      }
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } catch {
    // Synthesis failed, types are incompatible
    return false;
  }

  // Check type parameters for compatibility
  for (let i = 0; i < expected.type.forallParameters.length; i++) {
    const expectedTypeParam = expected.type.forallParameters[i]!;
    const givenTypeParam = given.type.forallParameters[i]!;

    /**
     * Check if
     * Type == Type
     * Linear == Linear
     * Free == Free
     */
    if (
      !areTypesCompatible(
        { type: expectedTypeParam.type, env: expected.env },
        { type: givenTypeParam.type, env: given.env },
        requireExactMatch,
        visitedPairs
      )
    ) {
      return false;
    }
  }

  // Check regular parameters for compatibility
  for (let i = 0; i < expected.type.parameters.length; i++) {
    const expectedParam = expected.type.parameters[i]!;
    const givenParam = given.type.parameters[i]!;

    if (expectedParam.isCompileTimeOnly !== givenParam.isCompileTimeOnly) {
      return false;
    }

    if (
      !areTypesCompatible(
        {
          type: expectedParam.type,
          env: expected.env,
        },
        {
          type: givenParam.type,
          env: given.env,
        },
        requireExactMatch,
        visitedPairs
      )
    ) {
      return false;
    }
  }

  const returnTypesMatch = areTypesCompatible(
    { type: expected.type.return.type, env: expected.env },
    { type: given.type.return.type, env: given.env },
    requireExactMatch,
    visitedPairs
  );
  return returnTypesMatch;
}
