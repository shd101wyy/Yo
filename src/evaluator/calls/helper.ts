import { sanitizeForCIdentifier } from "../../codegen/utils";
import {
  addVariableToEnv,
  addWhereClauseConstraintToEnv,
  type Environment,
  findInnermostFrameWithGivenVariable,
  getVariablesFromEnv,
  getVariablesFromEnvByFilter,
  getVariablesNeedingDrop,
  getWhereClauseConstraintsForSomeType,
  pushEnvFrame,
  updateExistingVariable,
  type Variable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  cloneExpr,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  type FnCallExpr,
  type PathCollection,
  requireExprNotConsumed,
  setExprAsConsumed,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { evaluatedBodyContainsAbort } from "../../expr-traversal";
import type {
  FunctionValue,
  SpecializedFunctionCache,
} from "../../function-value";
import { generateExprFromCode } from "../../parser";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createEffectsRowType,
  createExprType,
  createFunctionType,
  createSomeType,
  createUnitType,
} from "../../types/creators";
import type {
  EffectsRowType,
  FunctionImplicitParameter,
  FunctionParameter,
  FunctionType,
  ModuleType,
  SomeType,
  Type,
  TypeHierarchyType,
} from "../../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isEffectsRowType,
  isExprListType,
  isExprType,
  isFunctionType,
  isFunctionTypeGeneric,
  isModuleType,
  isSomeType,
  isTypeHierarchyType,
} from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  getAllSomeTypes,
  isComptimeOnlyType,
  typeContainsSomeType,
  typeRequiresComptimeModifier,
  typeToString,
} from "../../types/utils";
import {
  areValuesEqual,
  createComptimeListValue,
  createExprValue,
  createTypeValue,
  createUnknownValue,
  type ExprValue,
  isFunctionValue,
  isModuleValue,
  isTypeValue,
  isUnknownValue,
  type ModuleValue,
  type Value,
  valueToString,
} from "../../value";
import type {
  ArgValues,
  EvaluatorContext,
  FunctionCallResult,
} from "../context";
import { analyzeEffectCallPoints } from "../effects/effect-analysis";
import type {
  EffectAnalysisResult,
  EffectCallPoint,
  EffectCapturedVariable,
  EffectHandlerInfo,
} from "../effects/effect-analysis-types";
import { _evaluateExpression } from "../exprs/_expr";
import { evaluateBeginExpression } from "../exprs/begin";
import { evaluateExpression } from "../exprs/expr";
import { typeImplementsFn, typeImplementsFuture } from "../trait-checking";
import {
  applyWhereClauseConstraints,
  evaluateFunctionParameterTypeAgain,
  evaluateFunctionReturnTypeAgain,
} from "../types/function";
import { synthesizeTypes } from "../types/synthesizer";
import { evaluateComptimeFunctionCall } from "./comptime-fn";

function moduleTypeContainsCtlField(
  type: ModuleType,
  moduleVal?: ModuleValue
): boolean {
  for (let fi = 0; fi < type.fields.length; fi++) {
    const field = type.fields[fi]!;
    if (isFunctionType(field.type)) {
      const fieldVal = moduleVal?.fields[fi];
      if (fieldVal && isFunctionValue(fieldVal) && fieldVal.isControlFunction)
        return true;
    }
    if (isModuleType(field.type)) {
      const innerModuleVal = moduleVal?.fields[fi];
      if (
        moduleTypeContainsCtlField(
          field.type,
          innerModuleVal && isModuleValue(innerModuleVal)
            ? innerModuleVal
            : undefined
        )
      )
        return true;
    }
  }
  return false;
}

/**
 * Generate ___drop expressions for variables that need cleanup during function calls.
 *
 * This function creates and evaluates ___drop expressions for variables that require
 * cleanup when a function call completes. These expressions are deferred to the codegen phase
 * to prevent use-after-free errors that would occur if drop calls were inserted
 * directly into the AST during evaluation.
 *
 * @param variablesToDrop - Array of variables that need drop calls
 * @param env - The environment to use for evaluation
 * @param context - The evaluator context
 * @returns Object containing the generated drop expressions and updated environment
 */
function generateDeferredDropExpressions({
  variablesToDrop,
  env,
  context,
}: {
  variablesToDrop: Variable[];
  env: Environment;
  context: EvaluatorContext;
}): {
  deferredDropExpressions: Expr[] | undefined;
  env: Environment;
} {
  const deferredDropExpressions: Expr[] = [];
  let finalEnv = env;

  for (const variable of variablesToDrop) {
    // Create a drop expression: ___drop(varName)
    const dropExpr: Expr = generateExprFromCode(
      `${BuiltinFunctions.___drop[0]!}(${variable.name})`
    );

    // Evaluate the dropExpr to ensure it's properly typed and processed
    // Note: We clear expectedType because ___drop returns unit, not whatever the outer context expects
    const evaluatedDropExpr = evaluateExpression({
      expr: dropExpr,
      env: finalEnv,
      context: { ...context, expectedType: undefined },
    });

    deferredDropExpressions.push(evaluatedDropExpr);

    // Update the environment with the evaluated expression's environment
    if (evaluatedDropExpr.$?.env) {
      finalEnv = evaluatedDropExpr.$.env;
    } else {
      throw formatErrorMessage({
        token: dropExpr.token,
        errorMessage: `Failed to evaluate "___drop" expression for variable "${variable.name}":\n${exprToString(
          dropExpr
        )}`,
      });
    }
  }

  return {
    deferredDropExpressions:
      deferredDropExpressions.length > 0 ? deferredDropExpressions : undefined,
    env: finalEnv,
  };
}

