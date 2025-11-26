import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
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
 *
 * Example:
 *   Id :: module(id : (fn(self : Self) -> Self));
 *   ImplId :: Impl(Id);
 *   // Or with custom label:
 *   ImplId :: Impl(MyId : Id);
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

  const requiredModules: { label: string; moduleType: ModuleType }[] = [];

  // Evaluate each argument and expect them to be module types
  for (const arg of expr.args) {
    let label: string;
    let moduleExpr = arg;

    // Check if this is a labeled argument: `Label : ModuleType`
    if (exprIsFunctionCallOf(arg, ":", 2)) {
      const labelExpr = (arg as FuncCallExpr).args[0]!;
      const valueExpr = (arg as FuncCallExpr).args[1]!;

      if (!exprIsAtom(labelExpr)) {
        throw formatErrorMessage({
          token: labelExpr.token,
          errorMessage: `Expected identifier for Impl label, got: ${exprToString(labelExpr)}`,
        });
      }

      label = labelExpr.token.value;
      moduleExpr = valueExpr;
    } else if (exprIsAtom(arg)) {
      // Use the atom name as the label
      label = arg.token.value;
    } else {
      // Fallback to a generated label
      label = `__required_module_${requiredModules.length}`;
    }

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

    requiredModules.push({ label, moduleType: evaluatedArg.$.value.value });
  }

  // Create a SomeType with the required modules
  const someType = createSomeType(
    createType0(),
    "Impl", // Name for the SomeType
    undefined,
    requiredModules
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
