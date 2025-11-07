import path from "node:path";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { createModuleType, ModuleField } from "../../types";
import { VUnit } from "../../unit-value";
import { isTypeValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateTypeField } from "../types/field";

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
      errorMessage: `Expected __yo_type_set_module function call with at least 2 arguments, got ${expr.args.length}`,
    });
  }

  if (!exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_type_set_module)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected __yo_type_set_module function call`,
    });
  }

  // Restrict __yo_type_set_module to only be callable within std/prelude.yo
  if (context.stdPath) {
    const preludePath = "file://" + path.join(context.stdPath, "prelude.yo");
    const isPrelude = env.modulePath === preludePath;

    if (!isPrelude) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_type_set_module can only be called within std/prelude.yo. Current module: ${env.modulePath}`,
      });
    }
  }

  const typeExpr = expr.args[0]!;

  const evaluatedTypeExpr = evaluateExpression({
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

  /// if (extendedTypes.has(targetType.id)) {
  ///   throw formatErrorMessage({
  ///     token: typeExpr.token,
  ///     errorMessage: `Type "${typeToString(targetType)}" has already been extended with __yo_type_set_module. Cannot extend a type more than once.`,
  ///   });
  /// }

  /// if (targetType.module) {
  ///   throw formatErrorMessage({
  ///     token: typeExpr.token,
  ///     errorMessage: `Type "${typeToString(targetType)}" already has a module. Cannot extend it again.`,
  ///   });
  /// }

  const moduleType = createModuleType(env);
  targetType.module = moduleType;

  for (let i = 1; i < expr.args.length; i++) {
    const arg = expr.args[i]!;

    const { field, env: nextEnv } = evaluateTypeField({
      expr: arg,
      env,
      tupleFieldIndex: i - 1,
      context: { ...context, SelfType: targetType },
      forType: "struct",
    });

    if (!field.isCompileTimeOnly) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `All fields in __yo_type_set_module must be compile-time only (use :: syntax). Got runtime field: ${field.label}`,
      });
    }

    if (!field.assignedValue) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Compile-time only field "${field.label}" must have an assigned value in type module extension.`,
      });
    }

    const duplicateLabel = moduleType.fields.find(
      (elem) => elem.label === field.label
    );
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Duplicate label "${field.label}" in type module extension`,
      });
    }

    moduleType.fields.push(field as ModuleField);
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
