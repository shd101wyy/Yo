import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { PlaceholderToken } from "../../token";
import {
  getValueOfSomeTypeFromEnv,
  isArrayType,
  isComptListType,
  isEnumType,
  isFnModuleType,
  isFunctionType,
  isFutureType,
  isModuleType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  Type,
  typeToString,
} from "../../types";
import { TypeTag } from "../../types/tags";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";

/**
 * Check if a given type hierarchy type can be assigned to an expected type hierarchy type.
 * Based on the logic from compatibility.ts
 */
export function canAssignTypeHierarchy(expected: Type, given: Type): boolean {
  if (!isTypeHierarchyType(expected) || !isTypeHierarchyType(given)) {
    return false;
  }

  // Check if the given type is a subtype of the expected type
  return (
    given.level === expected.level &&
    (given.tag === expected.tag || expected.tag === TypeTag.Type)
  );
}

/**
 * Occurs check: Check if a SomeType occurs within another type.
 * This prevents infinite types like T = Option(T).
 * Returns true if someType occurs in the type structure.
 */
function occursCheck(someTypeId: string, type: Type): boolean {
  if (isSomeType(type)) {
    return someTypeId === type.id;
  }

  if (isStructType(type)) {
    return type.fields.some((el) => occursCheck(someTypeId, el.type));
  }

  if (isEnumType(type)) {
    return type.variants.some((v) =>
      v.fields ? v.fields.some((el) => occursCheck(someTypeId, el.type)) : false
    );
  }

  if (isTupleType(type)) {
    return type.fields.some((el) => occursCheck(someTypeId, el.type));
  }

  if (isArrayType(type) || isSliceType(type) || isComptListType(type)) {
    return occursCheck(someTypeId, type.childType);
  }

  if (isPtrType(type)) {
    // Don't check inside pointer types for occurs check
    // This prevents false positives like trying to bind X to *(X)
    // This is a valid indirection.
    return false;
  }

  if (isFunctionType(type)) {
    return (
      type.parameters.some((p) => occursCheck(someTypeId, p.type)) ||
      occursCheck(someTypeId, type.return.type)
    );
  }

  if (isFutureType(type)) {
    return occursCheck(someTypeId, type.childType);
  }

  if (isFnModuleType(type)) {
    return occursCheck(someTypeId, type.isFn.callType);
  }

  return false;
}

/**
 * Synthesize the types, such as
 * compt(T): Type, i32  => T = i32
 */
