import { Environment } from "../env";
import {
  canAssignTypeHierarchy,
  synthesizeTypes,
} from "../evaluator/types/synthesizer";
import { areValuesEqual } from "../value";
import { FunctionType, ModuleField, Type } from "./definitions";
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
  isFunctionType,
  isFutureType,
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
      { type: given.type.childType, env: given.env }
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
        { type: given.type.childType, env: given.env }
      )
    );
  }

  if (isSliceType(expected.type) && isSliceType(given.type)) {
    // Slices must have compatible element types
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env }
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
          { type: givenFields.type, env: given.env }
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
              { type: givenFields.type, env: given.env }
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
          { type: givenFields.type, env: given.env }
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // NOTE: Module type is a structural type.
  if (isModuleType(expected.type)) {
    let givenElements: ModuleField[] | undefined = undefined;
    let givenReceiverType: Type | undefined = undefined;

    if (isModuleType(given.type)) {
      givenElements = given.type.fields;
      givenReceiverType = given.type.receiverType;
    } else if (
      isTypeHierarchyType(given.type) &&
      given.type.baseType &&
      given.type.baseType.module
    ) {
      givenElements = given.type.baseType.module.fields;
      givenReceiverType = given.type.baseType.module.receiverType;
    }

    if (givenElements) {
      // Check receiverType constraint if present (e.g., for (i32 <: Eq(i32)))
      if (expected.type.receiverType && givenReceiverType) {
        // Both have receiverType, they must be compatible
        if (
          !areTypesCompatible(
            { type: expected.type.receiverType, env: expected.env },
            { type: givenReceiverType, env: given.env }
          )
        ) {
          return false;
        }
      } else if (expected.type.receiverType && !givenReceiverType) {
        // Expected has receiverType constraint but given doesn't
        // This means we're checking if a type implements a subtype constraint
        // The given type should satisfy the receiverType constraint
        // For now, we'll only check the module fields, not the receiverType
        // The receiverType constraint should be checked elsewhere when implementing
      } else if (!expected.type.receiverType && givenReceiverType) {
        // Expected doesn't have receiverType but given does
        // This is OK - the given type is more specific
      }

      // Modules must have same fields and compatible types
      for (let i = 0; i < expected.type.fields.length; i++) {
        const expectedFields = expected.type.fields[i]!;

        const givenFields = givenElements.find(
          (field) => field.label === expectedFields.label
        );
        if (!givenFields) {
          return false;
        }

        if (
          !areTypesCompatible(
            { type: expectedFields.type, env: expected.env },
            { type: givenFields.type, env: given.env },
            true // isMethodReceiver
          )
        ) {
          return false;
        }

        if (expectedFields.assignedValue && givenFields.assignedValue) {
          if (
            !areValuesEqual(
              {
                value: expectedFields.assignedValue,
                env: expected.env,
              },
              {
                value: givenFields.assignedValue,
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
  if (isPtrType(expected.type) && isPtrType(given.type)) {
    // NOTE: This causes some problem with type synthesize.
    //       So let's be specific here.
    // if (isVoidType(expected.type.type)) {
    //   return true; // *(void) is compatible with any pointer type
    // }

    // Mut pointers must have the same type
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env }
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
    const expectedModules = expected.type.moduleTypes
      .slice(1)
      .toSorted((m1, m2) => m1.id.localeCompare(m2.id));
    const givenModules = given.type.moduleTypes
      .slice(1)
      .toSorted((m1, m2) => m1.id.localeCompare(m2.id));
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

  if (isFutureType(expected.type) && isFutureType(given.type)) {
    // Future types are compatible if their element types are compatible
    return areTypesCompatible(
      { type: expected.type.childType, env: expected.env },
      { type: given.type.childType, env: given.env },
      isMethodReceiver
    );
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

  const returnTypesMatch = areTypesCompatible(
    { type: expected.type.return.type, env: expected.env },
    { type: given.type.return.type, env: given.env },
    isMethodReceiver
  );
  return returnTypesMatch;
}
