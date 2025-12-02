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
import { createTypeHierarchy, ModuleField, ModuleType } from "../../types";
import { isModuleValue, isTypeValue, ModuleValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { checkTypeImplementsSelfConstraints } from "../exprs/subtype_of";
import { evaluateAnonymousModuleBeginExprs } from "../values/anonymous_module";

/**
 * Registry of types that have impl fields from a specific module path.
 * This allows cleanup when a module is re-evaluated or deleted.
 */
const implRegistry: Map<string, Set<ModuleType>> = new Map();

/**
 * Clear all impl fields from types that were added by the specified module.
 * Call this before re-evaluating a module to prevent duplicate impls.
 */
export function clearImplsFromModule(modulePath: string): void {
  const typesWithImpls = implRegistry.get(modulePath);
  if (!typesWithImpls) {
    return;
  }

  for (const moduleType of typesWithImpls) {
    moduleType.fields = moduleType.fields.filter(
      (field) => field.sourceModulePath !== modulePath
    );
  }

  implRegistry.delete(modulePath);
}

/**
 * Register that a type has an impl field from the specified module.
 */
function registerImpl(modulePath: string, moduleType: ModuleType): void {
  let types = implRegistry.get(modulePath);
  if (!types) {
    types = new Set();
    implRegistry.set(modulePath, types);
  }
  types.add(moduleType);
}

/**
 * Attach a module value to a receiver type's module with an empty label.
 * This allows method calls on values of the receiver type to find methods
 * from the implemented module, while preventing direct access by name.
 *
 * Note: clearImplsFromModule should be called before re-evaluating a module
 * to remove old impls. This function just adds the new impl.
 */
function attachModuleToReceiverType(
  moduleValue: ModuleValue,
  expr: Expr,
  sourceModulePath?: string
): void {
  const receiverType = moduleValue.type.receiverType;
  if (!receiverType || !receiverType.module) {
    return;
  }

  // Register this impl for cleanup on re-evaluation
  if (sourceModulePath) {
    registerImpl(sourceModulePath, receiverType.module);
  }

  // Create a field with empty label to attach the module
  const field: ModuleField = {
    label: "", // Empty label prevents direct access, only method calls work
    type: createTypeHierarchy(1), // Module type
    isCompileTimeOnly: true,
    assignedValue: moduleValue,
    sourceModulePath,
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

      // Check that the receiver type implements all selfConstraints from the module's where clause
      checkTypeImplementsSelfConstraints({
        targetType: receiverType,
        moduleType: moduleValue.type,
        env,
        errorToken: expr.token,
      });

      // Attach the module to the receiver type for method lookup
      attachModuleToReceiverType(moduleValue, expr, context.currentModulePath);

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

      // Check that the receiver type implements all selfConstraints from the module's where clause
      checkTypeImplementsSelfConstraints({
        targetType: receiverType,
        moduleType: moduleValue.type,
        env,
        errorToken: expr.token,
      });

      // Attach the module to the receiver type for method lookup
      attachModuleToReceiverType(moduleValue, expr, context.currentModulePath);

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
