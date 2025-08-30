import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinKeywords,
  ControlFlowKind,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
  mergeAndCheckEnvs,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createMutPtrType,
  createPtrType,
  EnumType,
  isEnumType,
  isFunctionTypeAndReturnsComptValue,
  isMutPtrType,
  isPtrType,
  MutPtrType,
  PtrType,
  Type,
  TypeTag,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isEnumValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateBeginExpression } from "./begin";

/**
 *
 *
 * match shape // shape will be consumed here and moved to `s` in each condition.
 *   .Circle => ((s) => s.radius),
 *   .Square => ((s) => s.side),
 *   .Rectangle => ((s) => s.width + s.height)
 * ;
 */
export function evaluateMatch({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "match", got ${expr.tag}`,
    });
  }

  const args = expr.args;
  if (args.length < 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least 2 arguments for "match", got ${args.length}`,
    });
  }

  // Evaluate the value to be matched
  const scrutineeExpr = args[0]!;

  // Evaluate any expression as scrutinee, not just atoms

  const evaluatedScrutineeExpr = context.evaluateExpression({
    expr: scrutineeExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedScrutineeExpr.$) {
    throw formatErrorMessage({
      token: scrutineeExpr.token,
      errorMessage: `Failed to evaluate the match scrutinee expression: ${exprToString(scrutineeExpr)}`,
    });
  }
  env = evaluatedScrutineeExpr.$.env;

  const scrutineeType = evaluatedScrutineeExpr.$.type;
  const scrutineeValue = evaluatedScrutineeExpr.$.value;

  // Check if it's a pointer type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType: TypeTag.Ptr | TypeTag.MutPtr | undefined = undefined;

  let enumType: Type;

  if (isPtrType(scrutineeType) || isMutPtrType(scrutineeType)) {
    enumType = scrutineeType.type;
    ptrOrRefType = scrutineeType.tag;
  } else {
    enumType = scrutineeType;
  }

  // Check if the value is an enum type
  if (!isEnumType(enumType)) {
    throw formatErrorMessage({
      token: scrutineeExpr.token,
      errorMessage: `Expected enum type for match expression, got ${
        scrutineeType ? typeToString(scrutineeType) : "unknown type"
      }`,
    });
  }

  // Check if there is already selected variant,
  // If yes, then we disallow to use enum because we already know the selected variant.
  /*
  if (enumType.selectedVariantName) {
    throw formatErrorMessage({
      token: valueExpr.token,
      errorMessage:
        `Enum type ${typeToString(enumType)} already has selected variant "${enumType.selectedVariantName}".\n` +
        `You cannot use "match" on it, because it already has a selected variant.`,
    });
  }
  */

  const patterns = args.slice(1);

  // Evaluate each statement
  // expect each value to be the same type.
  const bodies: Expr[] = [];
  let resultType: { type: Type; env: Environment } | undefined = undefined;
  const checkedVariantNames: Set<string> = new Set();
  let hasCaseThatDoesntHaveControlFlowSet = false;
  let usedWildcardPattern = false;
  const controlFlows: string[] = []; // Track control flows from all cases

  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;

    // NOTE: We shouldn't use the parent `env` here
    // instead, we should create new env.
    let caseEnv = env; // pushFrame(env); // NOTE: No need to do this. We now use evaluateBeginExpression instead of evaluateExpression. evaluateBeginExpression will push frame itself.

    // Check if the pattern is a valid match arm
    if (
      !exprIsFunctionCall(pattern) ||
      !exprIsFunctionCallOf(pattern, "=>", 2)
    ) {
      throw formatErrorMessage({
        token: pattern.token,
        errorMessage: `Expected ":" for match pattern, got ${exprToString(pattern)}`,
      });
    }

    const matchArmExpr = pattern.args[0]!;
    const rhsExpr = pattern.args[1]!;

    // Check if the pattern is a valid enum variant
    if (
      // For patterns like .Red
      (exprIsFunctionCall(matchArmExpr) &&
        exprIsFunctionCallOf(matchArmExpr, ".", 1)) ||
      // "_" is a wildcard pattern
      exprIsAtomOf(matchArmExpr, "_")
    ) {
      if (usedWildcardPattern) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Wildcard pattern "_" can only be used once and must be the last match arm in a "match" expression.`,
        });
      }

      // For patterns like .Red
      let variantNameExpr: Expr;
      if (exprIsFunctionCall(matchArmExpr)) {
        variantNameExpr = matchArmExpr.args[0]!;
        if (!exprIsAtom(variantNameExpr)) {
          throw formatErrorMessage({
            token: matchArmExpr.token,
            errorMessage: `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`,
          });
        }
      } else {
        // "_" is a wildcard pattern
        usedWildcardPattern = true;
        variantNameExpr = matchArmExpr;
      }

      const variantName = variantNameExpr.token.value;
      // Check if variant exists in enum
      const variant = enumType.variants.find((v) => v.name === variantName);
      if (!variant && variantName !== "_") {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(
            enumType
          )}`,
        });
      }

      // Enforce Rust-like constraint: if variant has fields, it must be destructured
      if (variant && variant.elements && variant.elements.length > 0) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Enum variant "${variantName}" has ${variant.elements.length} field(s) and must be destructured. Use .${variantName}(...) instead of .${variantName}`,
        });
      }

      checkedVariantNames.add(variantName);
      if (
        variantName !== "_" &&
        isEnumValue(scrutineeValue) &&
        scrutineeValue.variantName !== variantName
      ) {
        continue; // No need to continue if the variant is not selected
      }

      // Update the enum type to set the selectedVariantName
      const newEnumType = {
        ...enumType,
        selectedVariantName: variantName === "_" ? undefined : variantName,
      };
      /// Add the newEnumType with selectedVariantName to the variantNameExpr
      variantNameExpr.$ = {
        env: caseEnv,
        type: newEnumType,
        value: undefined,
        isMutable: false,
        pathCollection: [],
      };

      let variableType: EnumType | PtrType | MutPtrType = newEnumType;
      if (ptrOrRefType) {
        if (ptrOrRefType === TypeTag.Ptr) {
          variableType = createPtrType(newEnumType);
        } else if (ptrOrRefType === TypeTag.MutPtr) {
          variableType = createMutPtrType(newEnumType);
        }
      }

      const bodyExpr = rhsExpr;

      if (evaluatedScrutineeExpr.$.variableName) {
        const variableName = evaluatedScrutineeExpr.$.variableName;

        // Add the new variable to env
        const { env: nextEnv } = addVariableToEnv({
          env: caseEnv,
          variable: {
            name: variableName,
            type: variableType,
            isMutable: evaluatedScrutineeExpr.$.isMutable,
            isCompileTimeOnly: false,
            isImplicit: false,
            value: evaluatedScrutineeExpr.$.value,
            token: evaluatedScrutineeExpr.token,
            initializedAtToken: evaluatedScrutineeExpr.token, // Set as initialized
            consumedAtToken: undefined, // Not consumed yet
          },
          allowDuplicate: true, // Allow duplicate for match arms
        });
        caseEnv = nextEnv;
      }

      // Mark the case as executed
      matchArmExpr.$ = {
        env: caseEnv,
        type: variableType,
        value: undefined, // No value yet
        isMutable: evaluatedScrutineeExpr.$.isMutable,
        pathCollection: [],
        caseExecuted: true, // Mark the case as executed
      };

      // Evaluate the result expression
      const evaluatedBody = evaluateBeginExpression({
        expr: bodyExpr,
        env: caseEnv,
        context: {
          ...context,
          isExecuting:
            isEnumValue(scrutineeValue) &&
            scrutineeValue.variantName === variantName,
        },
        variablesToAdd: [],
      });
      // We don't update the original env here since each pattern has its own scope

      if (!evaluatedBody.$?.type) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected type for match result expression, got ${exprToString(
            bodyExpr
          )}`,
        });
      }

      // Check if the the evaluatedBody has "return"/"break"/"continue" expression
      if (evaluatedBody.$.controlFlow) {
        controlFlows.push(evaluatedBody.$.controlFlow);
        // Check if we have a scrutinee value
        // If so, then this is the matched arm.
        if (scrutineeValue && isEnumValue(scrutineeValue)) {
          // If the scrutinee value is an enum value, we can return it directly
          expr.$ = {
            env: evaluatedBody.$.env,
            type: evaluatedBody.$.type,
            value: evaluatedBody.$.value,
            isMutable: evaluatedBody.$.isMutable,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        }
      } else {
        hasCaseThatDoesntHaveControlFlowSet = true;
      }

      caseEnv = evaluatedBody.$.env;
      bodies.push(evaluatedBody);

      // Set or verify the result type consistency
      if (!resultType) {
        resultType = { type: evaluatedBody.$?.type, env: caseEnv };
      } else if (
        !areTypesCompatible(
          { type: resultType.type, env: caseEnv },
          { type: evaluatedBody.$?.type, env }
        )
      ) {
        // Check if the types match when converting to runtime type
        if (
          areTypesCompatible(
            {
              type: convertComptTypeToRuntimeType(resultType.type),
              env: resultType.env,
            },
            {
              type: evaluatedBody.$.type,
              env: caseEnv,
            }
          )
        ) {
          resultType = { type: evaluatedBody.$.type, env: caseEnv };
        } else {
          throw formatErrorMessage({
            token: scrutineeExpr.token,
            errorMessage: `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBody.$.type)}`,
          });
        }
      }
    }
    // For patterns with destructuring like .Circle(r) or .Rectangle(w, h)
    else if (
      exprIsFunctionCall(matchArmExpr) &&
      exprIsFunctionCall(matchArmExpr.func) &&
      exprIsFunctionCallOf(matchArmExpr.func, ".", 1)
    ) {
      if (usedWildcardPattern) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Wildcard pattern "_" can only be used once and must be the last match arm in a "match" expression.`,
        });
      }

      // Extract variant name from .Circle(r) pattern
      const variantNameExpr = matchArmExpr.func.args[0]!;
      if (!exprIsAtom(variantNameExpr)) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Expected identifier for enum variant, got ${exprToString(variantNameExpr)}`,
        });
      }

      const variantName = variantNameExpr.token.value;

      // Check if variant exists in enum
      const variant = enumType.variants.find((v) => v.name === variantName);
      if (!variant) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in ${typeToString(enumType)}`,
        });
      }

      checkedVariantNames.add(variantName);

      // Check if this variant should be matched
      if (
        isEnumValue(scrutineeValue) &&
        scrutineeValue.variantName !== variantName
      ) {
        continue; // No need to continue if the variant is not selected
      }

      // Extract destructuring parameters
      const destructuringParams = matchArmExpr.args;

      // Check if variant has elements
      if (variant.elements && variant.elements.length > 0) {
        // For labeled destructuring, we don't require all parameters to be specified
        // For positional destructuring, we require exact match
        const hasLabeledParams = destructuringParams.some(
          (param) =>
            exprIsFunctionCall(param) && exprIsFunctionCallOf(param, ":", 2)
        );

        if (
          !hasLabeledParams &&
          destructuringParams.length !== variant.elements.length
        ) {
          throw formatErrorMessage({
            token: matchArmExpr.token,
            errorMessage: `Variant "${variantName}" expects ${variant.elements.length} parameters, got ${destructuringParams.length}`,
          });
        }
      } else if (destructuringParams.length > 0) {
        throw formatErrorMessage({
          token: matchArmExpr.token,
          errorMessage: `Variant "${variantName}" has no elements, but destructuring parameters were provided`,
        });
      }

      // Update the enum type to set the selectedVariantName
      const newEnumType = {
        ...enumType,
        selectedVariantName: variantName,
      };

      // Add the newEnumType with selectedVariantName to the variantNameExpr
      variantNameExpr.$ = {
        env: caseEnv,
        type: newEnumType,
        value: undefined,
        isMutable: false,
        pathCollection: [],
      };

      let variableType: EnumType | PtrType | MutPtrType = newEnumType;
      if (ptrOrRefType) {
        if (ptrOrRefType === TypeTag.Ptr) {
          variableType = createPtrType(newEnumType);
        } else if (ptrOrRefType === TypeTag.MutPtr) {
          variableType = createMutPtrType(newEnumType);
        }
      }

      // Add destructured variables to environment
      if (variant.elements && variant.elements.length > 0) {
        const destructuredLabels = new Set<string>();

        for (let j = 0; j < destructuringParams.length; j++) {
          const param = destructuringParams[j]!;

          // Handle labeled destructuring like (label: variable) or (label: _)
          if (
            exprIsFunctionCall(param) &&
            exprIsFunctionCallOf(param, ":", 2)
          ) {
            const labelExpr = param.args[0]!;
            const variableExpr = param.args[1]!;

            if (!exprIsAtom(labelExpr)) {
              throw formatErrorMessage({
                token: labelExpr.token,
                errorMessage: `Expected identifier for label in destructuring pattern, got ${exprToString(labelExpr)}`,
              });
            }

            const label = labelExpr.token.value;

            // Find the element with matching label
            const elementIndex = variant.elements.findIndex(
              (elem) => elem.label === label
            );
            if (elementIndex === -1) {
              throw formatErrorMessage({
                token: labelExpr.token,
                errorMessage: `Label "${label}" not found in variant "${variantName}". Available labels: ${variant.elements.map((e) => e.label).join(", ")}`,
              });
            }

            if (destructuredLabels.has(label)) {
              throw formatErrorMessage({
                token: labelExpr.token,
                errorMessage: `Label "${label}" is already destructured`,
              });
            }
            destructuredLabels.add(label);

            const element = variant.elements[elementIndex]!;

            // Handle the variable part (could be identifier or _)
            if (exprIsAtom(variableExpr)) {
              const variableName = variableExpr.token.value;

              // Skip if variable name is "_" (ignore pattern)
              if (variableName !== "_") {
                const { env: nextEnv } = addVariableToEnv({
                  env: caseEnv,
                  variable: {
                    name: variableName,
                    type: element.type,
                    isMutable: false,
                    isCompileTimeOnly: false,
                    isImplicit: false,
                    value: undefined,
                    token: variableExpr.token,
                    initializedAtToken: variableExpr.token,
                    consumedAtToken: undefined,
                  },
                  allowDuplicate: true,
                });
                caseEnv = nextEnv;
              }
            } else {
              throw formatErrorMessage({
                token: variableExpr.token,
                errorMessage: `Expected identifier or "_" for variable in labeled destructuring, got ${exprToString(variableExpr)}`,
              });
            }
          }
          // Handle positional destructuring like (r) or (_)
          else if (exprIsAtom(param)) {
            const paramName = param.token.value;
            const element = variant.elements[j]!;

            // Skip if parameter name is "_" (ignore pattern)
            if (paramName !== "_") {
              const { env: nextEnv } = addVariableToEnv({
                env: caseEnv,
                variable: {
                  name: paramName,
                  type: element.type,
                  isMutable: false,
                  isCompileTimeOnly: false,
                  isImplicit: false,
                  value: undefined,
                  token: param.token,
                  initializedAtToken: param.token,
                  consumedAtToken: undefined,
                },
                allowDuplicate: true,
              });
              caseEnv = nextEnv;
            }
          } else {
            throw formatErrorMessage({
              token: param.token,
              errorMessage: `Expected identifier, "_", or labeled pattern (label: variable) for destructuring parameter, got ${exprToString(param)}`,
            });
          }
        }
      }

      // Add the scrutinee variable to env if it has a variable name
      if (evaluatedScrutineeExpr.$.variableName) {
        const variableName = evaluatedScrutineeExpr.$.variableName;
        const { env: nextEnv } = addVariableToEnv({
          env: caseEnv,
          variable: {
            name: variableName,
            type: variableType,
            isMutable: evaluatedScrutineeExpr.$.isMutable,
            isCompileTimeOnly: false,
            isImplicit: false,
            value: evaluatedScrutineeExpr.$.value,
            token: evaluatedScrutineeExpr.token,
            initializedAtToken: evaluatedScrutineeExpr.token,
            consumedAtToken: undefined,
          },
          allowDuplicate: true,
        });
        caseEnv = nextEnv;
      }

      // Mark the case as executed
      matchArmExpr.$ = {
        env: caseEnv,
        type: variableType,
        value: undefined,
        isMutable: evaluatedScrutineeExpr.$.isMutable,
        pathCollection: [],
        caseExecuted: true,
      };

      const bodyExpr = rhsExpr;

      // Evaluate the result expression
      const evaluatedBody = evaluateBeginExpression({
        expr: bodyExpr,
        env: caseEnv,
        context: {
          ...context,
          isExecuting:
            isEnumValue(scrutineeValue) &&
            scrutineeValue.variantName === variantName,
        },
        variablesToAdd: [],
      });

      if (!evaluatedBody.$?.type) {
        throw formatErrorMessage({
          token: bodyExpr.token,
          errorMessage: `Expected type for match result expression, got ${exprToString(bodyExpr)}`,
        });
      }

      // Handle control flow
      if (evaluatedBody.$.controlFlow) {
        controlFlows.push(evaluatedBody.$.controlFlow);
        if (scrutineeValue && isEnumValue(scrutineeValue)) {
          expr.$ = {
            env: evaluatedBody.$.env,
            type: evaluatedBody.$.type,
            value: evaluatedBody.$.value,
            isMutable: evaluatedBody.$.isMutable,
            pathCollection: evaluatedBody.$.pathCollection,
            controlFlow: evaluatedBody.$.controlFlow,
          };
        }
      } else {
        hasCaseThatDoesntHaveControlFlowSet = true;
      }

      caseEnv = evaluatedBody.$.env;
      bodies.push(evaluatedBody);

      // Set or verify the result type consistency
      if (!resultType) {
        resultType = { type: evaluatedBody.$?.type, env: caseEnv };
      } else if (
        !areTypesCompatible(
          { type: resultType.type, env: caseEnv },
          { type: evaluatedBody.$?.type, env }
        )
      ) {
        // Check if the types match when converting to runtime type
        if (
          areTypesCompatible(
            {
              type: convertComptTypeToRuntimeType(resultType.type),
              env: resultType.env,
            },
            {
              type: evaluatedBody.$.type,
              env: caseEnv,
            }
          )
        ) {
          resultType = { type: evaluatedBody.$.type, env: caseEnv };
        } else {
          throw formatErrorMessage({
            token: scrutineeExpr.token,
            errorMessage: `Incompatible types:
