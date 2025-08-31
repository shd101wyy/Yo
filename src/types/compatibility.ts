import { Environment } from "../env";
import {
  canAssignTypeHierarchy,
  synthesizeTypes,
} from "../evaluator/types/synthesizer";
import { areValuesEqual } from "../value";
import { ClosureType, FunctionType, ModuleElement, Type } from "./definitions";
import {
  isArrayType,
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
  isFunctionType,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isPrimitiveType,
  isPtrType,
  isRefType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  isU8Type,
  isUnionType,
} from "./guards";
import { TypeTag } from "./tags";
import { getValueOfSomeTypeFromEnv, typeContainsSomeType } from "./utils";

/**
 * Check if two types are compatible.
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
  isMethodReceiver = false
): boolean {
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
    if (isMethodReceiver && !isComptIntType(expected.type)) {
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
    if (isMethodReceiver && !isComptFloatType(expected.type)) {
      // If exact match is required, compt_float cannot be converted to other numeric types
      return false;
    }

    return true;
  }

  // compt_string can be converted to
  // - &([u8])  u8 slice
  // - *(u8)    u8 pointer with \0 terminator
  // - *(char)  char pointer with \0 terminator
  if (
    (isComptStringType(expected.type) ||
      (isRefType(expected.type) && // &([u8])
        isSliceType(expected.type.type) &&
        isU8Type(expected.type.type.elementType)) ||
      (isPtrType(expected.type) && // *(u8) or *(char)
        (isU8Type(expected.type.type) || isCharType(expected.type.type)))) &&
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

  if (isExprListType(expected.type) && isExprListType(given.type)) {
    return true;
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
          type: expected.type.elementType,
          env: expected.env,
        },
        { type: given.type.elementType, env: given.env }
      )
    );
  }

  if (isSliceType(expected.type) && isSliceType(given.type)) {
    // Slices must have compatible element types
    return areTypesCompatible(
      { type: expected.type.elementType, env: expected.env },
      { type: given.type.elementType, env: given.env }
    );
  }

  if (isTupleType(expected.type) && isTupleType(given.type)) {
    if (expected.type.elements.length !== given.type.elements.length) {
      return false;
    }
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedTypeElement = expected.type.elements[i]!;
      const givenTypeElement = given.type.elements[i]!;

      if (
        !areTypesCompatible(
          { type: expectedTypeElement.type, env: expected.env },
          { type: givenTypeElement.type, env: given.env }
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

    // Structs must have same elements and compatible types
    if (
      expected.type.elements.length !== given.type.elements.length ||
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

    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;

      if (
        expectedElement.label !== givenElement.label ||
        !areTypesCompatible(
          {
            type: expectedElement.type,
            env: expected.env,
          },
          { type: givenElement.type, env: given.env }
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

      if (expectedVariant.elements?.length !== givenVariant.elements?.length) {
        return false;
      }

      if (expectedVariant.elements) {
        for (let j = 0; j < expectedVariant.elements.length; j++) {
          const expectedElement = expectedVariant.elements![j]!;
          const givenElement = givenVariant.elements![j]!;

          if (
            expectedElement.label !== givenElement.label ||
            !areTypesCompatible(
              { type: expectedElement.type, env: expected.env },
              { type: givenElement.type, env: given.env }
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
    // Unions must have same elements and compatible types
    if (
      expected.type.elements.length !== given.type.elements.length ||
      (expected.type.id !== given.type.id &&
        !typeContainsSomeType(expected.type) &&
        !typeContainsSomeType(given.type))
    ) {
      return false;
    }

    if (expected.type.id === given.type.id) {
      return true;
    }

    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;

      if (
        expectedElement.label !== givenElement.label ||
        !areTypesCompatible(
          { type: expectedElement.type, env: expected.env },
          { type: givenElement.type, env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // NOTE: Module type is a structural type.
  if (isModuleType(expected.type)) {
    let givenElements: ModuleElement[] | undefined = undefined;
    if (isModuleType(given.type)) {
      givenElements = given.type.elements;
    } else if (
      isTypeHierarchyType(given.type) &&
      given.type.baseType &&
      (isStructType(given.type.baseType) ||
        isEnumType(given.type.baseType) ||
        isUnionType(given.type.baseType))
    ) {
      givenElements = given.type.baseType.module.elements;
    }

    if (givenElements) {
      // Modules must have same elements and compatible types
      for (let i = 0; i < expected.type.elements.length; i++) {
        const expectedElement = expected.type.elements[i]!;

        const givenElement = givenElements.find(
          (element) => element.label === expectedElement.label
        );
        if (!givenElement) {
          return false;
        }

        if (
          !areTypesCompatible(
            { type: expectedElement.type, env: expected.env },
            { type: givenElement.type, env: given.env },
            true // isMethodReceiver
          )
        ) {
          return false;
        }

        if (expectedElement.assignedValue && givenElement.assignedValue) {
          if (
            !areValuesEqual(
              {
                value: expectedElement.assignedValue,
                env: expected.env,
              },
              {
                value: givenElement.assignedValue,
                env: given.env,
              }
            )
          ) {
            return false;
          }
        }
      }
      return true;
    }
  }

  if (isClosureType(expected.type) && isClosureType(given.type)) {
    const expectedClosure = expected.type as ClosureType;
    const givenClosure = given.type as ClosureType;

    // Check if the function signatures are compatible
    if (
      !areFunctionTypesCompatible(
        { type: expectedClosure.callType, env: expected.env },
        { type: givenClosure.callType, env: given.env },
        isMethodReceiver
      )
    ) {
      return false;
    }

    // Check if the capture types are compatible
    // Handle the case where expected has SomeType (inference) and given has StructType (concrete)
    return areTypesCompatible(
      { type: expectedClosure.captureType, env: expected.env },
      { type: givenClosure.captureType, env: given.env },
      isMethodReceiver
    );
  }

  if (isFunctionType(expected.type) && isFunctionType(given.type)) {
    return areFunctionTypesCompatible(
      { type: expected.type, env: expected.env },
      { type: given.type, env: given.env },
      isMethodReceiver
    );
  }

  if (isTypeHierarchyType(expected.type) && isTypeHierarchyType(given.type)) {
    return canAssignTypeHierarchy(expected.type, given.type);
  }

  // *
  if (
    isPtrType(expected.type) &&
    (isPtrType(given.type) || isMutPtrType(given.type))
  ) {
    // Pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // *!
  if (isMutPtrType(expected.type) && isMutPtrType(given.type)) {
    // Mut pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // &
  // &
  if (
    isRefType(expected.type) &&
    (isRefType(given.type) || isMutRefType(given.type))
  ) {
    // References must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
    );
  }

  // &!
  if (isMutRefType(expected.type) && isMutRefType(given.type)) {
    // Mut references must have the same type
    return areTypesCompatible(
      { type: expected.type.type, env: expected.env },
      { type: given.type.type, env: given.env }
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
    const expectedModules = expected.type.moduleTypes.sort((m1, m2) =>
      m1.id.localeCompare(m2.id)
    );
    const givenModules = given.type.moduleTypes.sort((m1, m2) =>
      m1.id.localeCompare(m2.id)
    );
    if (expectedModules.length !== givenModules.length) {
      return false;
    }
    for (let i = 0; i < expectedModules.length; i++) {
      const expectedModule = expectedModules[i]!;
      const givenModule = givenModules[i]!;
      if (
        !areTypesCompatible(
          { type: expectedModule, env: expected.env },
          { type: givenModule, env: given.env }
        )
      ) {
        return false;
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
      if (expected.type === given.type) {
        return true;
      }

      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);
      if (isSomeType(expectedType_) && isSomeType(givenType_)) {
        // QUESTION: Should compare name instead?
        return expectedType_.id === givenType_.id;
      } else {
        // QUESTION: Is this correct?
        // return false;
        return areTypesCompatible(
          { type: expectedType_, env: expected.env },
          { type: givenType_, env: given.env }
        );
      }
    } else {
      const expectedType_ = getValueOfSomeTypeFromEnv(
        expected.env,
        expected.type
      );
      if (expected.type === expectedType_) {
        return false;
      }
      return areTypesCompatible(
        { type: expectedType_, env: expected.env },
        given
      );
    }
  } else if (isSomeType(given.type)) {
    const givenType_ = getValueOfSomeTypeFromEnv(given.env, given.type);
    if (given.type === givenType_) {
      return false;
    }
    return areTypesCompatible(expected, { type: givenType_, env: given.env });
  }

  return false;
}

/**
 * Check if two function types are compatible.
 * @param expectedType The expected function type.
 * @param givenType The given function type.
 * @param env
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
  isMethodReceiver = false
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

  // Check if the implicit parameters have the same count
  if (
    expected.type.implicitParameters.length !==
    given.type.implicitParameters.length
  ) {
    return false;
  }

  // Synthesize the types
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
        isMethodReceiver
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

    // Special handling for function parameter reference compatibility
    // For function parameters, compatibility is contravariant:
    // - A function that takes &(T) can be used where a function that takes &!(T) is expected
    // - A function that takes &!(T) cannot be used where a function that takes &(T) is expected

    // Explicitly prevent &!(T) from being used where &(T) is expected
    if (isRefType(expectedParam.type) && isMutRefType(givenParam.type)) {
      // A function that takes &!(T) cannot be used where a function that takes &(T) is expected
      return false;
    }

    if (
      isMutRefType(expectedParam.type) &&
      isRefType(givenParam.type) &&
      areTypesCompatible(
        { type: expectedParam.type.type, env: expected.env },
        { type: givenParam.type.type, env: given.env },
        isMethodReceiver
      )
    ) {
      // A function that takes &(T) can be used where a function that takes &!(T) is expected
      continue;
    }

    // Special handling for function parameter pointer compatibility
    // For function parameters, compatibility is contravariant:
    // - A function that takes *(T) can be used where a function that takes *!(T) is expected
    // - A function that takes *!(T) cannot be used where a function that takes *(T) is expected

    // Explicitly prevent *!(T) from being used where *(T) is expected
    if (isPtrType(expectedParam.type) && isMutPtrType(givenParam.type)) {
      // A function that takes *!(T) cannot be used where a function that takes *(T) is expected
      return false;
    }

    if (
      isMutPtrType(expectedParam.type) &&
      isPtrType(givenParam.type) &&
      areTypesCompatible(
        { type: expectedParam.type.type, env: expected.env },
        { type: givenParam.type.type, env: given.env },
        isMethodReceiver
      )
    ) {
      // A function that takes *(T) can be used where a function that takes *!(T) is expected
      continue;
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
        isMethodReceiver
      )
    ) {
      return false;
    }
  }

  // Check implicit parameters for compatibility
  for (let i = 0; i < expected.type.implicitParameters.length; i++) {
    const expectedImplicitParam = expected.type.implicitParameters[i]!;
    const givenImplicitParam = given.type.implicitParameters[i]!;

    if (
      expectedImplicitParam.isCompileTimeOnly !==
      givenImplicitParam.isCompileTimeOnly
    ) {
      return false;
    }

    // Special handling for implicit parameter reference compatibility
    // For function parameters, compatibility is contravariant:
    // - A function that takes &(T) can be used where a function that takes &!(T) is expected
    // - A function that takes &!(T) cannot be used where a function that takes &(T) is expected

    // Explicitly prevent &!(T) from being used where &(T) is expected
    if (
      isRefType(expectedImplicitParam.type) &&
      isMutRefType(givenImplicitParam.type)
    ) {
      // A function that takes &!(T) cannot be used where a function that takes &(T) is expected
      return false;
    }

    if (
      isMutRefType(expectedImplicitParam.type) &&
      isRefType(givenImplicitParam.type) &&
      areTypesCompatible(
        { type: expectedImplicitParam.type.type, env: expected.env },
        { type: givenImplicitParam.type.type, env: given.env },
        isMethodReceiver
      )
    ) {
      // A function that takes &(T) can be used where a function that takes &!(T) is expected
      continue;
    }

    // Special handling for implicit parameter pointer compatibility
    // For function parameters, compatibility is contravariant:
    // - A function that takes *(T) can be used where a function that takes *!(T) is expected
    // - A function that takes *!(T) cannot be used where a function that takes *(T) is expected

    // Explicitly prevent *!(T) from being used where *(T) is expected
    if (
      isPtrType(expectedImplicitParam.type) &&
      isMutPtrType(givenImplicitParam.type)
    ) {
      // A function that takes *!(T) cannot be used where a function that takes *(T) is expected
      return false;
    }

    if (
      isMutPtrType(expectedImplicitParam.type) &&
      isPtrType(givenImplicitParam.type) &&
      areTypesCompatible(
        { type: expectedImplicitParam.type.type, env: expected.env },
        { type: givenImplicitParam.type.type, env: given.env },
        isMethodReceiver
      )
    ) {
      // A function that takes *(T) can be used where a function that takes *!(T) is expected
      continue;
    }

    if (
      !areTypesCompatible(
        { type: expectedImplicitParam.type, env: expected.env },
        { type: givenImplicitParam.type, env: given.env },
        isMethodReceiver
      )
    ) {
      return false;
    }
  }

  const returnTypesMatch = areTypesCompatible(
    { type: expected.type.return.type, env: expected.env },
    { type: given.type.return.type, env: given.env },
    isMethodReceiver
  );
  return returnTypesMatch;
}
