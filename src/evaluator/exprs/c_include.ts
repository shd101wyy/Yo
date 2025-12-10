import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { ModuleField } from "../../types";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateModuleField } from "../types/module";

export function evaluateCInclude({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.c_include)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected c_include, got ${expr.tag}`,
    });
  }

  let cHeaderFile: string | undefined = undefined;
  let args = expr.args;
  if (expr.args[0] && exprIsAtom(expr.args[0])) {
    // Evaluate the language argument
    const cHeaderFileArg = expr.args[0]!;
    args = expr.args.slice(1);

    const evaluatedCHeaderFileArg = evaluateExpression({
      expr: cHeaderFileArg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedCHeaderFileArg.$ || !evaluatedCHeaderFileArg.$.value) {
      throw formatErrorMessage({
        token: cHeaderFileArg.token,
        errorMessage: `Failed to evaluate C header file argument: ${exprToString(cHeaderFileArg)}`,
      });
    }
    env = evaluatedCHeaderFileArg.$.env;
    const cHeaderFileValue = evaluatedCHeaderFileArg.$.value;
    if (!isComptStringValue(cHeaderFileValue)) {
      throw formatErrorMessage({
        token: cHeaderFileArg.token,
        errorMessage: `Expected string for C header file argument, got ${exprToString(cHeaderFileArg)}`,
      });
    }
    cHeaderFile = cHeaderFileValue.value;
  }

  if (!cHeaderFile) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected C header file as first argument to c_include, such as:
      
c_include "<stdio.h>" ...;`,
    });
  }

  const fields: ModuleField[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const { field: field, env: nextEnv } = evaluateModuleField({
      expr: arg,
      env,
      moduleFieldIndex: i,
      context: {
        ...context,
        SelfType: undefined, // No SelfType in module context
      },
      isForEvaluatingModuleType: false,
    });

    // Check if there is duplicate labels
    const duplicateLabel = fields.find((elem) => elem.label === field.label);
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Duplicate label "${field.label}" in module`,
      });
    }

    // Set the isExtern and cInclude for the field type
    // IMPORTANT: Create a copy of the type to avoid mutating cached types
    // (e.g., the shared Type(0) object from createType0())
    field.type = { ...field.type, isExtern: "c", cInclude: cHeaderFile };

    // Expect field to be compile-time only
    if (!field.isCompileTimeOnly) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compile-time only field for extern module, got ${exprToString(arg)}`,
      });
    }

    fields.push(field);
    env = nextEnv;

    // No linear type restrictions needed anymore

    // Add field to env
    const { env: nextNextEnv } = addVariableToEnv({
      env,
      variable: {
        name: field.label,
        type: field.type,
        value:
          field.assignedValue ?? createUnknownValue(field.type, field.label),
        isCompileTimeOnly: field.isCompileTimeOnly,
        token: field.exprs.expr.token,
        initializedAtToken: field.exprs.expr.token,
        consumedAtToken: undefined, // Not consumed yet
      },
    });
    env = nextNextEnv;
  }

  expr.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    pathCollection: [],
  };

  // "extern" token
  expr.func.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    pathCollection: [],
  };

  return expr;
}
