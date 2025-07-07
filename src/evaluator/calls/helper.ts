import { checkBorrowings } from "../../borrow";
import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  cloneExpr,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  setExprAsConsumed,
} from "../../expr";
import { FunctionValue } from "../../function-value";
import { PlaceholderToken } from "../../token";
import {
  areTypesCompatible,
  convertComptTypeToRuntimeType,
  createExprType,
  FunctionParameter,
  isExprType,
  isFunctionType,
  isMutRefType,
  isRefType,
  Type,
  typeRequiresComptModifier,
  typeToString,
} from "../../types";
import { createExprValue, isTypeValue, Value } from "../../value";
import { EvaluatorContext } from "../context";
import { synthesizeTypes } from "../types/synthesizer";

export function evaluateFunctionParameterType({
  parameter,
  calleeEnv,
  context,
  functionValue,
}: {
  parameter: FunctionParameter;
  calleeEnv: Environment;
  context: EvaluatorContext;
  functionValue: FunctionValue | undefined;
}): { parameterType: Type; calleeEnv: Environment } {
  const typeExpr = parameter.exprs.typeExpr;
  const defaultValueExpr = parameter.exprs.defaultValueExpr;
  if (typeExpr) {
    const evaluatedTypeExpr = context.evaluateExpression({
      expr: cloneExpr(typeExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionValue?.SelfType,
      },
    });
    if (!isTypeValue(evaluatedTypeExpr.$?.value)) {
      throw formatErrorMessage({
        token: typeExpr.token,
        errorMessage: `Expected type for parameter, got:\n${exprToString(evaluatedTypeExpr)}`,
      });
    }
    if (evaluatedTypeExpr.$?.env) {
      calleeEnv = evaluatedTypeExpr.$?.env;
    }
    const parameterType = evaluatedTypeExpr.$?.value.value;
    return {
      parameterType,
      calleeEnv,
    };
  } else if (defaultValueExpr) {
    const evaluatedDefaultValueExpr = context.evaluateExpression({
      expr: cloneExpr(defaultValueExpr),
      env: calleeEnv,
      context: {
        ...context,
        expectedType: undefined,
        SelfType: functionValue?.SelfType,
      },
    });
    if (!evaluatedDefaultValueExpr.$) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Failed to evaluate default value expression:\n${exprToString(defaultValueExpr)}`,
      });
    }
    calleeEnv = evaluatedDefaultValueExpr.$?.env;

    /*
    const value = evaluatedDefaultValueExpr.$?.value;
    if (!value) {
      throw formatErrorMessage({
        token: defaultValueExpr.token,
        errorMessage: `Expected value for parameter, got:\n${exprToString(defaultValueExpr)}`,
      });
    }
    */

    const parameterType = evaluatedDefaultValueExpr.$.type; // value.type;
    // NOTE: Using value.type is wrong here.
    // value might be i32,
    // but expr type is Type, not Free.
    return {
      parameterType,
      calleeEnv,
    };
  } else {
    // For anonymous functions, the parameter type is already known and doesn't need evaluation
    return {
      parameterType: parameter.type,
      calleeEnv,
    };
  }
}

export function checkIfFunctionParameterMatchesArgument({
  functionValue,
  parameter,
  argExprs,
  argIndex,
  calleeEnv,
  callerEnv,
  context,
  isMethodCall,
  runtimeArgExprsInOrder,
}: {
  functionValue?: FunctionValue;
  /**
   * It could be typeParameters, parameters, or implicitParameters
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

  let parameterType = parameter.type;
  if (isFunctionType(parameterType)) {
    // Evaluate the parameter type again.
    // This is for anonymous function type that contains type parameter
    // for example:
    //    (forall(@(T): Type), x: T, callback: ((v: T)-> T))-> T
    // and we call it:
    //    generic_fn(1, fn(x)-> add(x, 1));
    // We can infer `T` is `i32`,
    // But when we evaluate `callback`, we need to evaluate its type again
    // before we evluate the arg

    const { parameterType: newParameterType, calleeEnv: nextCalleeEnv } =
      evaluateFunctionParameterType({
        parameter,
        calleeEnv,
        context: {
          ...context,
        },
        functionValue,
      });
    parameterType = newParameterType;
    calleeEnv = nextCalleeEnv;
  }

  // Evaluate the argExpr
  let evaluatedArgExpr: Expr | undefined = undefined;
  let borrowings = context.borrowings;
  let evaluatedDefaultValueExpr: Expr | undefined = undefined;

  if (
    !argExpr ||
    (exprIsAtom(argExpr) && exprIsAtomOf(argExpr, BuiltinKeywords.undefined))
  ) {
    // Use the default value
    if (parameter.exprs.defaultValueExpr) {
      evaluatedArgExpr = context.evaluateExpression({
        expr: cloneExpr(parameter.exprs.defaultValueExpr),
        env: calleeEnv,
        context: {
          ...context,
        },
      });
      evaluatedDefaultValueExpr = evaluatedArgExpr;
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
          isMutable: false,
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
      evaluatedArgExpr = context.evaluateExpression({
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
    }
  }

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Failed to evaluate argument expression.`,
    });
  }

  // Check the borrowings
  if (
    evaluatedArgExpr.$.type &&
    (isMutRefType(evaluatedArgExpr.$.type) ||
      isRefType(evaluatedArgExpr.$.type))
  ) {
    checkBorrowings(context.borrowings, evaluatedArgExpr);

    // Add evaluated arg expr to the borrowings
    borrowings = borrowings.concat([
      {
        expr: evaluatedArgExpr,
        type: evaluatedArgExpr.$.type,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      },
    ]);
  }

  let argType = evaluatedArgExpr.$.type;

  // Cannot assign runtime parameter to compt parameter
  if (!evaluatedArgExpr.$?.value && parameter.isCompileTimeOnly) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Cannot assign runtime argument to compile-time parameter:\n${
        argExpr ? exprToString(argExpr) : ""
      }`,
    });
  }

  // Add the arg to the environment
  // console.log("(10) addVariableToEnv");
  let argValue = evaluatedArgExpr.$.value;
  if (!parameter.isCompileTimeOnly) {
    argValue = undefined;

    // argType requires compt modifier
    // but the parameter is not compt
    // we need to convert the argType to runtimeType
    // if (typeRequiresComptModifier(argType)) {
    argType = convertComptTypeToRuntimeType(argType, parameterType);

    if (typeRequiresComptModifier(argType)) {
      // We fail to convert to runtime type
      throw formatErrorMessage({
        token: argExpr?.token ?? PlaceholderToken,
        errorMessage: `Cannot convert compile-time type to runtime type for argument:\n${exprToString(
          evaluatedArgExpr
        )}`,
      });
    }
    // }
  }

  const { env: nextEnv } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: parameter.label,
      type: argType, // QUESTION: Should we use parameterType here or argType?
      // This might affect assigning Free type arg to Type parameter
      isMutable: parameter.isMutable,
      isCompileTimeOnly: parameter.isCompileTimeOnly,
      isImplicit: false,
      value: argValue,
      token: argExpr?.token ?? PlaceholderToken,
      initializedAtToken: argExpr?.token ?? PlaceholderToken,
      consumedAtToken: undefined,
    },
  });
  calleeEnv = nextEnv;

  // Set the arg expr as consumed
  // NOTE: If we evaluated the default value expression,
  // then we don't set the arg expr as consumed,
  // because that's the expression from parameter.exprs.defaultValueExpr
  if (!evaluatedDefaultValueExpr) {
    callerEnv = setExprAsConsumed(evaluatedArgExpr, callerEnv, context);
  }

  // Synthesize the types
  const { expectedEnv, givenEnv } = synthesizeTypes(
    { type: parameterType, env: calleeEnv },
    { type: argType, env: callerEnv }
  );
  calleeEnv = expectedEnv;
  callerEnv = givenEnv;

  // Evaluate the parameter type again
  const { parameterType: newParameterType, calleeEnv: nextCalleeEnv } =
    evaluateFunctionParameterType({
      parameter,
      calleeEnv,
      context: {
        ...context,
      },
      functionValue,
    });
  parameterType = newParameterType;
  calleeEnv = nextCalleeEnv;

  // Compare the types
  if (
    !areTypesCompatible(
      { type: parameterType, env: calleeEnv },
      { type: argType, env: callerEnv },
      // It's the receiver:
      argIndex === 0 && isMethodCall
    )
  ) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Type mismatch for parameter "${parameter.label}":
    Expected: ${typeToString(parameterType)}
    Got:   ${typeToString(argType)}`,
    });
  }
  return {
    calleeEnv,
    callerEnv,
    context: { ...context, borrowings },
    argValue,
    argType,
    parameterType: newParameterType,
  };
}
