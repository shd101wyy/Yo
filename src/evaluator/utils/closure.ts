import {
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import { BuiltinFunctions, Expr, ExprTag } from "../../expr";
import { FunctionCapturedVariableInfo } from "../../function-value";
import { generateExprFromCode } from "../../parser";
import { Token } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import { createStructType } from "../../types/creators";
import { StructType, TypeField } from "../../types/definitions";
import { typeContainsRcType, typeToString } from "../../types/utils";
import {
  createStructValue,
  StructValue,
  UnknownValue,
  Value,
} from "../../value";
import { CapturedVariableInfo, EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { autoDeriveTraitsAndAddRcFunctionsForStructType } from "../types/utils";

/**
 * Consume captured variables for closures.
 *
 * This function implements the move semantics for closures in the Yo language.
 * When a closure is created, it captures variables from outer scopes by move,
 * similar to Rust's FnOnce closures. This means the captured variables are
 * consumed and cannot be used again after the closure is created.
 *
 * @param capturedVariables - Map of variable names to their usage information
 * @param env - The environment where the closure is being created
 * @param closureToken - The token representing the closure creation point
 * @returns Updated environment with captured variables marked as consumed
 */
export function consumeCapturedVariables({
  capturedVariables,
  env,
  closureToken,
}: {
  capturedVariables: Map<string, CapturedVariableInfo>;
  env: Environment;
  closureToken: Token;
}): Environment {
  let updatedEnv = env;

  for (const [variableName, usageInfo] of capturedVariables.entries()) {
    // Only consume variables from outer scopes (lower frame levels)
    // and only if the usage type is "own" (FnMove semantics)
    if (
      usageInfo.frameLevel < env.frames.length &&
      usageInfo.usageType === "own"
    ) {
      const variables = getVariablesFromEnv(updatedEnv, variableName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (!variable.consumedAtToken) {
          // Mark the variable as consumed at the closure creation point
          updatedEnv = updateExistingVariable(updatedEnv, variable, {
            ...variable,
            consumedAtToken: closureToken,
          });
        }
      }
    }
  }

  return updatedEnv;
}

/**
 * Build path collection from captured variables for closures.
 *
 * This creates a path collection that includes all the captured variables'
 * paths, which is needed for proper borrowing semantics when the closure
 * is used with borrow expressions.
 *
 * @param capturedVariables - Map of variable names to their usage information
 * @returns PathCollection containing paths to all captured variables
 */
export function buildPathCollectionFromCapturedVariables(
  capturedVariables: Map<string, CapturedVariableInfo>
): string[][] {
  const pathCollection: string[][] = [];

  for (const [variableName] of capturedVariables.entries()) {
    // Add the path for each captured variable
    pathCollection.push([variableName]);
  }

  return pathCollection;
}

/**
 * Create capture type and value for closures from captured variables.
 * This consolidates the logic for handling both inferred and explicit capture types.
 */
export function createCaptureTypeAndValue({
  expectedCaptureType,
  capturedVariablesWithValues,
  env,
  closureToken,
  context,
}: {
  expectedCaptureType: StructType | undefined;
  capturedVariablesWithValues:
    | Map<string, FunctionCapturedVariableInfo>
    | undefined;
  env: Environment;
  closureToken: Token;
  context: EvaluatorContext;
}): {
  captureType: StructType | undefined;
  captureValue: StructValue | UnknownValue | undefined;
} {
  let captureType = expectedCaptureType;
  let captureValue: StructValue | UnknownValue | undefined;

  // Handle capture type inference vs explicit struct type
  if (captureType === undefined) {
    // Inference case: create new anonymous struct from captured variables
    if (capturedVariablesWithValues && capturedVariablesWithValues.size > 0) {
      // Create a struct type using createStructType
      const inferredCaptureType = createStructType(env);

      // Create fields from captured variables
      const captureFields: TypeField[] = Array.from(
        capturedVariablesWithValues.entries()
      ).map(([varName, captureInfo]) => {
        return {
          label: varName,
          type: captureInfo.type,
          isCompileTimeOnly: false, // Captured variables are runtime values
          assignedValue: undefined,
          exprs: {
            expr: {
              tag: ExprTag.Atom,
              token: captureInfo.token,
            }, // Create a proper atom expression from the token
            labelExpr: undefined,
            typeExpr: undefined,
            defaultValueExpr: undefined,
          },
        };
      });

      // Add the fields to the struct type
      inferredCaptureType.fields = captureFields;
      captureType = inferredCaptureType;

      // Auto-derive all applicable traits (Send, Acyclic, Comptime, Runtime)
      env = autoDeriveTraitsAndAddRcFunctionsForStructType({
        structType: inferredCaptureType,
        env,
        context: { ...context },
      });

      // Create a struct value if all captured values are compile-time known
      const captureValues = Array.from(
        capturedVariablesWithValues.values()
      ).map((info) => info.value);
      if (captureValues.every((value) => value !== undefined)) {
        captureValue = createStructValue(
          inferredCaptureType,
          captureValues as Value[]
        );
      } else {
        // Some values are runtime-only, use undefined for runtime-unknown captures
        captureValue = undefined;
      }
    } else {
      // No captured variables but expected undefined capture type - create empty struct
      const emptyStructType = createStructType(env);
      emptyStructType.fields = [];

      // Auto-derive all applicable traits (Send, Acyclic, Comptime, Runtime)
      env = autoDeriveTraitsAndAddRcFunctionsForStructType({
        structType: emptyStructType,
        env,
        context: { ...context },
      });

      captureType = emptyStructType;
      captureValue = createStructValue(emptyStructType, []);
    }
  } else {
    // Explicit struct type case: validate that captured variables match the expected struct fields
    if (capturedVariablesWithValues && capturedVariablesWithValues.size > 0) {
      const expectedStruct = captureType as StructType;

      // Validate that all captured variables exist as fields in the expected struct
      const capturedVarNames = Array.from(capturedVariablesWithValues.keys());
      const expectedFieldNames = expectedStruct.fields.map(
        (elem) => elem.label
      );

      for (const capturedVar of capturedVarNames) {
        if (!expectedFieldNames.includes(capturedVar)) {
          throw formatErrorMessage({
            token: closureToken,
            errorMessage: `Captured variable "${capturedVar}" does not exist in expected capture struct "${typeToString(expectedStruct)}"`,
          });
        }
      }

      // Validate that all required fields in the struct are captured
      for (const field of expectedStruct.fields) {
        if (!capturedVarNames.includes(field.label)) {
          throw formatErrorMessage({
            token: closureToken,
            errorMessage: `Expected capture struct field "${field.label}" is not captured by this closure`,
          });
        }
      }

      // Validate that captured variable types match expected field types
      for (const [
        varName,
        captureInfo,
      ] of capturedVariablesWithValues.entries()) {
        const expectedField = expectedStruct.fields.find(
          (elem) => elem.label === varName
        );
        if (
          expectedField &&
          !areTypesCompatible(
            { type: expectedField.type, env },
            { type: captureInfo.type, env }
          )
        ) {
          throw formatErrorMessage({
            token: captureInfo.token,
            errorMessage: `Captured variable "${varName}" has type "${typeToString(captureInfo.type)}" but expected struct field has type "${typeToString(expectedField.type)}"`,
          });
        }
      }

      // Create a struct value from captured variables
      const captureValues = Array.from(
        capturedVariablesWithValues.values()
      ).map((info) => info.value);
      if (captureValues.every((value) => value !== undefined)) {
        captureValue = createStructValue(
          captureType as StructType,
          captureValues as Value[]
        );
      } else {
        // Some values are runtime-only
        captureValue = undefined;
      }
    } else {
      // No captured variables - create empty struct value
      captureValue = createStructValue(captureType as StructType, []);
    }
  }

  return { captureType, captureValue };
}

/**
 * Convert CapturedVariableInfo to FunctionCapturedVariableInfo by adding value and type.
 * This is needed because the context only tracks usage info, but we need the actual
 * variable values and types for closure creation.
 */
export function enrichCapturedVariables({
  capturedVariables,
  env,
}: {
  capturedVariables: Map<string, CapturedVariableInfo>;
  env: Environment;
}): Map<string, FunctionCapturedVariableInfo> {
  const enrichedMap = new Map<string, FunctionCapturedVariableInfo>();

  for (const [varName, captureInfo] of capturedVariables.entries()) {
    // Get the variable value and type from the specific frame level
    if (captureInfo.frameLevel < env.frames.length) {
      const frame = env.frames[captureInfo.frameLevel]!;
      const variable = frame.variables.find((v) => v.name === varName);
      if (
        variable &&
        !variable.isCompileTimeOnly // NOTE: Ignore compile-time-only variables
      ) {
        enrichedMap.set(varName, {
          ...captureInfo,
          value: variable.value?.[0], // Can be undefined for runtime values
          type: variable.type,
        });
      }
    }
  }

  return enrichedMap;
}

/**
 * Generate ___dup expressions for captured ARC variables.
 *
 * This function creates and evaluates ___dup expressions for all captured variables
 * that require ARC (Automatic Reference Counting). These expressions are used during
 * closure construction to properly handle reference counting.
 *
 * @param capturedVariablesWithValues - Map of captured variables with their values and types
 * @param env - The environment to use for evaluation
 * @param context - The evaluator context
 * @returns Object containing the generated dup expressions and updated environment
 */
export function generateCapturedVariableDupExpressions({
  capturedVariablesWithValues,
  env,
  context,
}: {
  capturedVariablesWithValues:
    | Map<string, FunctionCapturedVariableInfo>
    | undefined;
  env: Environment;
  context: EvaluatorContext;
}): {
  capturedVariableDupExpressions: Expr[] | undefined;
  env: Environment;
} {
  const capturedVariableDupExpressions: Expr[] = [];
  let finalEnv = env;

  if (capturedVariablesWithValues && capturedVariablesWithValues.size > 0) {
    for (const [
      varName,
      captureInfo,
    ] of capturedVariablesWithValues.entries()) {
      // Check if the captured variable type requires ARC (contains ARC types)
      if (typeContainsRcType(captureInfo.type)) {
        // Create an expression: varName.___dup()
        const dupExpr: Expr = generateExprFromCode(
          `${BuiltinFunctions.___dup[0]!}(${varName})`
        );

        // Evaluate the dupExpr to ensure it's properly typed and processed
        const evaluatedDupExpr = evaluateExpression({
          expr: dupExpr,
          env: finalEnv,
          context: { ...context },
        });

        capturedVariableDupExpressions.push(evaluatedDupExpr);

        // Update the environment with the evaluated expression's environment
        if (evaluatedDupExpr.$ && evaluatedDupExpr.$.env) {
          finalEnv = evaluatedDupExpr.$.env;
        }
      }
    }
  }

  return {
    capturedVariableDupExpressions:
      capturedVariableDupExpressions.length > 0
        ? capturedVariableDupExpressions
        : undefined,
    env: finalEnv,
  };
}
