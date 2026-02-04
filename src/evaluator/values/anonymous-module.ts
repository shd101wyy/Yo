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
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../../expr";
import { createModuleType } from "../../types/creators";
import { ModuleType } from "../../types/definitions";
import { isModuleType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import { createModuleValue, ModuleValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { validateTypeAvailability } from "../trait-checking";
import { isValidVariableName } from "../utils";

export function evaluateAnonymousModuleBeginExprs({
  beginExprs,
  env,
  context,
  allowPartialModule = false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
}: {
  beginExprs: Expr[];
  env: Environment;
  context: EvaluatorContext;
  /**
   * This is mainly used for the vscode extension
   * Even though the module failed to evaluate completely,
   * we still want to return the moduleValue so the hoverProvider and completionProvider can work.
   */
  allowPartialModule?: boolean;
}): {
  moduleValue: ModuleValue;
  moduleType: ModuleType;
  env: Environment;
  partialModuleError?: Error;
} {
  // Create module type
  const moduleType = createModuleType(env);
  const moduleElementValues: (Value | undefined)[] = [];

  let partialModuleError: Error | undefined = undefined;

  // Push new frame to the env
  env = pushEnvFrame(env);

  const ownsPendingTypeAvailabilityChecks =
    context.pendingTypeAvailabilityChecks === undefined;
  if (ownsPendingTypeAvailabilityChecks) {
    context.pendingTypeAvailabilityChecks = [];
  }

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

          // spread operator for export all fields in another module
          if (
            exprIsFunctionCall(exportExpr) &&
            exprIsFunctionCallOf(exportExpr, "...")
          ) {
            const extendedModuleExpr = exportExpr.args[0]!;
            let excludeMembersExpr = exportExpr.args[1];
            // Evaluate the extended struct expression
            const evaluatedExtendedModuleExpr = evaluateExpression({
              expr: extendedModuleExpr,
              env,
              context: {
                ...context,
              },
            });
            if (!evaluatedExtendedModuleExpr.$) {
              throw formatErrorMessage({
                token: extendedModuleExpr.token,
                errorMessage: `Failed to evaluate the extended struct expression:\n${exprToString(extendedModuleExpr)}`,
              });
            }
            const extendedModuleType = evaluatedExtendedModuleExpr.$.type;
            if (!isModuleType(extendedModuleType)) {
              throw formatErrorMessage({
                token: extendedModuleExpr.token,
                errorMessage: `Expected struct type for export, got:\n${typeToString(extendedModuleType)}`,
              });
            }
            const extendedModuleValue = evaluatedExtendedModuleExpr.$.value as
              | ModuleValue
              | undefined;

            const excludedLabels: Set<string> = new Set();
            if (excludeMembersExpr) {
              if (
                exprIsFunctionCall(excludeMembersExpr) &&
                exprIsFunctionCallOf(excludeMembersExpr, ":", 2) &&
                exprIsAtomOf(excludeMembersExpr.args[0]!, "exclude")
              ) {
                excludeMembersExpr = excludeMembersExpr.args[1]!;
              }
              if (exprIsAtom(excludeMembersExpr)) {
                const label = excludeMembersExpr.token.value;
                // Check if the label is in the extended module type
                const existingElement = extendedModuleType.fields.find(
                  (e) => e.label === label
                );
                if (!existingElement) {
                  throw formatErrorMessage({
                    token: excludeMembersExpr.token,
                    errorMessage: `Label "${label}" is not found in the extended module type.`,
                  });
                }
                // Add the label to the excluded labels
                excludedLabels.add(label);
                excludeMembersExpr.$ = {
                  env,
                  type: existingElement.type,
                  value: existingElement.assignedValue,
                  pathCollection: [],
                };
              } else {
                // Check if it's a tuple
                if (
                  exprIsFunctionCall(excludeMembersExpr) &&
                  exprIsFunctionCallOf(
                    excludeMembersExpr,
                    BuiltinKeywords.tuple
                  )
                ) {
                  // Iterate over the fields of the tuple
                  for (const memberExpr of excludeMembersExpr.args) {
                    if (!exprIsAtom(memberExpr)) {
                      throw formatErrorMessage({
                        token: memberExpr.token,
                        errorMessage: `Expected identifier for excluded label, got:\n${exprToString(memberExpr)}`,
                      });
                    }
                    const label = memberExpr.token.value;
                    // Check if the label is in the extended module type
                    const existingElement = extendedModuleType.fields.find(
                      (e) => e.label === label
                    );
                    if (!existingElement) {
                      throw formatErrorMessage({
                        token: memberExpr.token,
                        errorMessage: `Label "${label}" is not found in the extended module type.`,
                      });
                    }
                    // Add the label to the excluded labels
                    excludedLabels.add(label);
                    memberExpr.$ = {
                      env,
                      type: existingElement.type,
                      value: existingElement.assignedValue,
                      pathCollection: [],
                    };
                  }
                } else {
                  throw formatErrorMessage({
                    token: excludeMembersExpr.token,
                    errorMessage: `Expected identifier or tuple for excluded labels, got:\n${exprToString(
                      excludeMembersExpr
                    )}`,
                  });
                }
              }
            }

            // Iterate over the fields of the extended struct
            for (let k = 0; k < extendedModuleType.fields.length; k++) {
              const extendedStructField = extendedModuleType.fields[k]!;
              // Check if the field is excluded
              if (excludedLabels.has(extendedStructField.label)) {
                // Skip the field if it's excluded
                continue;
              }

              // Check if there is duplicate labels
              // If yes, then throw an error
              const existingElementIndex = moduleType.fields.findIndex(
                (e) => e.label === extendedStructField.label
              );
              if (existingElementIndex >= 0) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Element "${extendedStructField.label}" is already exported in the module.`,
                });
              } else {
                // Add the field to the module type
                moduleType.fields.push({
                  label: extendedStructField.label,
                  type: extendedStructField.type,
                  isCompileTimeOnly: extendedStructField.isCompileTimeOnly,
                  assignedValue: extendedStructField.isCompileTimeOnly
                    ? extendedStructField.assignedValue
                    : undefined,
                  defaultValue: extendedStructField.defaultValue,
                  exprs: {
                    expr: exportExpr,
                    labelExpr: undefined,
                    typeExpr: undefined,
                    assignedValueExpr: undefined,
                    defaultValueExpr: undefined,
                  },
                });

                // Add the value to the module field values
                if (extendedModuleValue) {
                  moduleElementValues.push(extendedModuleValue.fields[k]);
                } else {
                  moduleElementValues.push(undefined);
                }

                // Add information to exportExpr
                exportExpr.$ = {
                  env,
                  type: extendedStructField.type,
                  value: extendedModuleValue
                    ? extendedModuleValue.fields[k]
                    : undefined,
                  pathCollection: [],
                };
              }
            }
          }
          // Check if it's
          //          variableName        givenVariableName
          // - export Add
          // - export Add           :     _Add
          else {
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
            const existingElementIndex = moduleType.fields.findIndex(
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
              moduleType.fields.push({
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
              moduleElementValues.push(variable.value?.[0]);

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

  if (
    ownsPendingTypeAvailabilityChecks &&
    context.pendingTypeAvailabilityChecks &&
    context.pendingTypeAvailabilityChecks.length > 0
  ) {
    try {
      for (const pending of context.pendingTypeAvailabilityChecks) {
        validateTypeAvailability(pending.type, env, pending.token);
      }
    } catch (error) {
      if (allowPartialModule) {
        partialModuleError = error as Error;
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
  const moduleValue = createModuleValue({ ...moduleType }, moduleElementValues);

  return {
    moduleValue,
    moduleType,
    env,
    partialModuleError,
  };
}
