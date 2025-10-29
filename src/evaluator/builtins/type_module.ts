import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  createModuleType,
  ModuleElement,
  PrimitiveTypes,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateElementType } from "../types/element";

// NOTE: Checking this currently has some problem for vscode extension.
// const extendedTypes = new Set<string>();

function isPrimitiveType(typeId: string): boolean {
  return Object.values(PrimitiveTypes).some(
    (primType) => primType.id === typeId
  );
}

export function evaluateYoSetTypeModule({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (expr.args.length < 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected __yo_set_type_module function call with at least 2 arguments, got ${expr.args.length}`,
    });
  }

  if (!exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_set_type_module)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected __yo_set_type_module function call`,
    });
  }

  const typeExpr = expr.args[0]!;

  const evaluatedTypeExpr = context.evaluateExpression({
    expr: typeExpr,
    env,
    context,
  });

  if (!evaluatedTypeExpr.$) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Failed to evaluate type expression: ${exprToString(typeExpr)}`,
    });
  }

  env = evaluatedTypeExpr.$.env;
  const typeValue = evaluatedTypeExpr.$.value;

  if (!isTypeValue(typeValue)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `Expected a type value, got: ${exprToString(typeExpr)}`,
    });
  }

  const targetType = typeValue.value;

  if (!isPrimitiveType(targetType.id)) {
    throw formatErrorMessage({
      token: typeExpr.token,
      errorMessage: `__yo_set_type_module can only be used to extend primitive types. Type "${typeToString(targetType)}" is not a primitive type.`,
    });
  }

  /// if (extendedTypes.has(targetType.id)) {
  ///   throw formatErrorMessage({
  ///     token: typeExpr.token,
  ///     errorMessage: `Type "${typeToString(targetType)}" has already been extended with __yo_set_type_module. Cannot extend a type more than once.`,
  ///   });
  /// }

  /// if (targetType.module) {
  ///   throw formatErrorMessage({
  ///     token: typeExpr.token,
  ///     errorMessage: `Type "${typeToString(targetType)}" already has a module. Cannot extend it again.`,
  ///   });
  /// }

  const moduleType = createModuleType(env);

  for (let i = 1; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    const { type, env: nextEnv } = evaluateElementType({
      expr: arg,
      env,
      tupleElementIndex: i - 1,
      context: { ...context, SelfType: targetType },
      forType: "struct",
    });

    if (!type.isCompileTimeOnly) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `All elements in __yo_set_type_module must be compile-time only (use :: syntax). Got runtime element: ${type.label}`,
      });
    }

    const duplicateLabel = moduleType.elements.find(
      (element) => element.label === type.label
    );
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Duplicate label "${type.label}" in type module extension`,
      });
    }

    moduleType.elements.push(type as ModuleElement);
    env = nextEnv;
  }

  targetType.module = moduleType;

  /// extendedTypes.add(targetType.id);

  expr.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    pathCollection: [],
  };

  return expr;
}