- Previous: ${typeToString(resultType.type)}
- Current : ${typeToString(evaluatedBody.$.type)}`,
          });
        }
      }
    } else {
      throw formatErrorMessage({
        token: matchArmExpr.token,
        errorMessage: `Invalid pattern in match expression: ${exprToString(matchArmExpr)}
Supported patterns:
- .VariantName (for variants without elements)
- .VariantName(param1, param2, ...) (for variants with elements)
- _ (wildcard pattern)`,
      });
    }
  }

  // Check the control flows, if they are mixed, we say there is no control flow
  let finalControlFlow: ControlFlowKind | undefined = undefined;
  if (controlFlows.every((cf) => cf === "return")) {
    finalControlFlow = "return";
  } else if (controlFlows.every((cf) => cf === "break")) {
    finalControlFlow = "break";
  } else if (controlFlows.every((cf) => cf === "continue")) {
    finalControlFlow = "continue";
  } else {
    if (context.isEvaluatingLoopBody) {
      if (controlFlows.find((cf) => cf === "continue")) {
        finalControlFlow = "continue"; // At least one case continues the loop
      } else if (controlFlows.find((cf) => cf === "break")) {
        finalControlFlow = "break"; // At least one case breaks the loop
      } else if (controlFlows.find((cf) => cf === "return")) {
        finalControlFlow = "return"; // At least one case returns from function
      }
    } else {
      finalControlFlow = undefined; // Mixed control flows
    }
  }

  if (
    hasCaseThatDoesntHaveControlFlowSet || // some case has no control flow
    !finalControlFlow // mixed control flows
  ) {
    if (hasCaseThatDoesntHaveControlFlowSet && !resultType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to determine the type of value from the cond.`,
      });
    } else if (!resultType) {
      resultType = { type: VUnit.type, env: env };
    }

    // Perform exhaustiveness check
    if (!checkedVariantNames.has("_")) {
      const missingVariants = enumType.variants.filter(
        (variant) => !checkedVariantNames.has(variant.name)
      );
      if (missingVariants.length > 0) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Match expression is not exhaustive. Missing cases for variants:
        
- ${missingVariants.map((v) => v.name).join("\n- ")}`,
        });
      }
    }

    // Merge and check all environments
    env = mergeAndCheckEnvs(
      env,
      bodies,
      bodies.map(() => ({ ...context }))
    );

    // Set the type and value of the match expression
    expr.$ = {
      env,
      type: resultType.type,
      // TODO: Support the compile-time value.
      // For compile-time evaluation, we'd determine which arm matches and set the value
      value: undefined, // createUnknownValue(resultType),
      isMutable: false,
      pathCollection: [],
    };
    attachTempVariableToExpr(expr);
  } else {
    // All cases have control flow - determine which one to use
    if (controlFlows.length === 0) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `No control flows found but expected some.`,
      });
    }

    if (finalControlFlow === "return") {
      // All cases are returning from function
      if (!context.isEvaluatingFunctionBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are returning from function, but not evaluating in function body.`,
        });
      }
      const functionReturnType =
        context.isEvaluatingFunctionBody.type.return.type;
      expr.$ = {
        env,
        type: functionReturnType,
        value: isFunctionTypeAndReturnsComptValue(
          context.isEvaluatingFunctionBody.type
        )
          ? createUnknownValue(functionReturnType)
          : undefined,
        isMutable: false,
        pathCollection: [],
        controlFlow: "return",
      };
    } else if (finalControlFlow === "break") {
      // All cases break from loop
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are breaking from loop, but not inside a loop.`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
        controlFlow: "break",
      };
    } else if (finalControlFlow === "continue") {
      // All cases continue loop
      if (!context.isEvaluatingLoopBody) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `All cases in match are continuing loop, but not inside a loop.`,
        });
      }
      expr.$ = {
        env,
        type: VUnit.type,
        value: VUnit,
        isMutable: false,
        pathCollection: [],
        controlFlow: "continue",
      };
    } else {
      // This should never reach
    }

    return expr;
  }

  return expr;
}
