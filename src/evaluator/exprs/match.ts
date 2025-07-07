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
  setExprAsConsumed,
} from "../../expr";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createMutPtrType,
  createMutRefType,
  createPtrType,
  createRefType,
  EnumType,
  isEnumType,
  isFunctionTypeAndReturnsComptValue,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  MutPtrType,
  MutRefType,
  PtrType,
  RefType,
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

  // Consume the value expression
  env = setExprAsConsumed(evaluatedScrutineeExpr, env, context);

  const scrutineeType = evaluatedScrutineeExpr.$.type;
  const scrutineeValue = evaluatedScrutineeExpr.$.value;

  // Check if it's a pointer/reference type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType:
    | TypeTag.Ptr
    | TypeTag.MutPtr
    | TypeTag.Ref
    | TypeTag.MutRef
    | undefined = undefined;

  let enumType: Type;

  if (
    isPtrType(scrutineeType) ||
    isMutPtrType(scrutineeType) ||
    isRefType(scrutineeType) ||
    isMutRefType(scrutineeType)
  ) {
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
  let hasCaseThatIsNotTerminated = false;
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

      let variableType: EnumType | PtrType | MutPtrType | RefType | MutRefType =
        newEnumType;
      if (ptrOrRefType) {
        if (ptrOrRefType === TypeTag.Ptr) {
          variableType = createPtrType(newEnumType);
        } else if (ptrOrRefType === TypeTag.MutPtr) {
          variableType = createMutPtrType(newEnumType);
        } else if (ptrOrRefType === TypeTag.Ref) {
          variableType = createRefType(newEnumType);
        } else if (ptrOrRefType === TypeTag.MutRef) {
          variableType = createMutRefType(newEnumType);
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
        },
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
        hasCaseThatIsNotTerminated = true;
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
    // For patterns with destructuring like Shape.Circle(r)
    // NOTE: This is no longer supported
    else if (
      exprIsFunctionCall(matchArmExpr) &&
      exprIsFunctionCall(matchArmExpr.func) &&
      exprIsFunctionCallOf(matchArmExpr.func, ".", 1)
    ) {
      throw formatErrorMessage({
        token: matchArmExpr.token,
        errorMessage: `Destructuring enum variant elements is not supported in match expressions.
Please use .variantName for destructuring enum variants,
then destructure the value in the case body expression.`,
      });
    } else {
      throw formatErrorMessage({
        token: matchArmExpr.token,
        errorMessage: `Invalid pattern in match expression: ${exprToString(matchArmExpr)}
Please use .variantName for destructuring enum variants.`,
      });
    }
  }

  if (hasCaseThatIsNotTerminated) {
    if (!resultType) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Could not determine result type for match expression`,
      });
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
    env = mergeAndCheckEnvs(env, bodies);

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

    // For mixed control flows, we need to determine the most restrictive one
    // Priority: return > break/continue (return exits function, break/continue exit loop)
    let finalControlFlow: ControlFlowKind;

    if (controlFlows.includes("return")) {
      finalControlFlow = "return";
    } else if (controlFlows.includes("break")) {
      finalControlFlow = "break";
    } else if (controlFlows.includes("continue")) {
      finalControlFlow = "continue";
    } else {
      finalControlFlow = controlFlows[0] as ControlFlowKind;
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
      if (!context.isEvaluatingWhileLoopBody) {
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
      if (!context.isEvaluatingWhileLoopBody) {
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
    }

    return expr;
  }

  return expr;
}