export function synthesizeTypes(
  expected: {
    type: Type;
    env: Environment;
  },
  given: {
    type: Type;
    env: Environment;
  },
  checkedTypePairs: { expected: Type; given: Type }[] = []
): { expectedEnv: Environment; givenEnv: Environment } {
  // Prevent circular checks for `object` and similar recursive types
  if (
    checkedTypePairs.find(
      (pair) => pair.expected === expected.type && pair.given === given.type
    )
  ) {
    // Already checked this pair, avoid infinite recursion
    return { expectedEnv: expected.env, givenEnv: given.env };
  } else {
    checkedTypePairs.push({ expected: expected.type, given: given.type });
  }

  if (isSomeType(expected.type) && isSomeType(given.type)) {
    // Handle case where both are SomeTypes - unify them
    // Check if either SomeType is already bound
    const expectedBoundType = getValueOfSomeTypeFromEnv(
      expected.env,
      expected.type
    );
    const givenBoundType = getValueOfSomeTypeFromEnv(given.env, given.type);

    if (!isSomeType(expectedBoundType)) {
      // Expected is bound, use it to bind given
      const value = createTypeValue(expectedBoundType);
      const existingVariables = getVariablesFromEnv(given.env, given.type.name);
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: given.env,
          variable: {
            name: given.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            token: PlaceholderToken,
            initializedAtToken: PlaceholderToken,
            consumedAtToken: undefined,
          },
        });
        given.env = nextEnv;
      } else {
        given.env = updateExistingVariable(given.env, variable, {
          ...variable,
          value,
        });
      }
    } else if (!isSomeType(givenBoundType)) {
      // Given is bound, use it to bind expected
      const value = createTypeValue(givenBoundType);
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expected.type.name
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expected.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            token: PlaceholderToken,
            initializedAtToken: PlaceholderToken,
            consumedAtToken: undefined,
          },
        });
        expected.env = nextEnv;
      } else {
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value,
        });
      }
    } else if (expectedBoundType === givenBoundType) {
      // Do nothing since both are the same
    }
    // both are some type
    else {
      // Bind both to the same new concrete type
      const value = createTypeValue(
        given.type // NOTE: Using expected.type here causes some errors in tests
        // createSomeType(createType0(), `type_synth_${randomId()}`) // <= This also causes some errors in tests
      );

      // Update expected env
      {
        const existingVariables = getVariablesFromEnv(
          expected.env,
          expected.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: expected.env,
            variable: {
              name: expected.type.name,
              value: value,
              type: value.type,
              isCompileTimeOnly: true,
              token: PlaceholderToken,
              initializedAtToken: PlaceholderToken,
              consumedAtToken: undefined,
            },
          });
          expected.env = nextEnv;
        } else {
          expected.env = updateExistingVariable(expected.env, variable, {
            ...variable,
            value,
          });
        }
      }

      // Update given env
      {
        const existingVariables = getVariablesFromEnv(
          given.env,
          given.type.name
        );
        const variable = existingVariables[existingVariables.length - 1];
        if (!variable) {
          const { env: nextEnv } = addVariableToEnv({
            env: given.env,
            variable: {
              name: given.type.name,
              value: value,
              type: value.type,
              isCompileTimeOnly: true,
              token: PlaceholderToken,
              initializedAtToken: PlaceholderToken,
              consumedAtToken: undefined,
            },
          });
          given.env = nextEnv;
        } else {
          given.env = updateExistingVariable(given.env, variable, {
            ...variable,
            value,
          });
        }
      }
    }
  } else if (isSomeType(expected.type)) {
    // Check if the env has
    const type = getValueOfSomeTypeFromEnv(expected.env, expected.type);
    if (
      //type === expected.type
      isSomeType(type) &&
      type.id === expected.type.id
    ) {
      // Occurs check: prevent infinite types like T = Option(T)
      if (occursCheck(expected.type.id, given.type)) {
        throw new Error(
          `Cannot unify type variable "${expected.type.name}" with type "${typeToString(given.type)}" because it would create an infinite type.`
        );
      }

      const value = createTypeValue(given.type);
      // console.log("(1) addVariableToEnv");

      // Check if the same variable already exists in the env
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expected.type.name
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expected.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            token: PlaceholderToken, // FIXME: What should be `token` here?
            initializedAtToken: PlaceholderToken, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
        });
        expected.env = nextEnv;
      } else if (variable) {
        // Update existing
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value,
        });
      }
    } else if (!isSomeType(type)) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: type, env: expected.env },
        { type: given.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }
  } else if (isSomeType(given.type)) {
    // Handle case where given is SomeType but expected is not
    // This can happen in closure synthesis where we need to unify SomeTypes

    // Check if the given SomeType is already bound in its environment
    const existingType = getValueOfSomeTypeFromEnv(given.env, given.type);
    if (!isSomeType(existingType)) {
      // The given SomeType is already bound to a concrete type
      // Recursively synthesize with the bound type
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type, env: expected.env },
        { type: existingType, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    } else {
      // Occurs check: prevent infinite types like T = Option(T)
      if (occursCheck(given.type.id, expected.type)) {
        throw new Error(
          `Cannot unify type variable "${given.type.name}" with type "${typeToString(expected.type)}" because it would create an infinite type.`
        );
      }

      // Bind the given SomeType to the expected type
      const value = createTypeValue(expected.type);

      const existingVariables = getVariablesFromEnv(given.env, given.type.name);
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        const { env: nextEnv } = addVariableToEnv({
          env: given.env,
          variable: {
            name: given.type.name,
            value: value,
            type: value.type,
            isCompileTimeOnly: true,
            token: PlaceholderToken,
            initializedAtToken: PlaceholderToken,
            consumedAtToken: undefined,
          },
        });
        given.env = nextEnv;
      } else if (variable) {
        // Update existing
        given.env = updateExistingVariable(given.env, variable, {
          ...variable,
          value,
        });
      }
    }
  } else if (
    isTupleType(expected.type) &&
    isTupleType(given.type) &&
    expected.type.fields.length === given.type.fields.length
  ) {
    for (let i = 0; i < expected.type.fields.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type.fields[i]!.type, env: expected.env },
        { type: given.type.fields[i]!.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }
  } else if (
    isStructType(expected.type) &&
    isStructType(given.type) &&
    (expected.type.id === given.type.id ||
      (expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue === given.type.functionValue))
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
    // We removed the typeName condition since it fails for Data(boolean) vs Data(A1)
  ) {
    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedElement = expected.type.fields[i]!;
      const givenElement = given.type.fields[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          {
            type: expectedElement.assignedValue.value,
            env: expected.env,
          },
          {
            type: givenElement.assignedValue.value,
            env: given.env,
          },
          checkedTypePairs
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (
    isEnumType(expected.type) &&
    isEnumType(given.type) &&
    (expected.type.id === given.type.id ||
      (expected.type.functionValue &&
        given.type.functionValue &&
        expected.type.functionValue === given.type.functionValue))
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.variants.length; i++) {
      const expectedTypeVariant = expected.type.variants[i]!;
      const givenTypeVariant = given.type.variants[i]!;

      const expectedTypeVariantElements = expectedTypeVariant.fields ?? [];
      const givenTypeVariantElements = givenTypeVariant.fields ?? [];

      for (let j = 0; j < expectedTypeVariantElements.length; j++) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          { type: expectedTypeVariantElements[j]!.type, env: expected.env },
          { type: givenTypeVariantElements[j]!.type, env: given.env },
          checkedTypePairs
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (
    isModuleType(expected.type) &&
    isModuleType(given.type) &&
    expected.type.functionValue &&
    given.type.functionValue &&
    expected.type.functionValue === given.type.functionValue
    // NOTE: The typeId might not match
    // They might be different structs that both are returned from the same function.
  ) {
    for (let i = 0; i < expected.type.fields.length; i++) {
      const expectedElement = expected.type.fields[i]!;
      const givenElement = given.type.fields[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;

      if (
        expectedElement.assignedValue &&
        givenElement.assignedValue &&
        isTypeValue(expectedElement.assignedValue) &&
        isTypeValue(givenElement.assignedValue)
      ) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          {
            type: expectedElement.assignedValue.value,
            env: expected.env,
          },
          {
            type: givenElement.assignedValue.value,
            env: given.env,
          },
          checkedTypePairs
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (isPtrType(expected.type) && isPtrType(given.type)) {
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Synthesize the element types of the arrays
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;

    // Synthesize the array lengths
    // TODO: Extract this to a separate function?
    if (
      isUnknownValue(expected.type.length) &&
      expected.type.length.variableName &&
      !isUnknownValue(given.type.length)
    ) {
      const expectedLengthVariableName = expected.type.length.variableName;
      const givenLength = given.type.length;
      // Check if the variable already exists in the env
      const existingVariables = getVariablesFromEnv(
        expected.env,
        expectedLengthVariableName
      );
      const variable = existingVariables[existingVariables.length - 1];
      if (!variable) {
        // QUESTION: Will it enter this case?
        const { env: nextEnv } = addVariableToEnv({
          env: expected.env,
          variable: {
            name: expectedLengthVariableName,
            value: givenLength,
            type: given.type.length.type,
            isCompileTimeOnly: true,
            token: PlaceholderToken, // FIXME: What should be `token` here?
            initializedAtToken: PlaceholderToken, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
        });
        expected.env = nextEnv;
      } else if (variable) {
        // Update existing
        expected.env = updateExistingVariable(expected.env, variable, {
          ...variable,
          value: givenLength,
        });
      }
    }
  } else if (isSliceType(expected.type) && isSliceType(given.type)) {
    // Synthesize the element types of the slices
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isComptListType(expected.type) && isComptListType(given.type)) {
    // Synthesize the element types of the ComptLists
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isFutureType(expected.type) && isFutureType(given.type)) {
    // Synthesize the element types of the Futures
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.childType,
        env: expected.env,
      },
      {
        type: given.type.childType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isFnModuleType(expected.type) && isFnModuleType(given.type)) {
    // Synthesize FnModuleType types - match the function types (isFn)
    const expectedFnModule = expected.type;
    const givenFnModule = given.type;

    // Synthesize the function types (isFn)
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedFnModule.isFn.callType,
        env: expected.env,
      },
      {
        type: givenFnModule.isFn.callType,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (
    isFunctionType(expected.type) &&
    isFunctionType(given.type) &&
    expected.type.forallParameters.length ===
      given.type.forallParameters.length &&
    expected.type.parameters.length === given.type.parameters.length
  ) {
    // Synthesize function types - match parameter types and return types
    const expectedFunction = expected.type;
    const givenFunction = given.type;

    // Synthesize the forall parameter types
    for (let i = 0; i < expectedFunction.forallParameters.length; i++) {
      const expectedForallParam = expectedFunction.forallParameters[i]!;
      const givenForallParam = givenFunction.forallParameters[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedForallParam.type,
          env: expected.env,
        },
        {
          type: givenForallParam.type,
          env: given.env,
        },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the parameter types
    for (let i = 0; i < expectedFunction.parameters.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        {
          type: expectedFunction.parameters[i]!.type,
          env: expected.env,
        },
        {
          type: givenFunction.parameters[i]!.type,
          env: given.env,
        },
        checkedTypePairs
      );
      expected.env = expectedEnv;
      given.env = givenEnv;
    }

    // Synthesize the return types
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedFunction.return.type,
        env: expected.env,
      },
      {
        type: givenFunction.return.type,
        env: given.env,
      },
      checkedTypePairs
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (
    isTypeHierarchyType(expected.type) &&
    !isTypeHierarchyType(given.type)
  ) {
    // When expected is Type (type hierarchy) and given is a concrete type (struct, enum, etc.),
    // this is valid - a concrete type can be assigned to Type.
    // No synthesis needed, just accept the assignment.
  } else {
    // If we reach here, the types are fundamentally incompatible
    // (different type constructors with no SomeType to unify)
    // Check if they have the same tag as a basic compatibility check
    if (expected.type.tag !== given.type.tag) {
      throw new Error(
        `Cannot unify incompatible types: "${typeToString(expected.type)}" and "${typeToString(given.type)}"`
      );
    }
  }
  return { expectedEnv: expected.env, givenEnv: given.env };
}
