import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import {
  getValueOfSomeTypeFromEnv,
  isArrayType,
  isClosureType,
  isEnumType,
  isModuleType,
  isMutPtrType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  Type,
  typeOfType,
  typeToString,
} from "../../types";
import { createTypeValue, isTypeValue, isUnknownValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";

/**
 * Synthesize the expression and type, such as:
 * - (p: Point) := _(3, 4);   // here _ becomes Point
 * - (p: Color) := .Red;      // here (.) becomes (Color.)
 * - (p: Shape) := .Circle(3) // here (.) becomes (Shape.)
 * - (c: Complex) := (_(3, true),) // here (_) becomes struct in tuple
 */
export function synthesizeExprAndType({
  expr,
  type,
  env,
  context,
}: {
  expr: Expr;
  type: Type;
  env: Environment;
  context: EvaluatorContext;
}): { expr: Expr; type: Type; env: Environment } {
  // Handle tuples (including tuples with placeholders)
  if (
    isTupleType(type) &&
    exprIsFunctionCall(expr) &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)
  ) {
    if (type.elements.length !== expr.args.length) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Tuple size mismatch: expected ${type.elements.length} elements, got ${expr.args.length}`,
      });
    }

    // Recursively synthesize each tuple element
    for (let i = 0; i < type.elements.length; i++) {
      const elementType = type.elements[i]!.type;
      const elementExpr = expr.args[i]!;

      const {
        // expr: synthesizedExpr,
        // type: synthesizedType,
        env: nextEnv,
      } = synthesizeExprAndType({
        expr: elementExpr,
        type: elementType,
        env,
        context: { ...context },
      });

      env = nextEnv;
    }

    // The entire tuple is now synthesized
    expr.$ = {
      env,
      type,
      isMutable: false,
    };
    return { expr, type, env };
  }
  // Handle the _ case
  else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "_")) {
    // Check if type is a struct type
    if (isStructType(type) || isUnionType(type) || isModuleType(type)) {
      const funcCallExpr = evaluateFunctionCall({
        expr,
        env,
        givenFunc: {
          type: typeOfType(type),
          value: createTypeValue(type),
        },
        context: { ...context },
      });

      if (!funcCallExpr.$?.type || !funcCallExpr.$?.env) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to evaluate expr and type for struct:\n${exprToString(
            expr
          )}`,
        });
      }

      // Attach information to the "_"
      // expr.func.value = createTypeValue(type);
      // expr.func.type = typeOfType(type);

      return {
        expr: funcCallExpr,
        type: funcCallExpr.$?.type,
        env: funcCallExpr.$?.env,
      };
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot use _ with type ${typeToString(
          type
        )}. Only supported with struct types.`,
      });
    }
  }
  // Handle the . case for enum variant
  else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ".", 1)) {
    // Check if type is an enum type
    if (isEnumType(type)) {
      const variantNameExpr = expr.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(
            variantNameExpr
          )}`,
        });
      }
      const variantName = variantNameExpr.token.value;
      const variant = type.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(type)}`,
        });
      }

      const newEnumType = { ...type, selectedVariantName: variantName };
      expr.$ = {
        type: newEnumType,
        env,
        isMutable: false,
      };
      // TODO: comptime value

      return {
        expr: expr,
        type: newEnumType,
        env: env,
      };
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot use . with type ${typeToString(
          type
        )}. Only supported with enum types.`,
      });
    }
  }
  // Handle the . case for enum variant call
  else if (
    exprIsFunctionCall(expr) &&
    exprIsFunctionCall(expr.func) &&
    exprIsFunctionCallOf(expr.func, ".", 1)
  ) {
    if (isEnumType(type)) {
      const variantExpr = expr.func;
      const variantNameExpr = variantExpr.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: variantExpr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(
            variantNameExpr
          )}`,
        });
      }

      const variantName = variantNameExpr.token.value;
      const variant = type.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(type)}`,
        });
      }

      const newEnumType = { ...type, selectedVariantName: variantName };
      const funcCallExpr = evaluateFunctionCall({
        expr,
        env,
        givenFunc: {
          type: typeOfType(newEnumType),
          value: createTypeValue(newEnumType),
        },
        context: { ...context },
      });
      if (!funcCallExpr.$?.type || !funcCallExpr.$?.env) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Failed to evaluate expr and type for enum variant:\n${exprToString(
            expr
          )}`,
        });
      }

      return {
        expr: funcCallExpr,
        type: funcCallExpr.$?.type,
        env: funcCallExpr.$?.env,
      };
    } else {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Cannot use . with type ${typeToString(
          type
        )}. Only supported with enum types.`,
      });
    }
  }
  // If both expr and type are already set, but there might be unknown values to resolve
  else if (expr.$?.type && type) {
    try {
      // Try to synthesize the types to resolve unknown values
      const { expectedEnv } = synthesizeTypes(
        { type: type, env },
        { type: expr.$.type, env }
      );

      return {
        expr,
        type: type, // Return the expected type (which may have been updated)
        env: expectedEnv,
      };
    } catch (synthesisError) {
      // If synthesis fails, fall back to original behavior
      return {
        expr,
        type: expr.$?.type, // NOTE: Here we should return the type of expr, not `type`
        env,
      };
    }
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Failed to synthesize the type and expr: ${exprToString(expr)}`,
    });
  }
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
  }
): { expectedEnv: Environment; givenEnv: Environment } {
  if (isSomeType(expected.type)) {
    // Check if the env has
    const type = getValueOfSomeTypeFromEnv(expected.env, expected.type);
    if (
      //type === expected.type
      isSomeType(type) &&
      type.name === expected.type.name
    ) {
      // Update the env to set givenType to expectedType.name
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
            isMutable: false,
            isCompileTimeOnly: true,
            isImplicit: false,
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
    }
  } else if (
    isTupleType(expected.type) &&
    isTupleType(given.type) &&
    expected.type.elements.length === given.type.elements.length
  ) {
    for (let i = 0; i < expected.type.elements.length; i++) {
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expected.type.elements[i]!.type, env: expected.env },
        { type: given.type.elements[i]!.type, env: given.env }
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
  ) {
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env }
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
          }
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

      const expectedTypeVariantElements = expectedTypeVariant.elements ?? [];
      const givenTypeVariantElements = givenTypeVariant.elements ?? [];

      for (let j = 0; j < expectedTypeVariantElements.length; j++) {
        const { expectedEnv, givenEnv } = synthesizeTypes(
          { type: expectedTypeVariantElements[j]!.type, env: expected.env },
          { type: givenTypeVariantElements[j]!.type, env: given.env }
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
    for (let i = 0; i < expected.type.elements.length; i++) {
      const expectedElement = expected.type.elements[i]!;
      const givenElement = given.type.elements[i]!;
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: expectedElement.type, env: expected.env },
        { type: givenElement.type, env: given.env }
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
          }
        );
        expected.env = expectedEnv;
        given.env = givenEnv;
      }
    }
  } else if (
    (isPtrType(expected.type) && isPtrType(given.type)) ||
    (isMutPtrType(expected.type) && isMutPtrType(given.type))
  ) {
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.type,
        env: expected.env,
      },
      {
        type: given.type.type,
        env: given.env,
      }
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isArrayType(expected.type) && isArrayType(given.type)) {
    // Synthesize the element types of the arrays
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expected.type.elementType,
        env: expected.env,
      },
      {
        type: given.type.elementType,
        env: given.env,
      }
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
            isMutable: false,
            isCompileTimeOnly: true,
            isImplicit: false,
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
        type: expected.type.elementType,
        env: expected.env,
      },
      {
        type: given.type.elementType,
        env: given.env,
      }
    );
    expected.env = expectedEnv;
    given.env = givenEnv;
  } else if (isClosureType(expected.type) && isClosureType(given.type)) {
    // Synthesize closure types - match capture types and function types
    const expectedClosure = expected.type;
    const givenClosure = given.type;

    // Synthesize the function types (callType)
    const { expectedEnv, givenEnv } = synthesizeTypes(
      {
        type: expectedClosure.callType,
        env: expected.env,
      },
      {
        type: givenClosure.callType,
        env: given.env,
      }
    );
    expected.env = expectedEnv;
    given.env = givenEnv;

    // Synthesize the capture types if both exist
    if (expectedClosure.captureType && givenClosure.captureType) {
      const { expectedEnv: captureExpectedEnv, givenEnv: captureGivenEnv } =
        synthesizeTypes(
          {
            type: expectedClosure.captureType,
            env: expected.env,
          },
          {
            type: givenClosure.captureType,
            env: given.env,
          }
        );
      expected.env = captureExpectedEnv;
      given.env = captureGivenEnv;
    }
  }
  return { expectedEnv: expected.env, givenEnv: given.env };
}
