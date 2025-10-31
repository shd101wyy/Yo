import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isModuleValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateAnonymousModuleBeginExprs } from "../values/anonymous_module";

export function evaluateModuleValue({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.impl)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "impl", got:\n${exprToString(expr)}`,
    });
  }

  // Anonymous module value
  if (
    expr.args.length === 1 &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.begin)
  ) {
    const beginExprs = expr.args[0]!.args;
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
      pathCollection: [],
    };

    return expr;
  }
  // Impl a module for a type
  else if (expr.args.length === 2) {
    const receiverTypeArg = expr.args[0]!;
    const moduleCallArg = expr.args[1]!;

    // Evaluate the receiver type
    const evaluatedReceiverTypeArg = evaluateExpression({
      expr: receiverTypeArg,
      env,
      context: {
        ...context,
      },
    });

    // Expect the receiver type to be a type
    if (
      !evaluatedReceiverTypeArg.$ ||
      !evaluatedReceiverTypeArg.$.value ||
      !isTypeValue(evaluatedReceiverTypeArg.$.value)
    ) {
      throw formatErrorMessage({
        token: receiverTypeArg.token,
        errorMessage: `Expected type for receiver type argument.`,
      });
    }
    env = evaluatedReceiverTypeArg.$.env;
    const receiverType = evaluatedReceiverTypeArg.$.value.value;

    // Evaluate the module call
    const evaluatedModuleCallArg = evaluateExpression({
      expr: moduleCallArg,
      env,
      context: {
        ...context,
        expectedType: undefined,
        ReceiverType: receiverType,
      },
    });
    // Expect the module call to be a module value
    if (
      !evaluatedModuleCallArg.$ ||
      !isModuleValue(evaluatedModuleCallArg.$.value)
    ) {
      throw formatErrorMessage({
        token: moduleCallArg.token,
        errorMessage: `Expected module value for module call argument.`,
      });
    }
    env = evaluatedModuleCallArg.$.env;
    const moduleValue = evaluatedModuleCallArg.$.value;

    // Set the module value to the expr
    expr.$ = {
      env,
      type: evaluatedModuleCallArg.$.type,
      value: moduleValue,
      pathCollection: [],
    };

    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Invalid module implementation, expected a "begin" block, got:\n${exprToString(expr)}`,
    });
  }
}