export function checkIfFunctionParameterMatchesArgument({
  functionType,
  definitionSiteEnclosingFunctionType,
  parameter,
  argExprs,
  argIndex,
  calleeEnv,
  callerEnv,
  context,
  isMethodCall,
  runtimeArgExprsInOrder,
}: {
  functionType: FunctionType;
  definitionSiteEnclosingFunctionType?: FunctionType;
  /**
   * It could be forallParameters, parameters, or implicitParameters
   */
  parameter: FunctionParameter;
  argExprs: Expr[];
  argIndex: number;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
  isMethodCall: boolean;
  runtimeArgExprsInOrder: Expr[];
}): {
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
  argValue: Value | undefined;
  argType: Type;
  parameterType: Type;
} {
  let argExpr: Expr | undefined = argExprs[argIndex];

  // NOTE: We don't support named argument.
  // But we support to use label for readibility.
  // eg: add(1, 2) vs add(x: 1, y: 2)
  let labelExpr: Expr | undefined = undefined;
  if (
    argExpr &&
    exprIsFunctionCall(argExpr) &&
    exprIsFunctionCallOf(argExpr, ":", 2)
  ) {
    labelExpr = argExpr.args[0]!;
    argExpr = argExpr.args[1]!;

    if (!exprIsAtom(labelExpr)) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Expected identifier for label, got:\n${exprToString(labelExpr)}`,
      });
    }

    const label = labelExpr.token.value;
    if (parameter.label === "") {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Named argument call is not allowed for this parameter (it has no label).`,
      });
    }
    if (parameter.label !== label) {
      throw formatErrorMessage({
        token: labelExpr.token,
        errorMessage: `Named argument is not supported. Label is only used for readibility.
    Expected ${
      parameter ? `label "${parameter.label}"` : `no label`
    } at the argument position, but got "${label}".`,
      });
    }
  }

  // Evaluate the parameter type FIRST - before any argument evaluation
  // This ensures we have the correct parameterType for expectedType in argument evaluation
  const { parameterType, calleeEnv: updatedCalleeEnv } =
    evaluateFunctionParameterTypeAgain({
      functionType,
      definitionSiteEnclosingFunctionType,
      parameter,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
  calleeEnv = updatedCalleeEnv;

  // Evaluate the argExpr
  let evaluatedArgExpr: Expr | undefined = undefined;
  // let evaluatedDefaultValueExpr: Expr | undefined = undefined;

  if (
    !argExpr ||
    (exprIsAtom(argExpr) && exprIsAtomOf(argExpr, BuiltinKeywords.undefined))
  ) {
    // Use the default value
    if (parameter.exprs.defaultValueExpr) {
      evaluatedArgExpr = evaluateExpression({
        expr: cloneExpr(parameter.exprs.defaultValueExpr),
        env: calleeEnv,
        context: {
          ...context,
          expectedType: { type: parameterType, env: calleeEnv },
        },
      });
      if (evaluatedArgExpr.$?.env) {
        calleeEnv = evaluatedArgExpr.$?.env;
      }
      if (argExpr) {
        argExpr.$ = evaluatedArgExpr.$;
      }
      if (!parameter.isCompileTimeOnly) {
        runtimeArgExprsInOrder.push(evaluatedArgExpr);
      }
    } else {
      throw formatErrorMessage({
        token: argExpr?.token ?? PlaceholderToken,
        errorMessage: `Expected default value for parameter "${parameter.label}"`,
      });
    }
  } else {
    // This is for macro function, no need to evaluate the argExpr
    if (parameter.isQuote) {
      if (isExprType(parameterType)) {
        evaluatedArgExpr = cloneExpr(argExpr);
        evaluatedArgExpr.$ = {
          type: createExprType(),
          value: createExprValue(argExpr),
          env: callerEnv,
          pathCollection: [],
        };
      } else {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected "Expr" type for "quote" parameter "${parameter.label}", got:\n${typeToString(
            parameterType
          )}`,
        });
      }
    }
    // This is normal function call parameter
    else {
      evaluatedArgExpr = evaluateExpression({
        expr: argExpr,
        env: callerEnv,
        context: {
          ...context,
          // isEvaluatingExprAsType: false,
          expectedType: { type: parameterType, env: calleeEnv },
        },
      });

      if (evaluatedArgExpr.$?.env) {
        callerEnv = evaluatedArgExpr.$?.env;
      }
      if (!parameter.isCompileTimeOnly) {
        runtimeArgExprsInOrder.push(evaluatedArgExpr);
      }

      // Check if the argument variable has been consumed (moved)
      requireExprNotConsumed(evaluatedArgExpr, callerEnv);

      // If parameter takes ownership, call ___dup on borrowed ARC values
      // and/or mark the argument as consumed at the call site.
      //
      // Move-ownership semantics (Option B):
      // - If the argument already owns the GC value, *move* it into the call: consume it, no dup.
      // - If the argument is only borrowed/non-owning, create an owned temp via ___dup and pass that;
      //   the original binding is still consumed (becomes unusable) to preserve linear/consuming-call semantics.
      if (parameter.isOwningTheRcValue && !parameter.isCompileTimeOnly) {
        const argVarName = evaluatedArgExpr.$?.variableName;
        const argVars = argVarName
          ? getVariablesFromEnv(callerEnv, argVarName)
          : [];
        const argVar = argVars.length ? argVars[argVars.length - 1] : undefined;

        if (argVar?.isOwningTheRcValue) {
          // Argument already owns: move it (no dup), and consume at call site.
          callerEnv = setExprAsConsumed(
            evaluatedArgExpr,
            callerEnv,
            true // NOTE: Allow to consume again here is necessary.
          );
        } else {
          // Argument is borrowed/non-owning: materialize ownership via ___dup and pass the temp.
          // Still consume the original argument binding so it can't be used after the call.
          setExprAsNeedsToCallDup(evaluatedArgExpr, context);
          if (evaluatedArgExpr.$?.env) {
            callerEnv = evaluatedArgExpr.$.env;
          }

          callerEnv = setExprAsConsumed(
            evaluatedArgExpr,
            callerEnv,
            true // NOTE: Allow to consume again here is necessary.
          );
        }
      }
    }
  }

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to evaluate argument expression.`,
    });
  }

  let argType = evaluatedArgExpr.$.type;

  // Cannot assign runtime parameter to comptime parameter
  if (!evaluatedArgExpr.$?.value && parameter.isCompileTimeOnly) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Cannot assign runtime argument to compile-time parameter:\n${
        argExpr ? exprToString(argExpr) : ""
      }`,
    });
  }

  // If the parameter has an assignedValue, check that the argument value matches it.
  // This is used for overload resolution based on value matching (e.g., TryInto(i32) vs TryInto(i64)).
  if (parameter.assignedValue && evaluatedArgExpr.$?.value) {
    if (
      !areValuesEqual(
        { value: parameter.assignedValue, env: calleeEnv },
        { value: evaluatedArgExpr.$.value, env: callerEnv }
      )
    ) {
      throw formatErrorMessage({
        token: argExpr?.token ?? PlaceholderToken,
        errorMessage: `Value mismatch for parameter "${parameter.label}":
Expected: ${valueToString(parameter.assignedValue)}
Got:   ${valueToString(evaluatedArgExpr.$.value)}`,
      });
    }
  }

  // Add the arg to the environment
  // console.log("(10) addVariableToEnv");
  let argValue = evaluatedArgExpr.$.value;
  // Only convert to runtime type if:
  // 1. The parameter doesn't have comptime modifier (it's a runtime parameter), AND
  // 2. The argument type is comptime-only (e.g., comptime_int, Type, etc.)
  // This converts comptime-only argument types to their runtime equivalents.
  // For types that can exist at both compile-time and runtime (like *(i32)),
  // we keep the value intact which allows CTFE with pointers to work correctly.
  if (
    !parameter.isCompileTimeOnly &&
    isComptimeOnlyType(argType, evaluatedArgExpr.$.env)
  ) {
    // During CTFE (forceCompileTimeBindings), preserve the value for compile-time evaluation.
    // Only clear the value for normal runtime calls.
    if (!context.forceCompileTimeBindings) {
      argValue = undefined;
    }

    // argType requires comptime modifier
    // but the parameter is not comptime
    // we need to convert the argType to runtimeType
    argType = convertComptimeTypeToRuntimeType({
      type: argType,
      expectedType: parameterType,
      expr: evaluatedArgExpr,
      env: evaluatedArgExpr.$.env,
    });

    if (typeRequiresComptimeModifier(argType, evaluatedArgExpr.$.env)) {
      // We fail to convert to runtime type
      throw formatErrorMessage({
        token: argExpr?.token ?? PlaceholderToken,
        errorMessage: `Cannot convert compile-time type to runtime type for argument:\n${exprToString(
          evaluatedArgExpr
        )}`,
      });
    }
  }

  // During CTFE (forceCompileTimeBindings), treat parameters as compile-time only
  // so their values are tracked through the function body.
  const isParamCompileTimeOnly =
    parameter.isCompileTimeOnly || context.forceCompileTimeBindings === true;

  const { env: nextEnv } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: parameter.label,
      type: argType, // QUESTION: Should we use parameterType here or argType?
      // This might affect assigning Free type arg to Type parameter
      isCompileTimeOnly: isParamCompileTimeOnly,
      value: argValue ? [argValue] : undefined,
      token: argExpr?.token ?? PlaceholderToken,
      initializedAtToken: argExpr?.token ?? PlaceholderToken,
      consumedAtToken: undefined,
      isOwningTheRcValue: parameter.isOwningTheRcValue,
    },
  });
  calleeEnv = nextEnv;

  // Propagate where-clause constraints for SomeType arguments into callee env
  if (argValue && isTypeValue(argValue) && isSomeType(argValue.value)) {
    const someType = argValue.value;
    const whereConstraints = getWhereClauseConstraintsForSomeType(
      callerEnv,
      someType
    );
    if (whereConstraints) {
      for (const requiredTrait of whereConstraints.requiredTraits) {
        const traitWithReceiver = { ...requiredTrait, receiverType: someType };
        calleeEnv = addWhereClauseConstraintToEnv({
          env: calleeEnv,
          someType,
          traitType: traitWithReceiver,
          isNegated: false,
        });
      }
      for (const negativeTrait of whereConstraints.negativeTraits) {
        const traitWithReceiver = { ...negativeTrait, receiverType: someType };
        calleeEnv = addWhereClauseConstraintToEnv({
          env: calleeEnv,
          someType,
          traitType: traitWithReceiver,
          isNegated: true,
        });
      }
    }
  }

  try {
    // Synthesize the types
    const { expectedEnv } = synthesizeTypes(
      { type: parameterType, env: calleeEnv },
      { type: argType, env: callerEnv }
    );
    calleeEnv = expectedEnv;
    // NOTE: Do NOT update callerEnv with givenEnv!
    // The type bindings from synthesis should not pollute the caller's environment.
    // Only the callee needs to know about the synthesized types.
  } catch (error) {
    // It might cause maximum call stack size exceeded when failed to synthesize types
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to synthesize types for parameter "${parameter.label}":
${(error as Error).message}`,
    });
  }

  // Re-evaluate the parameter type after synthesis to get the resolved type
  const { parameterType: resolvedParameterType, calleeEnv: finalCalleeEnv } =
    evaluateFunctionParameterTypeAgain({
      functionType,
      definitionSiteEnclosingFunctionType,
      parameter,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
  calleeEnv = finalCalleeEnv;

  // Compare the types
  if (
    !areTypesCompatible(
      { type: resolvedParameterType, env: calleeEnv },
      { type: argType, env: callerEnv },
      // It's the receiver:
      argIndex === 0 && isMethodCall
    )
  ) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Type mismatch for parameter "${parameter.label}":
    Expected: ${typeToString(resolvedParameterType)}
    Got:   ${typeToString(argType)}`,
    });
  }
  return {
    calleeEnv,
    callerEnv,
    context: { ...context },
    argValue,
    argType,
    parameterType: resolvedParameterType,
  };
}

/**
 * Helper function to extract FunctionValue from a Value
 * Note: Closures are runtime-only values, so we can't extract FunctionValue from them at compile time
 */
export function extractFunctionValue(
  value: Value | undefined
): FunctionValue | undefined {
  if (!value) {
    return undefined;
  }
  if (isFunctionValue(value)) {
    return value;
  }
  // Closures are runtime-only, no FunctionValue available at compile time
  return undefined;
}

/**
 * NOTE: This function will push new frame to the function env,
 * but will not pop frame.
 */
export function tryToCallFunctionWithArguments({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  expr,
  functionValue,
  functionType,
  functionCalleeExpr,
  argExprs,
  callerEnv,
  context,
  isMethodCall,
  skipSpecialization,
  skipCtfeExecution,
}: {
  functionValue?: FunctionValue;
  functionType: FunctionType;
  expr?: Expr;
  functionCalleeExpr?: Expr;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
  isMethodCall: boolean;
  /**
   * If true, skip function specialization. This is used during the "checking phase"
   * where we try function calls with cloned expressions to see if parameters match,
   * but don't actually want to create cached specialized functions.
   * See docs/SPECIALIZATION_CACHE_PITFALL.md for details.
   */
  skipSpecialization?: boolean;
  /**
   * If true, skip CTFE execution during the "checking phase".
   * We only verify types match, but don't actually execute compile-time functions.
   * This prevents double execution when checking and then calling.
   */
  skipCtfeExecution?: boolean;
}): FunctionCallResult {
  if (functionValue) {
    // Use the specializedType if available (e.g., from generic impls)
    // Only fall back to functionValue.type if specializedType exists
    // Otherwise, keep the passed-in functionType which may already be specialized
    // (e.g., when method is looked up from a concrete receiver type)
    if (functionValue.specializedType) {
      functionType = functionValue.specializedType;
    } else {
      // Because it might be an anonymous function
      // the parameter names are different from the function type that it's implementing
      // We need to use the functionValue.type to get the correct parameter names
      // so that the function body can reference them correctly.
      functionType = functionValue.type;
    }
  }

  let forallArgsExpr: FnCallExpr | undefined = undefined;

  const forallArgValues: {
    value: Value;
    parameterType: Type;
    argType: Type;
  }[] = [];
  const argValues: {
    value: Value | undefined;
    parameterType: Type;
    argType: Type;
  }[] = [];

  const runtimeArgExprsInOrder: Expr[] = [];
  const definitionSiteEnclosingFunctionType =
    functionValue?.definitionSiteEnclosingFunctionType;

  // Check if there is `forall(...)` argument.
  // If yes, then it should be the first argument
  let regularArgStartIndex = 0;
  if (
    argExprs.length > 0 &&
    exprIsFunctionCall(argExprs[0]!) &&
    exprIsFunctionCallOf(argExprs[0]!, BuiltinKeywords.forall)
  ) {
    forallArgsExpr = argExprs[0]! as FnCallExpr;
    regularArgStartIndex = 1;
  }

  // Split arguments: detect using(...) args for implicit parameters
  let usingArgsExpr: FnCallExpr | undefined = undefined;
  let adjustedArgExprs = argExprs.slice(regularArgStartIndex);

  // Check if any argument is using(...) — it provides explicit values for implicit parameters
  // Only one using() is allowed at the call site.
  const usingArgIndex = adjustedArgExprs.findIndex(
    (arg) =>
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, BuiltinKeywords.using)
  );
  if (usingArgIndex !== -1) {
    // Verify there's only one using() at the call site
    const secondUsingIndex = adjustedArgExprs.findIndex(
      (arg, idx) =>
        idx > usingArgIndex &&
        exprIsFunctionCall(arg) &&
        exprIsFunctionCallOf(arg, BuiltinKeywords.using)
    );
    if (secondUsingIndex !== -1) {
      throw formatErrorMessage({
        token: adjustedArgExprs[secondUsingIndex]!.token,
        errorMessage: `Only one "using(...)" is allowed per function call. Combine all implicit arguments into a single using(), e.g.: func(..., using(a, b))`,
      });
    }
    usingArgsExpr = adjustedArgExprs[usingArgIndex]! as FnCallExpr;
    // Remove the using(...) arg from the regular args
    adjustedArgExprs = [
      ...adjustedArgExprs.slice(0, usingArgIndex),
      ...adjustedArgExprs.slice(usingArgIndex + 1),
    ];
  }

  // Split arguments into regular and implicit
  // Regular parameters come first, implicit parameters come after
  const regularArgCount = functionType.parameters.length;

  // Check argument count BEFORE slicing - this ensures we catch too many/few args
  const regularArgsToCheck = adjustedArgExprs;
  if (!functionType.variadicParameter) {
    if (regularArgsToCheck.length > regularArgCount) {
      // Check if the last function parameter is quote with ExprList
      // If not then we throw error
      const lastParameter = functionType.parameters.at(-1);
      if (
        lastParameter &&
        lastParameter.isQuote &&
        isExprListType(lastParameter.type)
      ) {
        // Allowed to have more args here
      } else {
        throw formatErrorMessage({
          token: functionCalleeExpr?.token ?? PlaceholderToken,
          errorMessage: `Too many arguments for function call:
Expected: ${regularArgCount} arguments
Got:   ${regularArgsToCheck.length} arguments`,
        });
      }
    } else if (regularArgsToCheck.length < regularArgCount) {
      // Check if missing parameters have default values
      const hasDefaultsForMissing = functionType.parameters
        .slice(regularArgsToCheck.length)
        .every((param) => param.exprs.defaultValueExpr !== undefined);
      if (!hasDefaultsForMissing) {
        throw formatErrorMessage({
          token: functionCalleeExpr?.token ?? PlaceholderToken,
          errorMessage: `Too few arguments for function call:
Expected: ${regularArgCount} arguments
Got:   ${regularArgsToCheck.length} arguments`,
        });
      }
    }
  }

  const regularArgExprs = adjustedArgExprs.slice(0, regularArgCount);
  const variadicArgExprs = adjustedArgExprs.slice(regularArgCount);

  // Replace argExprs with just regular args for the rest of the function
  argExprs = regularArgExprs;

  // Push new frame to env
  callerEnv = pushEnvFrame(callerEnv);
  // Push new frame to function env
  let calleeEnv = pushEnvFrame(functionType.env);

  if (functionType.SelfType) {
    const typeValue = createTypeValue(functionType.SelfType);

    // Add "Self" to the calleeEnv
    // console.log("(11) addVariableToEnv");
    const { env: nextEnv } = addVariableToEnv({
      env: calleeEnv,
      variable: {
        name: "Self",
        token: PlaceholderToken,
        type: typeValue.type,
        isCompileTimeOnly: true,
        initializedAtToken: PlaceholderToken, // Set as initialized
        consumedAtToken: undefined,
        value: [typeValue],
        isOwningTheRcValue: false,
      },
      // Allow shadowing if Self was already bound in specialized function env
      allowVariableShadowing: true,
    });
    calleeEnv = nextEnv;
  }

  for (let i = 0; i < functionType.forallParameters.length; i++) {
    // Add forallParameter to calleeEnv
    const forallParameter = functionType.forallParameters[i]!;
    let typeParameterVariable: Variable | undefined = undefined;
    // NOTE: No need to add forallParameter to env
    //       It will cause the variable shadowing problem.
    if (forallParameter.exprs.labelExpr && forallParameter.label) {
      // console.log("(12) addVariableToEnv");
      const { env: nextEnv, variable } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: forallParameter.label,
          type: forallParameter.type,
          isCompileTimeOnly: true,
          value: [
            createUnknownValue(forallParameter.type, {
              variableName: forallParameter.label,
              env: calleeEnv,
              context,
            }),
          ],
          token: forallParameter.exprs.labelExpr.token,
          initializedAtToken: forallParameter.exprs.labelExpr.token, // Set as initialized
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      calleeEnv = nextEnv;
      typeParameterVariable = variable;
    }

    if (forallArgsExpr) {
      let forallArgExpr: Expr | undefined = forallArgsExpr.args[i];
      let labelExpr: Expr | undefined = undefined;

      // Check if it's calling the named argument
      if (
        exprIsFunctionCall(forallArgExpr) &&
        exprIsFunctionCallOf(forallArgExpr, ":", 2)
      ) {
        labelExpr = forallArgExpr.args[0]!;
        forallArgExpr = forallArgExpr.args[1]!;

        // Check if the label is valid
        if (!exprIsAtom(labelExpr)) {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected identifier for type parameter label, got:\n${exprToString(labelExpr)}`,
          });
        }

        // Check if the label matches the type parameter label
        if (forallParameter.label !== labelExpr.token.value) {
          throw formatErrorMessage({
            token: labelExpr.token,
            errorMessage: `Expected type parameter label "${forallParameter.label}", got "${labelExpr.token.value}".`,
          });
        }
      }

      // Check if it's undefined
      let typeValue: Value;
      // Check if it's '_'
      if (exprIsAtom(forallArgExpr) && forallArgExpr.token.value === "_") {
        // _ is a special case, it means to use the inferred type
        // So we don't need to check the type
        continue;
      }
      // Check the default value
      else if (
        !forallArgExpr ||
        (exprIsAtom(forallArgExpr) &&
          exprIsAtomOf(forallArgExpr, BuiltinKeywords.undefined))
      ) {
        // Check if forallParameter has default value
        if (forallParameter.exprs.defaultValueExpr) {
          const evaluatedArgExpr = evaluateExpression({
            expr: cloneExpr(forallParameter.exprs.defaultValueExpr),
            env: calleeEnv,
            context: {
              ...context,
            },
          });
          if (evaluatedArgExpr.$?.env) {
            callerEnv = evaluatedArgExpr.$.env;
          }
          if (forallArgExpr) {
            forallArgExpr.$ = evaluatedArgExpr.$;
          }

          if (!isTypeValue(evaluatedArgExpr.$?.value)) {
            throw formatErrorMessage({
              token:
                forallArgExpr?.token ??
                functionCalleeExpr?.token ??
                PlaceholderToken,
              errorMessage: forallArgExpr
                ? `Expected type for default value, got:\n${exprToString(forallArgExpr)}`
                : `Expected type for default value.`,
            });
          }
          typeValue = evaluatedArgExpr.$?.value;
        } else {
          throw formatErrorMessage({
            token:
              forallArgExpr?.token ??
              functionCalleeExpr?.token ??
              PlaceholderToken,
            errorMessage: `Type parameter does not have default value.`,
          });
        }
      } else {
        // Evaluate forallArgExpr
        const evaluatedTypeExpr = evaluateExpression({
          expr: forallArgExpr,
          env: callerEnv,
          context: {
            ...context,
            expectedType: { type: forallParameter.type, env: calleeEnv },
          },
        });
        if (evaluatedTypeExpr.$?.env) {
          callerEnv = evaluatedTypeExpr.$.env;
        }
        if (!isTypeValue(evaluatedTypeExpr.$?.value)) {
          throw formatErrorMessage({
            token: forallArgExpr.token,
            errorMessage: `Expected type for argument, got:\n${exprToString(forallArgExpr)}`,
          });
        }
        typeValue = evaluatedTypeExpr.$?.value;
      }

      if (labelExpr) {
        labelExpr.$ = {
          env: calleeEnv, // QUESTION: Which env should we use?
          type: typeValue.type,
          value: typeValue,
          pathCollection: [],
        };
      }

      // Evaluate the forall parameter type first (like we do for regular and implicit parameters)
      const {
        parameterType: evaluatedForallParameterType,
        calleeEnv: updatedCalleeEnv,
      } = evaluateFunctionParameterTypeAgain({
        parameter: forallParameter,
        calleeEnv,
        definitionSiteEnclosingFunctionType,
        context: {
          ...context,
          isEvaluatingFunctionType: true,
        },
        functionType,
      });
      calleeEnv = updatedCalleeEnv;

      // Synthesize the types
      const { expectedEnv, givenEnv } = synthesizeTypes(
        { type: evaluatedForallParameterType, env: calleeEnv },
        { type: typeValue.type, env: callerEnv }
      );
      calleeEnv = expectedEnv;
      callerEnv = givenEnv;

      // Compare the types
      if (
        !areTypesCompatible(
          { type: evaluatedForallParameterType, env: calleeEnv },
          { type: typeValue.type, env: callerEnv }
        )
      ) {
        throw formatErrorMessage({
          token:
            forallArgExpr?.token ??
            functionCalleeExpr?.token ??
            PlaceholderToken,
          errorMessage: `Type mismatch for type parameter "${forallParameter.label}":
Expected: ${typeToString(evaluatedForallParameterType)}
Got:   ${typeToString(typeValue.type)}`,
        });
      }

      // Add the type to the env
      if (forallParameter.label) {
        // console.log("(13) addVariableToEnv");
        if (typeParameterVariable) {
          calleeEnv = updateExistingVariable(calleeEnv, typeParameterVariable, {
            ...typeParameterVariable,
            value: [typeValue],
          });
        } else {
          const token =
            forallArgExpr?.token ??
            functionCalleeExpr?.token ??
            PlaceholderToken;
          const { env: nextEnv } = addVariableToEnv({
            env: calleeEnv,
            variable: {
              name: forallParameter.label,
              type: typeValue.type,
              isCompileTimeOnly: true,
              value: [typeValue],
              token: token,
              initializedAtToken: token, // Set as initialized
              consumedAtToken: undefined,
              isOwningTheRcValue: false,
            },
          });
          calleeEnv = nextEnv;
        }
      }

      // Save to forallArgValues
      forallArgValues.push({
        value: typeValue,
        argType: typeValue.type,
        parameterType: evaluatedForallParameterType,
      });
    }
  }

  // If we have an expected return type and forall parameters without explicit arguments,
  // try to do early synthesis to resolve forall parameters before processing regular arguments.
  // This is necessary when parameter types reference forall parameters (e.g., value : V in box).
  // Skip for macro functions (isUnquote return type) as the actual return type is determined after expansion.
  if (
    context.expectedType &&
    !forallArgsExpr &&
    functionType.forallParameters.length > 0 &&
    !functionType.return.isUnquote
  ) {
    try {
      const { returnType: tempReturnType, calleeEnv: tempCalleeEnv } =
        evaluateFunctionReturnTypeAgain({
          functionType,
          calleeEnv,
          context: { ...context, isEvaluatingFunctionType: true },
          functionCalleeExpr,
        });

      const { expectedEnv } = synthesizeTypes(
        { type: tempReturnType, env: tempCalleeEnv },
        { type: context.expectedType.type, env: context.expectedType.env }
      );
      calleeEnv = expectedEnv;
    } catch {
      // Silently ignore errors - synthesis will happen again later after arguments
    }
  }

  // Early effect row resolution: when the function has effect row spread implicit
  // parameters (e.g., using(...(E))) and the call site provides using(...) args,
  // resolve the effect rows BEFORE processing regular arguments. This is necessary
  // because regular parameters (e.g., callback : Impl(Fn(v: i32, using(...(E))) -> unit))
  // may reference the effect row variable E, and evaluateFunctionParameterTypeAgain
  // needs E to be bound in calleeEnv to produce the correct expected type.
  if (usingArgsExpr && functionType.implicitParameters.length > 0) {
    const hasEffectRowSpread = functionType.implicitParameters.some(
      (p) => p.isEffectRowSpread
    );
    if (hasEffectRowSpread) {
      // Count non-spread implicit params to figure out which using args go to spreads
      const nonSpreadParams = functionType.implicitParameters.filter(
        (p) => !p.isEffectRowSpread
      );
      const nonSpreadCount = nonSpreadParams.length;

      // The first nonSpreadCount using args correspond to named implicit params;
      // remaining args go to the effect row spread(s).
      const spreadArgs = usingArgsExpr.args.slice(nonSpreadCount);

      if (spreadArgs.length > 0) {
        // Resolve each spread arg's type from callerEnv via variable lookup
        const concreteImplicitParams: FunctionImplicitParameter[] = [];
        for (const spreadArgExpr of spreadArgs) {
          if (!exprIsAtom(spreadArgExpr)) {
            throw formatErrorMessage({
              token: spreadArgExpr.token,
              errorMessage: `Expected identifier for using() argument in effect row spread, got ${exprToString(spreadArgExpr)}`,
            });
          }
          const argName = spreadArgExpr.token.value;
          const outerVariables = getVariablesFromEnv(callerEnv, argName);
          const outerVar = outerVariables.at(-1);
          if (!outerVar) {
            throw formatErrorMessage({
              token: spreadArgExpr.token,
              errorMessage: `Variable "${argName}" not found for using() argument in effect row spread.`,
            });
          }
          concreteImplicitParams.push({
            label: argName,
            type: outerVar.type,
            isCompileTimeOnly: true,
            isImplicit: true,
            isOwningTheRcValue: false,
            isQuote: false,
            exprs: {
              expr: spreadArgExpr,
              labelExpr: spreadArgExpr,
              typeExpr: undefined as unknown as Expr,
              defaultValueExpr: undefined,
            },
          });
        }

        // Create EffectsRowType and bind it to each effect row spread variable in calleeEnv
        const effectsRow = createEffectsRowType(concreteImplicitParams);
        const effectsRowTypeValue = createTypeValue(effectsRow);

        for (const implicitParam of functionType.implicitParameters) {
          if (!implicitParam.isEffectRowSpread) continue;
          const rowVarName = implicitParam.label;
          const variables = getVariablesFromEnv(calleeEnv, rowVarName);
          const variable = variables.at(-1);
          if (variable) {
            calleeEnv = updateExistingVariable(calleeEnv, variable, {
              ...variable,
              value: [effectsRowTypeValue],
            });
          }
          // Also set resolvedConcreteType on the SomeType if applicable
          if (
            isSomeType(implicitParam.type) &&
            implicitParam.type.isEffectsRow
          ) {
            (implicitParam.type as SomeType).resolvedConcreteType = effectsRow;
          }
        }
      }
    }
  }

  // If this is an io.async call, set context flag so the closure argument
  // is evaluated with async-block context (allowing `await` inside).
  if (functionType.ioBuiltin === "io_async") {
    context = { ...context, isInsideIoAsyncCall: true };
  }

  // Check if the regular parameters match the arguments
  const parametersToProcess = functionType.parameters.length;

  for (let argIndex = 0; argIndex < parametersToProcess; argIndex++) {
    const parameter = functionType.parameters[argIndex]!;
    const {
      calleeEnv: nextCalleeEnv,
      callerEnv: nextCallerEnv,
      context: nextContext,
      argValue,
      argType,
      parameterType: newParameterType,
    } = checkIfFunctionParameterMatchesArgument({
      functionType,
      definitionSiteEnclosingFunctionType,
      parameter,
      argExprs,
      argIndex: argIndex,
      callerEnv,
      calleeEnv,
      context,
      isMethodCall,
      runtimeArgExprsInOrder,
    });
    calleeEnv = nextCalleeEnv;
    callerEnv = nextCallerEnv;
    context = nextContext;

    argValues.push({
      value: argValue,
      parameterType: newParameterType,
      argType,
    });
  }

  // After processing regular arguments, propagate resolvedConcreteType from forall SomeTypes
  // back to the calleeEnv. This handles the case where closure evaluation resolves
  // type parameters (e.g., T = i32) via resolvedConcreteType on the SomeType objects,
  // but the calleeEnv variable bindings still point to the SomeType.
  // Without this, evaluateFunctionReturnTypeAgain would re-evaluate the return type
  // and still see T as SomeType instead of i32.
  if (!forallArgsExpr && functionType.forallParameters.length > 0) {
    for (const forallParameter of functionType.forallParameters) {
      if (forallParameter.label) {
        const variables = getVariablesFromEnv(calleeEnv, forallParameter.label);
        const variable = variables.at(-1);
        if (variable?.value?.[0] && isTypeValue(variable.value[0])) {
          const typeVal = variable.value[0];
          if (
            isSomeType(typeVal.value) &&
            typeVal.value.resolvedConcreteType &&
            (!typeVal.value.requiredTraits ||
              typeVal.value.requiredTraits.length === 0)
          ) {
            const concreteTypeValue = createTypeValue(
              typeVal.value.resolvedConcreteType
            );
            calleeEnv = updateExistingVariable(calleeEnv, variable, {
              ...variable,
              value: [concreteTypeValue],
            });
          }
        }
      }
    }
  }

  // If forall arguments were not explicitly provided (i.e., forallArgsExpr is undefined),
  // we need to extract the inferred type parameter values from calleeEnv after
  // argument type checking has resolved them via synthesizeTypes.
  if (!forallArgsExpr && functionType.forallParameters.length > 0) {
    for (const forallParameter of functionType.forallParameters) {
      if (forallParameter.label) {
        const variables = getVariablesFromEnv(calleeEnv, forallParameter.label);
        const variable = variables.at(-1);
        if (variable?.value?.[0] && isTypeValue(variable.value[0])) {
          forallArgValues.push({
            value: variable.value[0],
            argType: variable.value[0].type,
            parameterType: forallParameter.type,
          });
        }
      }
    }
  }

  // Re-apply where-clause constraints for this function call now that
  // parameters are bound in calleeEnv (needed for return type resolution).
  if (functionType.whereClauseExprs?.length) {
    const constraintExprs = functionType.whereClauseExprs.map((_expr) =>
      cloneExpr(_expr)
    );
    const result = applyWhereClauseConstraints({
      constraintExprs,
      env: calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
    });
    calleeEnv = result.env;
  }

  // NOTE: We should handle the returnType before the implicit arguments
  // Evaluate the function return type again
  let {
    returnType,
    // eslint-disable-next-line prefer-const
    calleeEnv: nextCalleeEnv,
  } = evaluateFunctionReturnTypeAgain({
    functionType,
    calleeEnv,
    context: {
      ...context,
      isEvaluatingFunctionType: true,
    },
    functionCalleeExpr,
  });

  calleeEnv = nextCalleeEnv;

  // Synthesize the returnType if context.expectedType is giving
  // The context.expectedType is the expected function return type.
  // Skip synthesis for macro functions (isUnquote return type) because the actual
  // return type will be determined after macro expansion.
  if (context.expectedType && !functionType.return.isUnquote) {
    const { expectedEnv } = synthesizeTypes(
      { type: returnType, env: calleeEnv },
      { type: context.expectedType.type, env: context.expectedType.env }
    );
    calleeEnv = expectedEnv;

    // Evaluate the function return type again after synthesizing
    // This is to ensure that any SomeType in the returnType is properly resolved
    const evalReturnTypeResult = evaluateFunctionReturnTypeAgain({
      functionType,
      calleeEnv,
      context: {
        ...context,
        isEvaluatingFunctionType: true,
      },
      functionCalleeExpr,
    });
    returnType = evalReturnTypeResult.returnType;
    calleeEnv = evalReturnTypeResult.calleeEnv;

    if (
      areTypesCompatible(
        { type: context.expectedType.type, env: context.expectedType.env },
        { type: returnType, env: calleeEnv }
      )
    ) {
      returnType = context.expectedType.type;
    } else {
      // QUESTION: Should we throw error here?
      // ANSWER: It seems like if we throw error here, then some code examples will be broken. I am not sure why
      //       throw formatErrorMessage({
      //         token: expr?.token ?? functionCalleeExpr?.token ?? PlaceholderToken,
      //         errorMessage: `Function return type mismatch:
      // Expected: ${typeToString(context.expectedType.type)}
      // Got:   ${typeToString(returnType)}`,
      //       });
    }
  }

  // Check the variadic parameters
  const variadicArgs: { value: Value | undefined; argType: Type }[] = [];
  if (functionType.variadicParameter) {
    for (let i = 0; i < variadicArgExprs.length; i++) {
      const argExpr = variadicArgExprs[i]!;
      let evaluatedArgExpr: Expr;
      if (functionType.variadicParameter.isQuote) {
        // Macro
        evaluatedArgExpr = cloneExpr(argExpr);
        evaluatedArgExpr.$ = {
          type: createExprType(),
          value: createExprValue(argExpr),
          env: callerEnv,
          pathCollection: [],
        };
        variadicArgs.push({
          value: evaluatedArgExpr.$.value,
          argType: evaluatedArgExpr.$.type,
        });
      } else {
        // Evaluate the argument expression
        evaluatedArgExpr = evaluateExpression({
          expr: argExpr,
          env: callerEnv,
          context: {
            ...context,
          },
        });
        if (!evaluatedArgExpr.$?.env) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Failed to evaluate the expression:\n${exprToString(argExpr)}`,
          });
        }
        callerEnv = evaluatedArgExpr.$.env;
        variadicArgs.push({
          value: evaluatedArgExpr.$.value,
          argType: evaluatedArgExpr.$.type,
        });

        if (!functionType.variadicParameter.isCompileTimeOnly) {
          // TODO: For VarList type, we should add arg_count as parameter
          runtimeArgExprsInOrder.push(argExpr);
        }
      }
    }

    if (functionType.variadicParameter.label === "...") {
      // Do nothing
    } else if (functionType.variadicParameter.isQuote) {
      // Create the ExprList and add that to environment
      const exprListValue = createComptimeListValue(
        createExprType(),
        variadicArgs.map((arg) => arg.value as ExprValue)
      );

      // Add to env
      const { env: nextEnv } = addVariableToEnv({
        env: calleeEnv,
        variable: {
          name: functionType.variadicParameter.label,
          type: exprListValue.type, // QUESTION: Should we use parameterType here or argType?
          // This might affect assigning Free type arg to Type parameter
          isCompileTimeOnly: functionType.variadicParameter.isCompileTimeOnly,
          value: [exprListValue],
          token: functionType.variadicParameter.exprs.expr.token,
          initializedAtToken: functionType.variadicParameter.exprs.expr.token,
          consumedAtToken: undefined,
          isOwningTheRcValue: false,
        },
      });
      calleeEnv = nextEnv;
    }
  }

  // if (exprToString(functionType.return.typeExpr) === "Wrapper2(A)") {
  //   console.log("before Wrapper2(A): ");
  //   printEnvVarNames(calleeEnv);
  // }

  // console.log("\nFunction call: ", exprToString(expr));
  // console.log("- return expr: ", exprToString(functionType.return.typeExpr));
  // console.log(
  //   "- SelfType:",
  //   context.SelfType ? typeToString(context.SelfType) : undefined
  // );
  // console.log(
  //   "- functionValue?.SelfType:",
  //   functionValue?.SelfType ? typeToString(functionValue.SelfType) : undefined
  // );

  const pathCollection: PathCollection = [];

  // Resolve implicit parameters (using() params in function type)
  const implicitArgValues: {
    value: Value;
    parameterType: Type;
    argType: Type;
  }[] = [];
  if (functionType.implicitParameters.length > 0) {
    for (let i = 0; i < functionType.implicitParameters.length; i++) {
      const implicitParam = functionType.implicitParameters[i]!;
      let resolved = false;

      // Handle effect row spread: ...(E) or bare ...
      if (implicitParam.isEffectRowSpread) {
        // Determine the concrete implicit params from the bound effect row variable
        let concreteParams: FunctionImplicitParameter[] = [];

        // Named spread ...(E): look up E's bound EffectsRowType in calleeEnv
        const eVariables = getVariablesFromEnv(calleeEnv, implicitParam.label);
        const eVarValue = eVariables.at(-1)?.value?.[0];
        let effectsRowType: EffectsRowType | undefined;
        if (
          eVarValue &&
          isTypeValue(eVarValue) &&
          isEffectsRowType(eVarValue.value)
        ) {
          effectsRowType = eVarValue.value;
        } else if (
          isSomeType(implicitParam.type) &&
          implicitParam.type.isEffectsRow
        ) {
          // Try via SomeType lookup
          const boundType = getValueOfSomeTypeFromEnv(
            calleeEnv,
            implicitParam.type as SomeType
          );
          if (isEffectsRowType(boundType)) {
            effectsRowType = boundType;
          }
        } else if (isEffectsRowType(implicitParam.type)) {
          // Already resolved during re-evaluation
          effectsRowType = implicitParam.type;
        }
        concreteParams = effectsRowType?.implicitParameters ?? [];

        // For each concrete param, resolve from callerEnv (same as named implicit params)
        for (const concreteParam of concreteParams) {
          const {
            parameterType: resolvedConcreteType,
            calleeEnv: nextCalleeEnv__,
          } = evaluateFunctionParameterTypeAgain({
            parameter: concreteParam,
            calleeEnv,
            definitionSiteEnclosingFunctionType,
            context: {
              ...context,
              isEvaluatingFunctionType: true,
            },
            functionType,
          });
          calleeEnv = nextCalleeEnv__;

          // Search for matching given variable in callerEnv
          const givenVariables = getVariablesFromEnvByFilter(
            callerEnv,
            (v) =>
              v.isImplicit === true &&
              v.isCompileTimeOnly === true &&
              v.name === concreteParam.label &&
              areTypesCompatible(
                { type: resolvedConcreteType, env: calleeEnv },
                { type: v.type, env: callerEnv }
              )
          );

          const givenVar = givenVariables.at(-1);
          if (!givenVar?.value?.[0]) {
            // Also try by type only (name might differ)
            const givenByType = getVariablesFromEnvByFilter(
              callerEnv,
              (v) =>
                v.isImplicit === true &&
                v.isCompileTimeOnly === true &&
                areTypesCompatible(
                  { type: resolvedConcreteType, env: calleeEnv },
                  { type: v.type, env: callerEnv }
                )
            );
            const byTypeVar = givenByType.at(-1);
            if (!byTypeVar?.value?.[0]) {
              throw formatErrorMessage({
                token:
                  functionCalleeExpr?.token ?? expr?.token ?? PlaceholderToken,
                errorMessage: `No "given" variable found for effect row parameter "${concreteParam.label}" of type ${typeToString(resolvedConcreteType)} (expanded from effect row ...(${implicitParam.label})).
Please ensure a given variable of matching type is in scope.`,
              });
            }
            const givenValue = byTypeVar.value[0];
            implicitArgValues.push({
              value: givenValue,
              parameterType: resolvedConcreteType,
              argType: byTypeVar.type,
            });
            const { env: nextEnv } = addVariableToEnv({
              env: calleeEnv,
              variable: {
                name: concreteParam.label,
                type: resolvedConcreteType,
                isCompileTimeOnly: true,
                isImplicit: true,
                value: [givenValue],
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheRcValue: false,
              },
              allowVariableShadowing: true,
            });
            calleeEnv = nextEnv;
          } else {
            const givenValue = givenVar.value[0];
            implicitArgValues.push({
              value: givenValue,
              parameterType: resolvedConcreteType,
              argType: givenVar.type,
            });
            const { env: nextEnv } = addVariableToEnv({
              env: calleeEnv,
              variable: {
                name: concreteParam.label,
                type: resolvedConcreteType,
                isCompileTimeOnly: true,
                isImplicit: true,
                value: [givenValue],
                token: PlaceholderToken,
                initializedAtToken: PlaceholderToken,
                consumedAtToken: undefined,
                isOwningTheRcValue: false,
              },
              allowVariableShadowing: true,
            });
            calleeEnv = nextEnv;
          }
        }
        continue; // Spread handled
      }

      // Re-evaluate the implicit parameter type in the current calleeEnv.
      // This is necessary because implicit parameter types may reference SomeTypes
      // (e.g., forall type variables like T) that have been resolved during regular
      // argument processing. Without this, the type would still contain unresolved
      // SomeTypes and type compatibility checks would fail.
      const { parameterType: resolvedImplicitType, calleeEnv: nextCalleeEnv_ } =
        evaluateFunctionParameterTypeAgain({
          parameter: implicitParam,
          calleeEnv,
          definitionSiteEnclosingFunctionType,
          context: {
            ...context,
            isEvaluatingFunctionType: true,
          },
          functionType,
        });
      calleeEnv = nextCalleeEnv_;

      // First, check if there's an explicit using(...) arg at the call site
      if (usingArgsExpr) {
        const usingArgExpr = usingArgsExpr.args[i];
        // using(undefined) means "skip explicit, use given variable lookup"
        const isUsingUndefined =
          usingArgExpr &&
          exprIsAtom(usingArgExpr) &&
          exprIsAtomOf(usingArgExpr, BuiltinKeywords.undefined);
        if (usingArgExpr && !isUsingUndefined) {
          // Evaluate the explicit using arg
          const evaluatedUsingArg = evaluateExpression({
            expr: usingArgExpr,
            env: callerEnv,
            context: { ...context },
          });
          if (!evaluatedUsingArg.$) {
            throw formatErrorMessage({
              token: usingArgExpr.token,
              errorMessage: `Failed to evaluate using() argument: ${exprToString(usingArgExpr)}`,
            });
          }
          callerEnv = evaluatedUsingArg.$.env;
          const argValue = evaluatedUsingArg.$.value;
          const argType = evaluatedUsingArg.$.type;

          if (!argValue) {
            throw formatErrorMessage({
              token: usingArgExpr.token,
              errorMessage: `Expected compile-time value for using() argument, got runtime value: ${exprToString(usingArgExpr)}`,
            });
          }

          // Check type compatibility
          if (
            !areTypesCompatible(
              { type: resolvedImplicitType, env: calleeEnv },
              { type: argType, env: callerEnv }
            )
          ) {
            throw formatErrorMessage({
              token: usingArgExpr.token,
              errorMessage: `Incompatible type for implicit parameter "${implicitParam.label}":
Expected: ${typeToString(resolvedImplicitType)}
Got:      ${typeToString(argType)}`,
            });
          }

          implicitArgValues.push({
            value: argValue,
            parameterType: resolvedImplicitType,
            argType,
          });

          // Add implicit arg to calleeEnv (mark as isImplicit so it can be
          // found by nested using() parameter resolution)
          const { env: nextEnv } = addVariableToEnv({
            env: calleeEnv,
            variable: {
              name: implicitParam.label,
              type: resolvedImplicitType,
              isCompileTimeOnly: true,
              isImplicit: true,
              value: [argValue],
              token: implicitParam.exprs.labelExpr?.token ?? PlaceholderToken,
              initializedAtToken:
                implicitParam.exprs.labelExpr?.token ?? PlaceholderToken,
              consumedAtToken: undefined,
              isOwningTheRcValue: false,
            },
            allowVariableShadowing: true,
          });
          calleeEnv = nextEnv;
          resolved = true;
        }
      }

      // If not explicitly provided, search caller env for given variables
      if (!resolved) {
        const givenVariables = getVariablesFromEnvByFilter(
          callerEnv,
          (v) =>
            v.isImplicit === true &&
            v.isCompileTimeOnly === true &&
            areTypesCompatible(
              { type: resolvedImplicitType, env: calleeEnv },
              { type: v.type, env: callerEnv }
            )
        );

        if (givenVariables.length === 0) {
          throw formatErrorMessage({
            token: functionCalleeExpr?.token ?? expr?.token ?? PlaceholderToken,
            errorMessage: `No "given" variable found for implicit parameter "${implicitParam.label}" of type ${typeToString(resolvedImplicitType)}.
Please declare a given variable with a compatible type, e.g.:
  given(${implicitParam.label}) := <value>;
Or pass it explicitly:
  ${functionValue?.funcName ?? "func"}(..., using(<value>))`,
          });
        }

        // When multiple given variables match, prefer the one from the innermost
        // (most recent) frame. Only report ambiguity if there are multiple matches
        // at the same innermost frame level. This allows inner scopes to shadow
        // outer given bindings of the same type.
        let candidates = givenVariables;
        if (candidates.length > 1) {
          // getVariablesFromEnvByFilter returns variables in frame order
          // (outer first, inner last). Find the innermost frame that has matches
          // by searching from the end.
          const innermostFrameIdx = findInnermostFrameWithGivenVariable(
            callerEnv,
            (v) =>
              v.isImplicit === true &&
              v.isCompileTimeOnly === true &&
              areTypesCompatible(
                { type: resolvedImplicitType, env: calleeEnv },
                { type: v.type, env: callerEnv }
              )
          );
          if (innermostFrameIdx >= 0) {
            const frame = callerEnv.frames[innermostFrameIdx]!;
            const innermostMatches = frame.variables.filter(
              (v) =>
                v.isImplicit === true &&
                v.isCompileTimeOnly === true &&
                areTypesCompatible(
                  { type: resolvedImplicitType, env: calleeEnv },
                  { type: v.type, env: callerEnv }
                )
            );
            if (innermostMatches.length > 0) {
              candidates = innermostMatches;
            }
          }
        }

        if (candidates.length > 1) {
          throw formatErrorMessage({
            token: functionCalleeExpr?.token ?? expr?.token ?? PlaceholderToken,
            errorMessage: `Ambiguous implicit parameter "${implicitParam.label}": found ${candidates.length} "given" variables with compatible type ${typeToString(resolvedImplicitType)} in the same scope.
Please use explicit using() to disambiguate.`,
          });
        }

        const givenVar = candidates[candidates.length - 1]!;
        const givenValue = givenVar.value?.[0];
        if (!givenValue) {
          throw formatErrorMessage({
            token: functionCalleeExpr?.token ?? expr?.token ?? PlaceholderToken,
            errorMessage: `The "given" variable "${givenVar.name}" has no compile-time value.`,
          });
        }

        implicitArgValues.push({
          value: givenValue,
          parameterType: resolvedImplicitType,
          argType: givenVar.type,
        });

        // Add implicit arg to calleeEnv (mark as isImplicit so it can be
        // found by nested using() parameter resolution)
        const { env: nextEnv } = addVariableToEnv({
          env: calleeEnv,
          variable: {
            name: implicitParam.label,
            type: resolvedImplicitType,
            isCompileTimeOnly: true,
            isImplicit: true,
            value: [givenValue],
            token: implicitParam.exprs.labelExpr?.token ?? PlaceholderToken,
            initializedAtToken:
              implicitParam.exprs.labelExpr?.token ?? PlaceholderToken,
            consumedAtToken: undefined,
            isOwningTheRcValue: false,
          },
          allowVariableShadowing: true,
        });
        calleeEnv = nextEnv;
      }
    }
  }

  const argValues_: ArgValues = {
    args: argValues,
    forallArgs: forallArgValues,
    implicitArgs: implicitArgValues,
    variadicArgs,
  };

  // Check if we need to evaluate the comptime function call
  // such as the type function, macro function, or function that returns comptime value.
  let returnValue: Value | undefined;
  /// Compile-time
  if (functionType.return.isCompileTimeOnly) {
    // During the checking phase (skipCtfeExecution), we don't actually execute CTFE.
    // We just verify types match and return an UnknownValue.
    // This prevents double execution when checking and then calling.
    if (skipCtfeExecution) {
      returnValue = createUnknownValue(returnType, {
        variableName: functionType.return.label,
        env: functionType.env,
        context,
      });
    } else if (isFunctionValue(functionValue)) {
      const {
        value: nextReturnValue,
        callerEnv: nextCallerEnv,
        calleeEnv: _nextCalleeEnv,
      } = evaluateComptimeFunctionCall({
        functionCalleeExpr,
        functionType,
        functionValue,
        argValues: argValues_,
        callerEnv: callerEnv,
        calleeEnv: calleeEnv,
        context: {
          ...context,
          // Keep the original validation state - don't override it
        },
      });
      returnValue = nextReturnValue;
      returnType = nextReturnValue.type;
      callerEnv = nextCallerEnv;
      calleeEnv = _nextCalleeEnv;
    } else {
      // NOTE: The returnType might be a SomeType that we already synthesized
      //     in this case, we need to try to get its synthesized value from the callerEnv.
      const _isSomeType =
        isTypeHierarchyType(returnType) && returnType.level === 0;
      const someTypeId = `${functionType.id}_return_sometype`;

      if (_isSomeType) {
        if (context.expectedType?.type) {
          returnValue = createTypeValue(context.expectedType.type);
        } else {
          if (context.isEvaluatingFunctionType) {
            const someType = createSomeType(
              returnType as TypeHierarchyType,
              functionType.return.label,
              { id: someTypeId, env: calleeEnv, context }
            );
            someType.functionApplication = expr;
            const newReturnType = getValueOfSomeTypeFromEnv(
              calleeEnv,
              someType
            );
            returnValue = createTypeValue(newReturnType);
          } else {
            throw formatErrorMessage({
              token:
                expr?.token ?? functionCalleeExpr?.token ?? PlaceholderToken,
              errorMessage: `Cannot infer comptime return type. Please provide the expected type.`,
            });
          }
        }
      } else {
        returnValue = createUnknownValue(returnType, {
          variableName: functionType.return.label,
          env: functionType.env,
          context,
        });
      }
    }
  }

  validateFunctionReturnType({
    returnType,
    env: calleeEnv, // Use calleeEnv to check SomeTypes inferred from forall parameters
    expr,
    context,
  });

  // Check if function has compile-time parameters and create specialized version if needed
  let specializedFunctionValue: FunctionValue | undefined;

  // Check if we're recursively calling the function we're currently specializing
  // to avoid infinite recursion during specialization
  const isRecursiveCallDuringSpecialization =
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock.value &&
    isFunctionValue(context.isEvaluatingFunctionBodyOrAsyncBlock.value) &&
    functionValue &&
    isFunctionValue(functionValue) &&
    context.isEvaluatingFunctionBodyOrAsyncBlock.value.funcId ===
      functionValue.funcId;

  // Skip specialization during the "checking phase" where we try function calls
  // with cloned expressions to see if parameters match. This avoids polluting
  // the specialization cache with intermediate capture structs.
  // See docs/SPECIALIZATION_CACHE_PITFALL.md for details.
  if (
    !skipSpecialization &&
    functionValue &&
    isFunctionValue(functionValue) && // functionValue might be UnknownValue, so this condition check is necessary
    !functionValue.isControlFunction && // Effect handlers skip normal specialization — handled by effect system
    isFunctionTypeGeneric(functionType) &&
    !isRecursiveCallDuringSpecialization && // Don't specialize if we're already specializing this function
    // Skip specialization when implicit args contain UnknownValue (e.g., at function
    // definition time when the handler hasn't been concretely provided yet).
    // This prevents creating broken specializations that reference unresolved functions.
    !argValues_.implicitArgs?.some((arg) => isUnknownValue(arg.value))
  ) {
    specializedFunctionValue = createSpecializedFunctionInline({
      originalFunction: functionValue,
      argValues: argValues_,
      calleeEnv: calleeEnv,
      callerEnv: callerEnv,
      context,
    });

    // For generic functions where the return type is a SomeType (e.g., forall(T) -> T),
    // update returnType to the concrete type from the evaluated body so the call site
    // gets the right type. This handles resume handlers and other generic functions
    // where T can only be resolved after body evaluation.
    if (specializedFunctionValue && isSomeType(returnType)) {
      const bodyType = specializedFunctionValue.body?.$?.type;
      if (bodyType && !isSomeType(bodyType)) {
        returnType = bodyType;
        // Also update the specialized function's return type so codegen uses the concrete type
        // and collection doesn't skip it (isFunctionSpecializable checks for SomeType in return).
        if (specializedFunctionValue.specializedType) {
          specializedFunctionValue.specializedType = {
            ...specializedFunctionValue.specializedType,
            return: {
              ...specializedFunctionValue.specializedType.return,
              type: bodyType,
            },
          };
        }
      }
    }

    // Filter runtimeArgExprsInOrder to exclude effectful function args.
    // Functions with implicit parameters of function/module type (i.e., `using(...)` params)
    // are always resolved at compile time — they should not be passed as runtime function
    // pointers. They're treated as compile-time in the specialization (not in the C function
    // signature), so they must also be excluded from the caller's argument list.
    if (specializedFunctionValue) {
      const indicesToRemove = new Set<number>();
      let runtimeArgIdx = 0;
      for (let i = 0; i < functionType.parameters.length; i++) {
        const param = functionType.parameters[i]!;
        if (!param.isCompileTimeOnly) {
          const arg = argValues_.args[i];
          const argVal = arg?.value;
          if (
            argVal &&
            isFunctionValue(argVal) &&
            argVal.type.implicitParameters.some(
              (p) => isFunctionType(p.type) || isModuleType(p.type)
            )
          ) {
            indicesToRemove.add(runtimeArgIdx);
          }
          runtimeArgIdx++;
        }
      }
      if (indicesToRemove.size > 0) {
        for (let idx = runtimeArgExprsInOrder.length - 1; idx >= 0; idx--) {
          if (indicesToRemove.has(idx)) {
            runtimeArgExprsInOrder.splice(idx, 1);
          }
        }
      }
    }
  }

  // Direct ctl function call: the ctl function is called without an intermediate
  // function with `using(ctl)`. The function body was deferred because of forall
  // parameters. We need to evaluate it with concrete types so codegen can inline it.
  //
  // Only do this when NOT inside a function that receives the ctl handler via
  // an implicit `using(raise: Raise)` parameter — in that case the call is handled
  // by the effect state machine (createSpecializedFunctionInline resolves the body).
  const isInsideFunctionWithCtlImplicitParam =
    context.hasControlFunctionImplicitParams ?? false;
  if (
    !skipSpecialization &&
    functionValue &&
    isFunctionValue(functionValue) &&
    functionValue.isControlFunction &&
    functionType.forallParameters.length > 0 &&
    !specializedFunctionValue &&
    !isInsideFunctionWithCtlImplicitParam
  ) {
    specializedFunctionValue = evaluateCtlFunctionBodyInline({
      originalFunction: functionValue,
      argValues: argValues_,
      calleeEnv,
      callerEnv,
      context,
    });
    // For `return(value)` (resume) handlers, update returnType to the concrete
    // type from the evaluated body so the call site gets the right type.
    if (specializedFunctionValue && isSomeType(returnType)) {
      const bodyType = specializedFunctionValue.body?.$?.type;
      if (bodyType && !isSomeType(bodyType)) {
        returnType = bodyType;
        if (specializedFunctionValue.specializedType) {
          specializedFunctionValue.specializedType = {
            ...specializedFunctionValue.specializedType,
            return: {
              ...specializedFunctionValue.specializedType.return,
              type: bodyType,
            },
          };
        }
      }
    }
  }

  // Handle automatic drop insertion for RAII before returning from function call
  // Get variables that need drop calls from the caller environment (function arguments)
  const variablesNeedingDrop = getVariablesNeedingDrop(callerEnv);

  // Generate deferred drop expressions for all variables that need cleanup
  let deferredDropExpressions: Expr[] | undefined = undefined;
  if (variablesNeedingDrop.length > 0) {
    const dropResult = generateDeferredDropExpressions({
      variablesToDrop: variablesNeedingDrop,
      env: callerEnv,
      context,
    });
    deferredDropExpressions = dropResult.deferredDropExpressions;

    callerEnv = dropResult.env;
  }

  return {
    returnType,
    calleeEnv,
    callerEnv,
    pathCollection,
    argValues: argValues_,
    returnValue,
    specializedFunctionValue,
    runtimeArgExprsInOrder,
    deferredDropExpressions,
  };
}

/**
 * Create a specialized function inline within tryToCallFunctionWithArguments
 */
function createSpecializedFunctionInline({
  originalFunction,
  argValues,
  calleeEnv,
  callerEnv,
  context,
}: {
  originalFunction: FunctionValue;
  argValues: ArgValues;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
}): FunctionValue {
  const functionType = originalFunction.type;

  // Extract compile-time argument values for caching
  const compileTimeArgValues: Value[] = [];
  const runtimeParameters: FunctionParameter[] = [];

  // Add forall type arguments (always compile-time)
  if (argValues.forallArgs) {
    compileTimeArgValues.push(...argValues.forallArgs.map((v) => v.value));
  }

  // Add implicit arguments (always compile-time)
  if (argValues.implicitArgs) {
    compileTimeArgValues.push(...argValues.implicitArgs.map((v) => v.value));
  }

  // Add regular compile-time parameters
  functionType.parameters.forEach((param, index) => {
    const arg = argValues.args[index]!;
    if (param.isCompileTimeOnly) {
      if (arg.value) {
        compileTimeArgValues.push(arg.value);
      }
    } else {
      // Functions with implicit parameters of function/module type (i.e., using(...)
      // effects) must be treated as compile-time because they are compiled as state
      // machines or inlined, not as regular C functions. The concrete function value
      // is needed at compile time for effect call site generation.
      const isEffectfulFuncParam =
        arg.value &&
        isFunctionValue(arg.value) &&
        arg.value.type.implicitParameters.some(
          (p) => isFunctionType(p.type) || isModuleType(p.type)
        );

      if (isEffectfulFuncParam) {
        if (arg.value) {
          compileTimeArgValues.push(arg.value);
        }
      } else {
        // Use argType (the actual concrete argument type) for cache comparison,
        // not parameterType (which might be a SomeType like Impl(...))
        // If argType is a SomeType with resolvedConcreteType, use the concrete type
        // so that the specialized function's parameters are fully resolved.
        // EXCEPTION: For Future types, do NOT unwrap to concrete type because
        // Futures are heap-backed ref-counted and need SomeType-level ARC methods.
        const shouldUseConcreteType =
          isSomeType(arg.argType) &&
          arg.argType.resolvedConcreteType &&
          !typeImplementsFuture(arg.argType);
        const concreteType = shouldUseConcreteType
          ? (arg.argType as SomeType).resolvedConcreteType!
          : arg.argType;
        runtimeParameters.push({ ...param, type: concreteType });
      }
    }
  });

  // Extract runtime parameter types for cache comparison
  // This is important for differentiating specializations with the same compile-time
  // type arguments but different concrete types (e.g., different closure capture structs)
  const runtimeParameterTypes: Type[] = runtimeParameters.map((p) => p.type);

  // Check if we already have a specialized version in cache
  // Must match both compile-time args AND runtime parameter types
  const existingCache = originalFunction.specializedFunctionCaches.find(
    (cache) => {
      // Check compile-time argument values match
      const compileTimeMatch =
        cache.compileTimeArgValues.length === compileTimeArgValues.length &&
        cache.compileTimeArgValues.every((cachedValue, index) => {
          const currentValue = compileTimeArgValues[index]!;
          return areValuesEqual(
            { value: cachedValue, env: cache.env },
            { value: currentValue, env: callerEnv }
          );
        });

      if (!compileTimeMatch) {
        return false;
      }

      // Check runtime parameter types match
      // This ensures different concrete types (e.g., different closure capture structs)
      // get different specializations even if they have the same compile-time type argument
      const runtimeMatch =
        cache.runtimeParameterTypes.length === runtimeParameterTypes.length &&
        cache.runtimeParameterTypes.every((cachedType, index) => {
          const currentType = runtimeParameterTypes[index]!;
          return areTypesCompatible(
            { type: cachedType, env: cache.env },
            { type: currentType, env: callerEnv },
            true // requireExactMatch: use strict type ID comparison
          );
        });

      return runtimeMatch;
    }
  );

  if (existingCache) {
    return existingCache.specializedFunction;
  }

  // Create specialized environment with compile-time arguments bound
  let specializedEnv = calleeEnv;

  // Add compile-time bindings from caller's scope that are missing from calleeEnv.
  // This is needed because the function's closure env may not include bindings defined
  // after the function type itself (e.g., handler functions bound via `given` may need
  // access to types like Raise that are visible at the call site but not captured in
  // the handler's closure).
  for (const frame of callerEnv.frames) {
    for (const variable of frame.variables) {
      if (!variable.isCompileTimeOnly) continue;
      const existing = getVariablesFromEnv(specializedEnv, variable.name);
      if (existing.length > 0) continue;
      const { env: nextEnv } = addVariableToEnv({
        env: specializedEnv,
        variable: { ...variable },
        allowVariableShadowing: true,
      });
      specializedEnv = nextEnv;
    }
  }

  // CRITICAL: Clear the values of runtime parameters in the specialized environment.
  // The calleeEnv has runtime parameter values from the specific call site (e.g., x=1 for comptime_add(1, 1)).
  // We need to clear these so that codegen generates proper variable references (e.g., "x + 1")
  // instead of inlining the compile-time evaluated result (e.g., "2").
  // Only compile-time parameters should retain their values for specialization.
  for (const param of runtimeParameters) {
    const variables = getVariablesFromEnv(specializedEnv, param.label);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;
      // Clear the value but keep the type - this makes it a runtime-only variable
      const updatedVariable: Variable = {
        ...variable,
        value: undefined,
      };
      specializedEnv = updateExistingVariable(
        specializedEnv,
        variable,
        updatedVariable
      );
    }
  }

  // Clone the function body and evaluate it in the specialized environment
  const clonedBody = cloneExpr(originalFunction.body);

  // Resolve the return type by re-evaluating it in the specialized environment
  // This is analogous to how we resolve parameter types using evaluateFunctionParameterTypeAgain
  const {
    returnType: specializedReturnType,
    calleeEnv: _updatedSpecializedEnv,
  } = evaluateFunctionReturnTypeAgain({
    functionType,
    calleeEnv: specializedEnv,
    context: {
      ...context,
      isEvaluatingFunctionType: true,
    },
    functionCalleeExpr: undefined,
  });
  specializedEnv = _updatedSpecializedEnv;

  // Evaluate the function body in the specialized environment
  // For effect handlers, propagate the enclosing function return type from
  // so `abort` can type-check during re-evaluation.
  const specializedEnclosingReturnType = context.enclosingFunctionReturnType;

  // Detect whether any implicit args are control function handlers.
  // This is used to set hasControlFunctionImplicitParams on the context so that
  // calls inside this function's body know not to do direct ctl call handling.
  const hasControlFunctionImplicitParams =
    argValues.implicitArgs?.some(
      (arg) =>
        (isFunctionValue(arg.value) && arg.value.isControlFunction) ||
        (isModuleValue(arg.value) &&
          moduleTypeContainsCtlField(arg.value.type as ModuleType, arg.value))
    ) ?? false;

  const specializedBody = evaluateBeginExpression({
    expr: clonedBody,
    env: specializedEnv,
    context: {
      ...context,
      expectedType: {
        type: specializedReturnType,
        env: specializedEnv,
      },
      isEvaluatingFunctionBodyOrAsyncBlock: {
        kind: "function-body",
        type: functionType,
        value: originalFunction,
        evaluationEnv: specializedEnv,
      },
      isEvaluatingLoopBody: undefined, // Clear loop body context for function body
      capturedVariables: undefined,
      functionReturnImplConcreteType: [], // Fresh array for each specialization
      hasControlFunctionImplicitParams,
      ...(specializedEnclosingReturnType
        ? { enclosingFunctionReturnType: specializedEnclosingReturnType }
        : {}),
    },
    variablesToAdd: [],
    isEvaluatingFunctionBodyBeginBlock: true,
  });
  if (!specializedBody.$) {
    throw formatErrorMessage({
      token: originalFunction.body.token,
      errorMessage: `Failed to evaluate function body for specialization.`,
    });
  }

  // If the specialized body uses `abort`, mark the function type as isControlFunction.
  // This handles deferred handler bodies that couldn't be detected at definition time.
  // Run effect analysis on the specialized body if it has implicit parameters
  // whose resolved handlers use abort (isControlFunction).
  // This detects effect call points (e.g., raise(msg)) and prepares for state machine generation.
  // Also handles effect row spread parameters (using(...(E))) by extracting the individual
  // effect parameters from the bound EffectsRowType.
  const effectCtlParams: Array<{
    handlerArgIndex: number;
    label: string;
    type: FunctionType;
    fromSpread: boolean;
    effectFieldPath?: string[];
  }> = [];
  // Compute the mapping from implicit param index to implicitArgValues index.
  // Spread params expand into multiple entries, so we need to track the offset.
  let argOffset = 0;
  for (let i = 0; i < functionType.implicitParameters.length; i++) {
    const implicitParam = functionType.implicitParameters[i]!;
    if (isFunctionType(implicitParam.type)) {
      // Check if the resolved handler uses abort (has isControlFunction set)
      const handlerArg = argValues.implicitArgs?.[argOffset];
      const handlerValue =
        handlerArg && isFunctionValue(handlerArg.value)
          ? handlerArg.value
          : undefined;
      if (handlerValue?.isControlFunction) {
        effectCtlParams.push({
          handlerArgIndex: argOffset,
          label: implicitParam.label,
          type: implicitParam.type,
          fromSpread: false,
        });
      }
      argOffset += 1;
    } else if (implicitParam.isEffectRowSpread) {
      // Effect row spread: resolve the type (might be a SomeType that needs lookup)
      let resolvedType = implicitParam.type;
      if (isSomeType(resolvedType)) {
        // Try looking up by variable name in environment first
        const eVars = getVariablesFromEnv(specializedEnv, implicitParam.label);
        const eVarValue = eVars.at(-1)?.value?.[0];
        if (
          eVarValue &&
          isTypeValue(eVarValue) &&
          isEffectsRowType(eVarValue.value)
        ) {
          resolvedType = eVarValue.value;
        } else {
          const boundType = getValueOfSomeTypeFromEnv(
            specializedEnv,
            resolvedType
          );
          if (boundType) {
            resolvedType = boundType;
          }
        }
      }
      if (isEffectsRowType(resolvedType)) {
        // Extract individual effect parameters from the resolved EffectsRowType
        for (let k = 0; k < resolvedType.implicitParameters.length; k++) {
          const innerParam = resolvedType.implicitParameters[k]!;
          if (isFunctionType(innerParam.type)) {
            const innerHandlerArg = argValues.implicitArgs?.[argOffset + k];
            const innerHandlerValue =
              innerHandlerArg && isFunctionValue(innerHandlerArg.value)
                ? innerHandlerArg.value
                : undefined;
            if (innerHandlerValue?.isControlFunction) {
              effectCtlParams.push({
                handlerArgIndex: argOffset + k,
                label: innerParam.label,
                type: innerParam.type,
                fromSpread: true,
              });
            }
          }
        }
        argOffset += resolvedType.implicitParameters.length;
      } else {
        argOffset += 1;
      }
    } else if (isModuleType(implicitParam.type)) {
      // Module-based effects: recursively find effect fields in possibly nested modules.
      // Check the handler VALUE's isControlFunction flag (set when a handler body uses abort).
      const ctlFields: Array<{ path: string[]; type: FunctionType }> = [];
      const handlerArg = argValues.implicitArgs?.[argOffset];
      const findCtlFieldsInModule = (
        moduleType: ModuleType,
        pathSoFar: string[],
        moduleVal?: ModuleValue
      ) => {
        for (let fi = 0; fi < moduleType.fields.length; fi++) {
          const field = moduleType.fields[fi]!;
          if (isFunctionType(field.type)) {
            const fieldVal = moduleVal?.fields[fi];
            if (
              fieldVal &&
              isFunctionValue(fieldVal) &&
              fieldVal.isControlFunction
            ) {
              ctlFields.push({
                path: [...pathSoFar, field.label],
                type: field.type as FunctionType,
              });
            }
          } else if (isModuleType(field.type)) {
            const innerModuleVal = moduleVal?.fields[fi];
            findCtlFieldsInModule(
              field.type,
              [...pathSoFar, field.label],
              innerModuleVal && isModuleValue(innerModuleVal)
                ? innerModuleVal
                : undefined
            );
          }
        }
      };
      findCtlFieldsInModule(
        implicitParam.type,
        [],
        handlerArg && isModuleValue(handlerArg.value)
          ? handlerArg.value
          : undefined
      );

      for (const ctlField of ctlFields) {
        effectCtlParams.push({
          handlerArgIndex: argOffset,
          label: implicitParam.label,
          type: ctlField.type,
          fromSpread: false,
          effectFieldPath: ctlField.path,
        });
      }
      argOffset += 1;
    } else {
      argOffset += 1;
    }
  }

  // Collect all effect analyses (one per ctl parameter)
  const allEffectAnalyses: Array<{
    analysis: EffectAnalysisResult;
    ctlParam: (typeof effectCtlParams)[0];
  }> = [];

  for (const ctlParam of effectCtlParams) {
    const effectAnalysis = analyzeEffectCallPoints(
      specializedBody,
      ctlParam.label,
      ctlParam.type,
      true,
      ctlParam.effectFieldPath
    );
    if (effectAnalysis.hasEffects) {
      // Store the handler value on the effectAnalysis so codegen can inline it.
      // The implicit args correspond to implicit parameters by index.
      const handlerArg = argValues.implicitArgs?.[ctlParam.handlerArgIndex];
      // For module-based effects, extract the ctl function by walking the field path
      let resolvedHandlerFn: FunctionValue | undefined;
      const fieldPathForHandler = ctlParam.effectFieldPath;
      if (handlerArg && isFunctionValue(handlerArg.value)) {
        resolvedHandlerFn = handlerArg.value;
      } else if (
        handlerArg &&
        isModuleValue(handlerArg.value) &&
        fieldPathForHandler &&
        fieldPathForHandler.length > 0
      ) {
        // Walk through nested modules following the field path
        let currentValue: Value | undefined = handlerArg.value;
        for (const fieldName of fieldPathForHandler) {
          if (!isModuleValue(currentValue)) {
            currentValue = undefined;
            break;
          }
          const fieldIndex = currentValue.type.fields.findIndex(
            (f) => f.label === fieldName
          );
          if (fieldIndex < 0 || !currentValue.fields[fieldIndex]) {
            currentValue = undefined;
            break;
          }
          currentValue = currentValue.fields[fieldIndex]!;
        }
        if (currentValue && isFunctionValue(currentValue)) {
          resolvedHandlerFn = currentValue;
        }
      }
      if (resolvedHandlerFn) {
        const handlerFn = resolvedHandlerFn;
        const ctlType = ctlParam.type;

        // Re-evaluate handler body with concrete types from the effect call site.
        // Check whether the handler body was truly deferred (sub-expressions unevaluated).
        // anonymous-function.ts sets a shallow $ on the body (with env/type info),
        // but sub-expressions like println(msg) won't have $ annotations.
        // For isControlFunction handlers that skip normal specialization, the body
        // may have only this shallow $ — detect this by checking the begin block's args.
        let handlerBodyNeedsReEvaluation = !handlerFn.body.$;
        if (
          !handlerBodyNeedsReEvaluation &&
          handlerFn.isControlFunction &&
          exprIsFunctionCall(handlerFn.body) &&
          handlerFn.body.args.length > 0 &&
          !handlerFn.body.args[0]?.$
        ) {
          handlerBodyNeedsReEvaluation = true;
        }
        if (
          handlerBodyNeedsReEvaluation &&
          isFunctionType(ctlType) &&
          ctlType.forallParameters.length > 0 &&
          effectAnalysis.effectCallPoints.length > 0
        ) {
          const forallTypeMap = new Map<string, Type>();
          const returnType = ctlType.return.type;
          const concreteReturnType =
            effectAnalysis.effectCallPoints[0]!.operationResultType;

          if (isSomeType(returnType)) {
            forallTypeMap.set(returnType.name, concreteReturnType);
          }

          // Fallback inference for common effect signatures like
          //   Raise :: fn(forall(T : Type), ...) -> T
          // If we couldn't infer from returnType SomeType name, bind the single
          // forall parameter to the concrete operation result type.
          if (
            forallTypeMap.size === 0 &&
            ctlType.forallParameters.length === 1
          ) {
            const onlyForall = ctlType.forallParameters[0]!;
            forallTypeMap.set(onlyForall.label, concreteReturnType);
          }

          const clonedHandlerFnBody = cloneExpr(handlerFn.body);
          let handlerEnv = handlerFn.body.$?.env ?? specializedEnv;
          handlerEnv = pushEnvFrame(handlerEnv);

          for (const forallParam of ctlType.forallParameters) {
            const concreteType = forallTypeMap.get(forallParam.label);
            if (concreteType) {
              const result = addVariableToEnv({
                env: handlerEnv,
                variable: {
                  name: forallParam.label,
                  type: forallParam.type,
                  isCompileTimeOnly: true,
                  value: [createTypeValue(concreteType)],
                  token: PlaceholderToken,
                  initializedAtToken: PlaceholderToken,
                  consumedAtToken: undefined,
                  isOwningTheRcValue: false,
                },
                allowVariableShadowing: true,
              });
              handlerEnv = result.env;
            }
          }

          const handlerFnType = handlerFn.specializedType ?? handlerFn.type;
          // For abort type-checking, the enclosing return type should be the
          // handler's definition-site enclosing function's return type, NOT the
          // call-site function's return type. E.g., handler defined in main (-> unit)
          // but inlined at compute (-> i32): abort () should match main's unit.
          // When definitionSiteEnclosingFunctionType is undefined (e.g., handler
          // defined in a test block), default to unit — abort exits the top-level scope.
          const enclosingReturnType =
            handlerFn.definitionSiteEnclosingFunctionType?.return.type ??
            createUnitType();

          const handlerContext: EvaluatorContext = {
            ...context,
            expectedType: undefined,
            enclosingFunctionReturnType: enclosingReturnType,
            isEvaluatingFunctionBodyOrAsyncBlock: {
              kind: "function-body",
              type: handlerFnType,
              value: handlerFn,
              evaluationEnv: handlerEnv,
            },
          };

          try {
            const evaluatedBody = _evaluateExpression({
              expr: clonedHandlerFnBody,
              env: handlerEnv,
              context: handlerContext,
            });

            const reEvaluatedHandler: FunctionValue = {
              ...handlerFn,
              body: evaluatedBody,
            };
            effectAnalysis.handlerValue = reEvaluatedHandler;
          } catch (e) {
            const bodyIsStillUnevaluated =
              exprIsFunctionCall(handlerFn.body) &&
              handlerFn.body.args.length > 0 &&
              !handlerFn.body.args[0]?.$;

            if (bodyIsStillUnevaluated) {
              throw e;
            }

            effectAnalysis.handlerValue = handlerFn;
          }
        } else {
          effectAnalysis.handlerValue = handlerFn;
        }
      } else if (handlerArg) {
        effectAnalysis.handlerValue = handlerArg.value;
      }

      allEffectAnalyses.push({ analysis: effectAnalysis, ctlParam });
    }
  }

  // Merge effect analyses: if there's only one, use it directly.
  // If there are multiple, merge all effect call points into one analysis
  // with effectIndex on each call point and effectHandlerInfos array.
  if (allEffectAnalyses.length === 1) {
    specializedBody.$.effectAnalysis = allEffectAnalyses[0]!.analysis;
  } else if (allEffectAnalyses.length > 1) {
    // Merge multiple effect analyses into one
    const mergedCallPoints: EffectCallPoint[] = [];
    const mergedCapturedVars = new Map<string, EffectCapturedVariable>();
    const mergedVariableIdRemapping = new Map<string, string>();
    const effectHandlerInfos: EffectHandlerInfo[] = [];

    for (let effectIdx = 0; effectIdx < allEffectAnalyses.length; effectIdx++) {
      const { analysis } = allEffectAnalyses[effectIdx]!;

      // Build handler info for this effect
      effectHandlerInfos.push({
        effectParameterName: analysis.effectParameterName,
        effectParameterType: analysis.effectParameterType,
        effectFieldPath: analysis.effectFieldPath,
        handlerValue: analysis.handlerValue,
        operationArgTypes:
          analysis.effectCallPoints.length > 0
            ? analysis.effectCallPoints[0]!.operationArgTypes
            : [],
        operationResultType:
          analysis.effectCallPoints.length > 0
            ? analysis.effectCallPoints[0]!.operationResultType
            : ({ tag: "unit" } as Type),
      });

      // Add call points with effectIndex
      for (const cp of analysis.effectCallPoints) {
        mergedCallPoints.push({
          ...cp,
          effectIndex: effectIdx,
        });
      }

      // Merge captured variables
      for (const cv of analysis.capturedVariables) {
        if (!mergedCapturedVars.has(cv.id)) {
          mergedCapturedVars.set(cv.id, cv);
        }
      }

      // Merge variable ID remappings
      for (const [key, value] of analysis.variableIdRemapping) {
        mergedVariableIdRemapping.set(key, value);
      }
    }

    // Re-index merged call points. They need to be ordered by position in the
    // function body. Since each per-parameter analysis walks the body in order,
    // the call points from each analysis are already in body order. We need to
    // interleave them based on their expression position.
    // Use a simple approach: sort by the expression's position in the begin block.
    // For now, keep them in the order they were collected (each analysis walks
    // the same body, so transitive calls from different params at different body
    // positions will appear in body order within each analysis).
    // We sort by walking the body's begin block to determine expr position.
    if (
      exprIsFunctionCall(specializedBody) &&
      exprIsFunctionCallOf(specializedBody, BuiltinKeywords.begin)
    ) {
      const bodyExprs = specializedBody.args;
      // Build a map from each top-level body expression to its index
      const exprPositionMap = new Map<unknown, number>();
      for (let i = 0; i < bodyExprs.length; i++) {
        exprPositionMap.set(bodyExprs[i], i);
      }
      // For each merged call point, find which top-level body expr contains it
      const getExprPosition = (cp: EffectCallPoint): number => {
        for (let i = 0; i < bodyExprs.length; i++) {
          if (containsExpr(bodyExprs[i]!, cp.expr as Expr)) {
            return i;
          }
        }
        return 999;
      };
      mergedCallPoints.sort((a, b) => getExprPosition(a) - getExprPosition(b));
    }

    // Re-index after sorting
    for (let i = 0; i < mergedCallPoints.length; i++) {
      mergedCallPoints[i]!.index = i;
    }

    // Use the first analysis as the base and override with merged data
    const firstAnalysis = allEffectAnalyses[0]!.analysis;
    const mergedAnalysis: EffectAnalysisResult = {
      effectCallPoints: mergedCallPoints,
      capturedVariables: Array.from(mergedCapturedVars.values()),
      hasEffects: true,
      variableIdRemapping: mergedVariableIdRemapping,
      effectParameterName: firstAnalysis.effectParameterName,
      effectParameterType: firstAnalysis.effectParameterType,
      effectFieldPath: firstAnalysis.effectFieldPath,
      handlerValue: firstAnalysis.handlerValue,
      effectHandlerInfos,
    };

    specializedBody.$.effectAnalysis = mergedAnalysis;
  }

  // Create signature for the specialized function
  const compileTimeSignatureParts: string[] = [];

  // Include forall type arguments
  // Helper function to convert a value to a string for signature, including type IDs for anonymous types
  const valueToSignatureString = (value: Value): string => {
    if (isTypeValue(value)) {
      const type = value.value;
      // For anonymous types (no typeName), include the type ID to ensure uniqueness
      if (!type.typeName && type.id) {
        return `${valueToString(value)}_id${type.id}`;
      }
    }
    if (isFunctionValue(value)) {
      // Include funcId for function values to distinguish different anonymous functions
      // (e.g., different ctl effect handlers passed as implicit arguments)
      return `fn_${value.funcId}`;
    }
    return valueToString(value);
  };

  // In theory all the forallArgs should be compile-time arguments
  functionType.forallParameters.forEach((param, index) => {
    if (index < argValues.forallArgs.length) {
      const arg = argValues.forallArgs[index]!;
      compileTimeSignatureParts.push(
        sanitizeForCIdentifier(valueToSignatureString(arg.value))
      );
    } else {
      const label = param.label;
      // Check if it's in the calleeEnv
      // Its value might be available after synthesizing types
      const variables = getVariablesFromEnv(calleeEnv, label);
      if (variables.length > 0 && variables[variables.length - 1]?.value?.[0]) {
        compileTimeSignatureParts.push(
          sanitizeForCIdentifier(
            valueToSignatureString(variables[variables.length - 1]!.value![0])
          )
        );
      } else {
        compileTimeSignatureParts.push("unknown");
      }
    }
  });

  // Include compile-time regular parameters
  functionType.parameters.forEach((param, index) => {
    if (param.isCompileTimeOnly && index < argValues.args.length) {
      const arg = argValues.args[index];
      if (arg) {
        compileTimeSignatureParts.push(
          sanitizeForCIdentifier(valueToSignatureString(arg.value!))
        );
      } else {
        compileTimeSignatureParts.push("unknown");
      }
    }
  });

  // Include implicit parameter values in the compile-time signature
  if (argValues.implicitArgs) {
    argValues.implicitArgs.forEach((arg) => {
      compileTimeSignatureParts.push(
        sanitizeForCIdentifier(valueToSignatureString(arg.value))
      );
    });
  }

  // Include runtime parameter types if they contain anonymous types
  // This ensures different concrete types get different specializations
  runtimeParameters.forEach((param, index) => {
    const paramType = param.type;
    // If the parameter type is anonymous (no typeName) or is/contains SomeType
    if (
      (!paramType.typeName && paramType.id) ||
      typeContainsSomeType(paramType)
    ) {
      compileTimeSignatureParts.push(
        `rtparam${index}_${sanitizeForCIdentifier(typeToString(paramType))}_id${paramType.id}`
      );
    }
  });

  const compileTimeSignature = compileTimeSignatureParts.join("_");

  const specializedFunctionType = createFunctionType({
    forallParameters: [],
    parameters: runtimeParameters,
    variadicParameter: undefined, // QUESTION: Is this right?
    return_: {
      ...functionType.return,
      type: specializedReturnType,
    },
    parametersFrame: specializedEnv.frames[specializedEnv.frames.length - 1]!, // QUESTION: This could be wrong
    env: functionType.env,
    SelfType: functionType.SelfType,
  });

  // console.log(
  //   "generate specialized function:",
  //   `${originalFunction.funcName}_${compileTimeSignature}`,
  //   argValues.forallArgs
  // );

  // Create a new specialized function value with the evaluated body
  const specializedFunction: FunctionValue = {
    ...originalFunction,
    specializedType: specializedFunctionType,
    body: specializedBody,
    // Detect isControlFunction from the specialized body
    isControlFunction:
      originalFunction.isControlFunction ||
      evaluatedBodyContainsAbort(specializedBody),
    // Use a signature-based ID for the specialized function
    funcId: `${originalFunction.funcId}_${compileTimeSignature}`,
    funcName: `${originalFunction.funcName}_${compileTimeSignature}`,
    // Initialize cache arrays for the specialized function
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Cache the specialized function in the original function's cache
  const newCache: SpecializedFunctionCache = {
    funcId: originalFunction.funcId,
    compileTimeArgValues,
    runtimeParameterTypes,
    specializedFunction,
    env: specializedBody.$.env,
  };

  originalFunction.specializedFunctionCaches = [
    ...originalFunction.specializedFunctionCaches,
    newCache,
  ];

  return specializedFunction;
}

/**
 * Evaluate a ctl function body with concrete types for a direct ctl call.
 *
 * When a `ctl` function is called directly (not through a `using` parameter),
 * its body was deferred (not evaluated at definition time) because of forall parameters.
 * We need to evaluate it here with the concrete types from the call context.
 *
 * The forall type parameter T is resolved from the enclosing function's return type
 * (since `abort val` exits the enclosing function with a value of type T).
 */
function evaluateCtlFunctionBodyInline({
  originalFunction,
  calleeEnv,
  callerEnv,
  context,
}: {
  originalFunction: FunctionValue;
  argValues: ArgValues;
  calleeEnv: Environment;
  callerEnv: Environment;
  context: EvaluatorContext;
}): FunctionValue {
  const functionType = originalFunction.type;

  // Determine the concrete type for the forall parameter T.
  // For `return` handlers, T is the return type of the ctl operation at the call site.
  // For `abort` handlers, T can be anything (continuation is discarded), but we
  // use the call-site type for consistent forall binding.
  const concreteTypeForForall =
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
      ? context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
      : functionType.return.type;

  // For abort type-checking, the enclosing return type should be from the handler's
  // definition-site enclosing function (e.g., main -> unit), not the call-site.
  // When definitionSiteEnclosingFunctionType is undefined (e.g., handler defined
  // in a test block), default to unit.
  const enclosingReturnType =
    originalFunction.definitionSiteEnclosingFunctionType?.return.type ??
    createUnitType();

  // Check specialization cache using a type-based signature
  const ctlSignature = sanitizeForCIdentifier(
    typeToString(concreteTypeForForall)
  );
  const existingCache = originalFunction.specializedFunctionCaches.find(
    (cache) =>
      cache.specializedFunction.funcId ===
      `${originalFunction.funcId}_ctl_${ctlSignature}`
  );
  if (existingCache) {
    return existingCache.specializedFunction;
  }

  // Build an env with forall parameters bound to their concrete types.
  // Start with calleeEnv (function closure + parameters), then add compile-time
  // bindings from callerEnv that aren't already in calleeEnv. This is needed because
  // the handler's closure env comes from the ctl type definition (e.g., Raise) which
  // doesn't include bindings defined after the type itself (like Raise itself, or
  // other ctl types defined later). The callerEnv has these bindings.
  let specializedEnv = pushEnvFrame(calleeEnv);

  // Add compile-time bindings from caller's scope that are missing from calleeEnv.
  // This allows the handler body to reference types like Raise that are visible at
  // the call site but not in the handler's closure (which comes from the ctl type's env).
  for (const frame of callerEnv.frames) {
    for (const variable of frame.variables) {
      if (!variable.isCompileTimeOnly) continue;
      // Check if this variable already exists in specializedEnv
      const existing = getVariablesFromEnv(specializedEnv, variable.name);
      if (existing.length > 0) continue;
      const { env: nextEnv } = addVariableToEnv({
        env: specializedEnv,
        variable: { ...variable },
        allowVariableShadowing: true,
      });
      specializedEnv = nextEnv;
    }
  }

  for (const forallParam of functionType.forallParameters) {
    // Map the forall type variable to the concrete call-site type
    const concreteType = concreteTypeForForall;
    const { env: nextEnv } = addVariableToEnv({
      env: specializedEnv,
      variable: {
        name: forallParam.label,
        type: forallParam.type,
        isCompileTimeOnly: true,
        value: [createTypeValue(concreteType)],
        token: PlaceholderToken,
        initializedAtToken: PlaceholderToken,
        consumedAtToken: undefined,
        isOwningTheRcValue: false,
      },
      allowVariableShadowing: true,
    });
    specializedEnv = nextEnv;
  }

  const clonedBody = cloneExpr(originalFunction.body);

  const handlerContext: EvaluatorContext = {
    ...context,
    expectedType: undefined,
    enclosingFunctionReturnType: enclosingReturnType,
    isEvaluatingFunctionBodyOrAsyncBlock: {
      kind: "function-body",
      type: functionType,
      value: originalFunction,
      evaluationEnv: specializedEnv,
    },
    functionReturnImplConcreteType: [],
  };

  const evaluatedBody = _evaluateExpression({
    expr: clonedBody,
    env: specializedEnv,
    context: handlerContext,
  });

  const specializedFunction: FunctionValue = {
    ...originalFunction,
    body: evaluatedBody,
    isControlFunction:
      originalFunction.isControlFunction ||
      evaluatedBodyContainsAbort(evaluatedBody),
    funcId: `${originalFunction.funcId}_ctl_${ctlSignature}`,
    funcName: `${originalFunction.funcName ?? originalFunction.funcId}_ctl_${ctlSignature}`,
    calledComptimeFunctionCaches: [],
    specializedFunctionCaches: [],
  };

  // Cache to avoid re-evaluating on repeated calls
  originalFunction.specializedFunctionCaches = [
    ...originalFunction.specializedFunctionCaches,
    {
      funcId: originalFunction.funcId,
      compileTimeArgValues: [],
      runtimeParameterTypes: [],
      specializedFunction,
      env: evaluatedBody.$?.env ?? specializedEnv,
    },
  ];

  return specializedFunction;
}
/**
 * Check if the returnType contains any SomeType that doesn't exist in the callerEnv;
 * If yes, then throw error
 */
export function validateFunctionReturnType({
  returnType,
  expr,
  env,
  context,
}: {
  returnType: Type;
  expr: Expr | undefined;
  env: Environment;
  context: EvaluatorContext;
}): void {
  if (context.isEvaluatingFunctionType || context.expectedType) {
    return;
  }

  const returnTypeSomeTypes = getAllSomeTypes(returnType);
  for (const returnTypeSomeType of returnTypeSomeTypes) {
    {
      // FIXME: The check here is not essentially correct:

      // Skip validation for Impl(Future(...)) - these are concrete Future implementations
      // created by async blocks and don't need to be resolved from the environment.
      // The async block creates its own state machine type, and when a function returns
      // Impl(Future(...)), the actual implementation comes from the async block in the
      // function body, not from type resolution.
      if (typeImplementsFuture(returnTypeSomeType)) {
        continue;
      }

      // Skip validation for Impl(Fn(...)) - these are concrete closure implementations
      // created by fn expressions and don't need to be resolved from the environment.
      if (typeImplementsFn(returnTypeSomeType)) {
        continue;
      }

      // Skip validation for Impl(Trait) that has a resolvedConcreteType
      // This means the concrete implementation type was resolved from the function body
      if (returnTypeSomeType.resolvedConcreteType) {
        continue;
      }

      // Skip validation for Impl(Trait) with requiredTraits but no generic type parameter
      // These are existential types where the concrete type is determined by the function body,
      // not from the caller's environment. The type compatibility is checked separately.
      if (
        returnTypeSomeType.requiredTraits &&
        returnTypeSomeType.requiredTraits.length > 0
      ) {
        continue;
      }
    }

    const variables = getVariablesFromEnv(env, returnTypeSomeType.name);
    if (!variables.length) {
      // Check if this SomeType exists within the types of other variables
      // For example, if T = KeyValuePair(K, V), and we're looking for K,
      // then K exists transitively through T
      const allVariables = getVariablesFromEnvByFilter(env, () => true);
      let foundTransitively = false;

      for (const variable of allVariables) {
        if (isTypeValue(variable.value?.[0])) {
          const typeValue = variable.value[0].value;
          const transitiveTypes = getAllSomeTypes(typeValue);
          for (const transitiveType of transitiveTypes) {
            if (transitiveType.name === returnTypeSomeType.name) {
              foundTransitively = true;
              break;
            }
          }
          if (foundTransitively) break;
        }
      }

      if (foundTransitively) {
        continue; // SomeType found transitively, validation passes
      }

      // Throw error if SomeType value is not found.
      throw formatErrorMessage({
        token: expr?.token ?? PlaceholderToken,
        errorMessage: `Failed to infer the function call return type.
Please consider providing the expected type.`,
      });
    }
  }
}

function containsExpr(root: Expr, target: Expr): boolean {
  if (root === target) return true;
  if (root.tag === ExprTag.FnCall) {
    if (containsExpr(root.func, target)) return true;
    for (const arg of root.args) {
      if (containsExpr(arg, target)) return true;
    }
  }
  return false;
}
