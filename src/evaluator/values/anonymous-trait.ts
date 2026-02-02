import {
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
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
import { createTraitType } from "../../types/creators";
import { TraitType, Type } from "../../types/definitions";
import { createTraitValue, TraitValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";

export function evaluateAnonymousTraitBeginExprs({
  beginExprs,
  env,
  context,
  allowPartialModule = false,
  receiverType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
}: {
  beginExprs: Expr[];
  env: Environment;
  context: EvaluatorContext;
  /**
   * This is mainly used for the vscode extension
   * Even though the module failed to evaluate completely,
   * we still want to return the traitValue so the hoverProvider and completionProvider can work.
   */
  allowPartialModule?: boolean;
  receiverType?: Type;
}): {
  traitValue: TraitValue;
  traitType: TraitType;
  env: Environment;
  partialModuleError?: Error;
} {
  // Create module type
  const traitType = createTraitType(env);
  const traitElementValues: (Value | undefined)[] = [];

  let partialModuleError: Error | undefined = undefined;

  // Push new frame to the env
  env = pushEnvFrame(env);

  // Evaluate each expression in the begin
  for (let i = 0; i < beginExprs.length; i++) {
    const expr = beginExprs[i]!;
    try {
      // Export
      if (
        exprIsFunctionCall(expr) &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.export)
      ) {
        const exportExprs = expr.args;
        for (let j = 0; j < exportExprs.length; j++) {
          const exportExpr = exportExprs[j]!;

          // Check if it's
          //          variableName        givenVariableName
          // - export Add
          // - export Add           :     _Add
          {
            let variableName: string = "";
            let givenVariableName: string = "";
            if (exprIsAtom(exportExpr)) {
              if (!isValidVariableName(exportExpr)) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Expected identifier for export, got:\n${exprToString(exportExpr)}`,
                });
              }

              variableName = exportExpr.token.value;
              givenVariableName = variableName;
            } else if (
              exprIsFunctionCall(exportExpr) &&
              exprIsFunctionCallOf(exportExpr, ":", 2)
            ) {
              // Check if it's export Add : _Add
              const labelExpr = exportExpr.args[0]!;
              const nameExpr = exportExpr.args[1]!;

              if (!exprIsAtom(labelExpr)) {
                throw formatErrorMessage({
                  token: labelExpr.token,
                  errorMessage: `Expected identifier for export, got:\n${exprToString(labelExpr)}`,
                });
              }
              if (!isValidVariableName(labelExpr)) {
                throw formatErrorMessage({
                  token: labelExpr.token,
                  errorMessage: `Expected identifier for export, got:\n${exprToString(labelExpr)}`,
                });
              }
              variableName = labelExpr.token.value;

              if (!exprIsAtom(nameExpr)) {
                throw formatErrorMessage({
                  token: nameExpr.token,
                  errorMessage: `Expected identifier for export, got:\n${exprToString(nameExpr)}`,
                });
              }
              if (!isValidVariableName(nameExpr)) {
                throw formatErrorMessage({
                  token: nameExpr.token,
                  errorMessage: `Expected identifier for export, got:\n${exprToString(nameExpr)}`,
                });
              }
              givenVariableName = nameExpr.token.value;
            }

            // Get the variable from the env
            const variables = getVariablesFromEnv(env, givenVariableName);
            if (variables.length === 0) {
              throw formatErrorMessage({
                token: exportExpr.token,
                errorMessage: `Variable "${givenVariableName}" is not defined in the module.`,
              });
            }
            const variable = variables[variables.length - 1]!;

            // Check if the same variable is already exported
            const existingElementIndex = traitType.fields.findIndex(
              (e) => e.label === givenVariableName
            );
            if (existingElementIndex >= 0) {
              // Throw error if the variable is already exported
              throw formatErrorMessage({
                token: exportExpr.token,
                errorMessage: `Variable "${givenVariableName}" is already exported in the module.`,
              });
            } else {
              // Prevent exporting runtime variable
              if (!variable.isCompileTimeOnly) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Variable "${givenVariableName}" is not a compile-time variable and cannot be exported.`,
                });
              }

              // Add the variable to the module type
              traitType.fields.push({
                label: variableName,
                type: variable.type,
                isCompileTimeOnly: variable.isCompileTimeOnly,
                assignedValue: variable.isCompileTimeOnly
                  ? variable.value?.[0]
                  : undefined,
                defaultValue: undefined,
                exprs: {
                  expr: exportExpr,
                  labelExpr: undefined,
                  typeExpr: undefined,
                  assignedValueExpr: undefined,
                  defaultValueExpr: undefined,
                },
              });
              traitElementValues.push(variable.value?.[0]);

              // Add information to exportExpr
              exportExpr.$ = {
                env,
                type: variable.type,
                value: variable.value?.[0],
                pathCollection: [],
              };
            }
          }
        }
      } else {
        const evaluatedExpr = evaluateExpression({
          expr,
          env,
          context: {
            ...context,
            expectedType: undefined,
            SelfType: receiverType, // traitType, // Self refers to the module being built
          },
        });
        if (evaluatedExpr.$?.env) {
          env = evaluatedExpr.$?.env;
        }
      }
    } catch (error) {
      if (allowPartialModule) {
        partialModuleError = error;
        break;
      } else {
        throw error;
      }
    }
  }

  // Pop the env frame
  try {
    // NOTE: Pop the env frame here might fail,
    // For example, for any uninitialized variable, or unconsumed linear variables.
    if (!partialModuleError) {
      env = popEnvFrame(env);
    }
  } catch (error) {
    if (allowPartialModule) {
      partialModuleError = error;
    } else {
      throw error;
    }
  }

  // Create the module value
  const traitValue = createTraitValue(
    { ...traitType, receiverType: receiverType },
    traitElementValues
  );

  return {
    traitValue,
    traitType,
    env,
    partialModuleError,
  };
}
