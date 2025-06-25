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
  FuncCallExpr,
} from "../../expr";
import {
  createModuleType,
  isModuleType,
  ModuleType,
  typeToString,
} from "../../types";
import { createModuleValue, ModuleValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
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
        for (let i = 0; i < exportExprs.length; i++) {
          const exportExpr = exportExprs[i]!;

          // spread operator for export all elements in another module
          if (
            exprIsFunctionCall(exportExpr) &&
            exprIsFunctionCallOf(exportExpr, "...")
          ) {
            const extendedModuleExpr = exportExpr.args[0]!;
            let excludeMembersExpr = exportExpr.args[1];
            // Evaluate the extended struct expression
            const evaluatedExtendedModuleExpr = context.evaluateExpression({
              expr: extendedModuleExpr,
              env,
              context: {
                ...context,
                SelfType: undefined, // NOTE: Module doesn't have SelfType
                ModuleType: moduleType,
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
                const existingElement = extendedModuleType.elements.find(
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
                  isMutable: false,
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
                  // Iterate over the elements of the tuple
                  for (const memberExpr of excludeMembersExpr.args) {
                    if (!exprIsAtom(memberExpr)) {
                      throw formatErrorMessage({
                        token: memberExpr.token,
                        errorMessage: `Expected identifier for excluded label, got:\n${exprToString(memberExpr)}`,
                      });
                    }
                    const label = memberExpr.token.value;
                    // Check if the label is in the extended module type
                    const existingElement = extendedModuleType.elements.find(
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
                      isMutable: false,
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

            // Iterate over the elements of the extended struct
            for (let i = 0; i < extendedModuleType.elements.length; i++) {
              const extendedStructElement = extendedModuleType.elements[i]!;
              // Check if the element is excluded
              if (excludedLabels.has(extendedStructElement.label)) {
                // Skip the element if it's excluded
                continue;
              }

              // Check if there is duplicate labels
              // If yes, then throw an error
              const existingElementIndex = moduleType.elements.findIndex(
                (e) => e.label === extendedStructElement.label
              );
              if (existingElementIndex >= 0) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Element "${extendedStructElement.label}" is already exported in the module.`,
                });
              } else {
                // Add the element to the module type
                moduleType.elements.push({
                  label: extendedStructElement.label,
                  type: extendedStructElement.type,
                  isCompileTimeOnly: extendedStructElement.isCompileTimeOnly,
                  isImplicit: extendedStructElement.isImplicit,
                  assignedValue: extendedStructElement.isCompileTimeOnly
                    ? extendedStructElement.assignedValue
                    : undefined,
                  defaultValue: extendedStructElement.defaultValue,
                  exprs: {
                    expr: exportExpr,
                    labelExpr: undefined,
                    typeExpr: undefined,
                    assignedValueExpr: undefined,
                    defaultValueExpr: undefined,
                  },
                });

                // Add the value to the module element values
                if (extendedModuleValue) {
                  moduleElementValues.push(extendedModuleValue.elements[i]);
                } else {
                  moduleElementValues.push(undefined);
                }

                // Add information to exportExpr
                exportExpr.$ = {
                  env,
                  type: extendedStructElement.type,
                  value: extendedModuleValue
                    ? extendedModuleValue.elements[i]
                    : undefined,
                  isMutable: false, // TODO: Check if the element is mutable
                  pathCollection: [],
                };
              }
            }
          } else {
            if (!isValidVariableName(exportExpr)) {
              throw formatErrorMessage({
                token: exportExpr.token,
                errorMessage: `Expected identifier for export, got:\n${exprToString(exportExpr)}`,
              });
            }

            const variableName = exportExpr.token.value;
            // Get the variable from the env
            const variables = getVariablesFromEnv(env, variableName);
            if (variables.length === 0) {
              throw formatErrorMessage({
                token: exportExpr.token,
                errorMessage: `Variable "${variableName}" is not defined in the module.`,
              });
            }
            const variable = variables[variables.length - 1]!;

            // Check if the same variable is already exported
            const existingElementIndex = moduleType.elements.findIndex(
              (e) => e.label === variableName
            );
            if (existingElementIndex >= 0) {
              // Throw error if the variable is already exported
              throw formatErrorMessage({
                token: exportExpr.token,
                errorMessage: `Variable "${variableName}" is already exported in the module.`,
              });
            } else {
              // Prevent exporting runtime variable
              if (!variable.isCompileTimeOnly) {
                throw formatErrorMessage({
                  token: exportExpr.token,
                  errorMessage: `Variable "${variableName}" is not a compile-time variable and cannot be exported.`,
                });
              }

              // Add the variable to the module type
              moduleType.elements.push({
                label: variableName,
                type: variable.type,
                isCompileTimeOnly: variable.isCompileTimeOnly,
                isImplicit: variable.isImplicit,
                assignedValue: variable.isCompileTimeOnly
                  ? variable.value
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
              moduleElementValues.push(variable.value);

              // Add information to exportExpr
              exportExpr.$ = {
                env,
                type: variable.type,
                value: variable.value,
                isMutable: variable.isMutable,
                pathCollection: [],
              };
            }
          }
        }
      } else {
        const evaluatedExpr = context.evaluateExpression({
          expr,
          env,
          context: {
            ...context,
            expectedType: undefined,
            SelfType: undefined, // NOTE: Module doesn't have SelfType
            ModuleType: moduleType,
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
    env = popEnvFrame(env);
  } catch (error) {
    if (allowPartialModule) {
      partialModuleError = error;
    } else {
      throw error;
    }
  }

  // Create the module value
  const moduleValue = createModuleValue(moduleType, moduleElementValues);

  return {
    moduleValue,
    moduleType,
    env,
    partialModuleError,
  };
}

export function evaluateAnonymousModule({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.module)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "module", got:\n${exprToString(expr)}`,
    });
  }
  if (expr.args.length !== 1) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "module" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }
  const moduleBodyExpr = expr.args[0]!;
  if (
    !exprIsFunctionCall(moduleBodyExpr) ||
    !exprIsFunctionCallOf(moduleBodyExpr, BuiltinKeywords.begin)
  ) {
    throw formatErrorMessage({
      token: moduleBodyExpr.token,
      errorMessage: `Expected "begin", got:\n${exprToString(moduleBodyExpr)}`,
    });
  }

  const beginExprs = moduleBodyExpr.args;

  const {
    moduleType,
    moduleValue,
    env: nextEnv,
  } = evaluateAnonymousModuleBeginExprs({
    beginExprs,
    env,
    context: {
      ...context,
      expectedType: undefined,
      SelfType: undefined,
    },
  });
  env = nextEnv;

  // Set the module value to the expr
  expr.$ = {
    env,
    type: moduleType,
    value: moduleValue,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
