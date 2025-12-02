import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createTypeHierarchy, ModuleField } from "../../types";
import { isModuleValue, isTypeValue, ModuleValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateAnonymousModuleBeginExprs } from "../values/anonymous_module";

/**
 * Attach a module value to a receiver type's module with an empty label.
 * This allows method calls on values of the receiver type to find methods
 * from the implemented module, while preventing direct access by name.
 */
function attachModuleToReceiverType(
  moduleValue: ModuleValue,
  expr: Expr
): void {
  const receiverType = moduleValue.type.receiverType;
  if (!receiverType || !receiverType.module) {
    return;
  }

  // Create a field with empty label to attach the module
  const field: ModuleField = {
    label: "", // Empty label prevents direct access, only method calls work
    type: createTypeHierarchy(1), // Module type
    isCompileTimeOnly: true,
    assignedValue: moduleValue,
    exprs: {
      expr,
    },
  };

  // Add the field to the receiver type's module
  receiverType.module.fields.push(field);
}

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

    // Anonymous module value
    if (
      exprIsFunctionCall(expr.args[1]) &&
      exprIsFunctionCallOf(expr.args[1], BuiltinKeywords.begin)
    ) {
      const beginExprs = expr.args[1]!.args;
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
        receiverType,
      });
      env = nextEnv;

      // Attach the module to the receiver type for method lookup
      attachModuleToReceiverType(moduleValue, expr);

      // Set the module value to the expr
      expr.$ = {
        env,
        type: moduleType,
        value: moduleValue,
        pathCollection: [],
      };

      return expr;
    } else {
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

      // Attach the module to the receiver type for method lookup
      attachModuleToReceiverType(moduleValue, expr);

      // Set the module value to the expr
      expr.$ = {
        env,
        type: evaluatedModuleCallArg.$.type,
        value: moduleValue,
        pathCollection: [],
      };

      return expr;
    }
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Invalid module implementation, expected a "begin" block, got:\n${exprToString(expr)}`,
    });
  }
}
