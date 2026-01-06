import { Environment } from "../env";
import {
  canAssignTypeHierarchy,
  synthesizeTypes,
} from "../evaluator/types/synthesizer";
import { areValuesEqual } from "../value";
import { FunctionType, Type } from "./definitions";
import {
  isArrayType,
  isCCompatibleType,
  isCharType,
  isComptFloatType,
  isComptIntType,
  isComptListType,
  isComptStringType,
  isDynType,
  isEnumType,
  isExprType,
  isFnModuleType,
  isFunctionType,
  isFutureModuleType,
  isIsoType,
  isModuleType,
  isPrimitiveType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  isU8Type,
  isUnionType,
} from "./guards";
import { TypeTag } from "./tags";
import {
  getValueOfSomeTypeFromEnv,
  typeContainsSomeType,
  typeImplementsModuleInternal,
} from "./utils";

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
  visitedPairs: Set<string> = new Set(),
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

  // compt_int can be converted to
  // - compt_int
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
    (isComptIntType(expected.type) ||
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
    isComptIntType(given.type)
  ) {
    if (requireExactMatch && !isComptIntType(expected.type)) {
      // If exact match is required, compt_int cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // compt_float can be converted to
  // - compt_float
  // - f32
  // - f64
  if (
    (isComptFloatType(expected.type) ||
      expected.type.tag === TypeTag.F32 ||
      expected.type.tag === TypeTag.F64) &&
    isComptFloatType(given.type)
  ) {
    if (requireExactMatch && !isComptFloatType(expected.type)) {
      // If exact match is required, compt_float cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // compt_string can be converted to
  // - [u8]  u8 slice
  // - *(u8)    u8 pointer with \0 terminator
  // - *(char)  char pointer with \0 terminator
  if (
    (isComptStringType(expected.type) ||
      (isSliceType(expected.type) && // [u8]
        isU8Type(expected.type.childType)) ||
      (isPtrType(expected.type) && // *(u8) or *(char)
        (isU8Type(expected.type.childType) ||
          isCharType(expected.type.childType)))) &&
    isComptStringType(given.type)
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

  if (isComptListType(expected.type) && isComptListType(given.type)) {
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      requireExactMatch,
      visitedPairs,
    );
  }

  if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Arrays must have same length and compatible element types
    return (
      areValuesEqual(
        { value: expected.type.length, env: expected.env },
        { value: given.type.length, env: given.env },
      ) &&
      areTypesCompatible(
        {
          type: expected.type.childType,
          env: expected.env,
        },
        { type: given.type.childType, env: given.env },
        requireExactMatch,
        visitedPairs,
      )
    );
  }

  if (isSliceType(expected.type) && isSliceType(given.type)) {
    // Slices must have compatible element types
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      requireExactMatch,
      visitedPairs,
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
          visitedPairs,
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
          {
            type: expectedFields.type,
            env: expected.env,
          },
          { type: givenFields.type, env: given.env },
          requireExactMatch,
          visitedPairs,
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
              visitedPairs,
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
          given.type.selectedVariantName,
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
          visitedPairs,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // NOTE: Module type is now a NOMINAL type (compared by id).
  // Special cases: FnModuleType and FutureModuleType use structural comparison
  // because they are parameterized (e.g., Fn(x: i32) -> i32 vs Fn(y: string) -> string).
  if (isModuleType(expected.type)) {
    if (isModuleType(given.type)) {
      // Special case: FnModuleType uses structural comparison (function signature)
      if (isFnModuleType(expected.type)) {
        if (!isFnModuleType(given.type)) {
          return false; // Expected is callable but given is not
        }
        // Compare the function signatures
        if (
          !areFunctionTypesCompatible(
            { type: expected.type.isFn.callType, env: expected.env },
            { type: given.type.isFn.callType, env: given.env },
            requireExactMatch,
          )
        ) {
          return false;
        }
        // FnModuleType matched structurally
        return true;
      }

      // Special case: FutureModuleType uses structural comparison (output type)
      if (isFutureModuleType(expected.type)) {
        if (!isFutureModuleType(given.type)) {
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
            visitedPairs,
          )
        ) {
          return false;
        }
        // FutureModuleType matched structurally
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
      given.type.baseType.module &&
      isModuleType(expected.type)
    ) {
      // Compare the module from TypeHierarchyType with expected module
      return areTypesCompatible(
        { type: expected.type, env: expected.env },
        { type: given.type.baseType.module, env: given.env },
        requireExactMatch,
        visitedPairs,
      );
    }

    return false;
  }

  if (isFunctionType(expected.type) && isFunctionType(given.type)) {
    return areFunctionTypesCompatible(
      { type: expected.type, env: expected.env },
      { type: given.type, env: given.env },
      requireExactMatch,
      // TODO: pass visitedPairs?
    );
  }

  if (isTypeHierarchyType(expected.type) && isTypeHierarchyType(given.type)) {
    return canAssignTypeHierarchy(expected.type, given.type);
  }

  // *
  if (isPtrType(expected.type) && isPtrType(given.type)) {
    // NOTE: This causes some problem with type synthesize.
    //       So let's be specific here.
    // if (isVoidType(expected.type.type)) {
    //   return true; // *(void) is compatible with any pointer type
    // }

    // Mut pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      requireExactMatch,
      visitedPairs,
    );
  }

  // Iso
  if (isIsoType(expected.type) && isIsoType(given.type)) {
    // Iso types must have compatible inner types
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      requireExactMatch,
      visitedPairs,
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
    for (const expectedModule of expected.type.requiredModules) {
      const matchingGivenModule = given.type.requiredModules.find(
        (givenModule) =>
          areTypesCompatible(
            { type: expectedModule, env: expected.env },
            { type: givenModule, env: given.env },
            requireExactMatch,
            visitedPairs,
          ),
      );
      if (!matchingGivenModule) {
        return false; // Expected module not found in given
      }
    }

    // Check negative modules: given must NOT implement any of expected's negative modules
    if (
      expected.type.negativeModules &&
      expected.type.negativeModules.length > 0
    ) {
      for (const negativeModule of expected.type.negativeModules) {
        const matchingGivenModule = given.type.requiredModules.find(
          (givenModule) =>
            areTypesCompatible(
              { type: negativeModule, env: expected.env },
              { type: givenModule, env: given.env },
              requireExactMatch,
              visitedPairs,
            ),
        );
        if (matchingGivenModule) {
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
    // QUESTION: Is this correct?
    if (isDynType(given.type)) {
      return true; // DynType is compatible with SomeType
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
              visitedPairs,
            );
          } else {
            return false;
          }
        }
      }

      // When comparing two SomeTypes with different IDs:
      // - For cache comparisons (requireExactMatch=true): we need to check if they can unify
      // - Two type parameters can unify if they have compatible constraints (requiredModules)
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

      // Use the requiredModules field directly (not module.fields)
      const expectedModules = expected.type.requiredModules ?? [];
      const givenModules = given.type.requiredModules ?? [];

      // For exact matching (e.g., cache comparisons), require same number of modules
      if (requireExactMatch && expectedModules.length !== givenModules.length) {
        return false;
      }

      // Check that all expected modules are present in given modules
      for (const expectedModule of expectedModules) {
        const matchingGivenModule = givenModules.find((givenModule) => {
          // Compare by module type compatibility
          return areTypesCompatible(
            { type: expectedModule, env: expected.env },
            { type: givenModule, env: given.env },
            requireExactMatch,
            visitedPairs,
          );
        });
        if (!matchingGivenModule) {
          return false; // Expected module not found in given
        }
      }

      // Check negative modules: given must NOT implement any of expected's negative modules
      if (
        expected.type.negativeModules &&
        expected.type.negativeModules.length > 0
      ) {
        for (const negativeModule of expected.type.negativeModules) {
          const matchingGivenModule = givenModules.find((givenModule) =>
            areTypesCompatible(
              { type: negativeModule, env: expected.env },
              { type: givenModule, env: given.env },
              requireExactMatch,
              visitedPairs,
            ),
          );
          if (matchingGivenModule) {
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
            visitedPairs,
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
      // Check if given implements all required modules of expected
      const requiredModules = expected.type.requiredModules ?? [];
      if (requiredModules.length > 0) {
        // Check that given implements all required modules
        for (const requiredModule of requiredModules) {
          if (
            !typeImplementsModuleInternal({
              targetType: given.type,
              moduleType: requiredModule,
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
        if (
          expected.type.negativeModules &&
          expected.type.negativeModules.length > 0
        ) {
          for (const negativeModule of expected.type.negativeModules) {
            if (
              typeImplementsModuleInternal({
                targetType: given.type,
                moduleType: negativeModule,
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
        for (const requiredModule of requiredModules) {
          if (
            !typeImplementsModuleInternal({
              targetType: given.type,
              moduleType: requiredModule,
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
        expected.type,
      );
      if (expected.type === expectedType_) {
        return false;
      }
      return areTypesCompatible(
        { type: expectedType_, env: expected.env },
        given,
        requireExactMatch,
        visitedPairs,
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
        visitedPairs,
      )
    ) {
      return true;
    }

    const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);
    if (given.type === givenType_) {
      return false;
    }
    return areTypesCompatible(
      expected,
      { type: givenType_, env: given.env },
      requireExactMatch,
      visitedPairs,
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
): boolean {
  if (expected.type === given.type) {
    return true;
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
      },
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
      )
    ) {
      return false;
    }
  }

  const returnTypesMatch = areTypesCompatible(
    { type: expected.type.return.type, env: expected.env },
    { type: given.type.return.type, env: given.env },
    requireExactMatch,
  );
  return returnTypesMatch;
}
