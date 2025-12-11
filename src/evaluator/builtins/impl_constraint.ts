import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createSomeType,
  createType0,
  isModuleType,
  ModuleType,
} from "../../types";
import { createTypeValue, isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluates the `Impl(module1, module2, ...)` syntax.
 * Creates a SomeType whose module contains the given module constraints.
 * Supports negated modules with `!(Module)` syntax.
 *
 * Example:
 *   Id :: module(id : (fn(ref(self) : Self) -> Self));
 *   ImplId :: Impl(Id);
 *   ImplIdNotCopy :: Impl(Id, !(Copy));  // Must implement Id but NOT Copy
 *
 * ImplId is a SomeType that requires types to implement the Id module.
 */
export function evaluateImplConstraint({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Impl)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "Impl", got:\n${exprToString(expr)}`,
    });
  }

  if (expr.args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Impl requires at least one module argument.`,
    });
  }

  const requiredModules: ModuleType[] = [];
  const negativeModules: ModuleType[] = [];

  // Evaluate each argument and expect them to be module types
  // Support negated modules with !(Module) syntax
  for (const arg of expr.args) {
    // Check if this is a negated module: !(Module)
    const isNegated =
      exprIsFunctionCall(arg) &&
      exprIsFunctionCallOf(arg, "!") &&
      arg.args.length === 1;

    const moduleExpr = isNegated ? arg.args[0]! : arg;

    const evaluatedArg = evaluateExpression({
      expr: moduleExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Failed to evaluate Impl argument.`,
      });
    }
    env = evaluatedArg.$.env;

    // Expect the argument to be a type value containing a module type
    if (
      !evaluatedArg.$.value ||
      !isTypeValue(evaluatedArg.$.value) ||
      !isModuleType(evaluatedArg.$.value.value)
    ) {
      throw formatErrorMessage({
        token: moduleExpr.token,
        errorMessage: `Impl argument must be a module type, got: ${exprToString(moduleExpr)}`,
      });
    }

    if (isNegated) {
      negativeModules.push(evaluatedArg.$.value.value);
    } else {
      requiredModules.push(evaluatedArg.$.value.value);
    }
  }

  // Create a SomeType with the required and negative modules
  const someType = createSomeType(
    createType0(),
    "Impl", // Name for the SomeType
    undefined,
    requiredModules,
    negativeModules
  );

  const typeValue = createTypeValue(someType);

  expr.$ = {
    env,
    type: typeValue.type,
    value: typeValue,
    pathCollection: [],
  };

  return expr;
}
