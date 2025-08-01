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
import {
  isLinearOrType0Type,
  ModuleElement,
  typeOfType,
  typeToString,
} from "../../types";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateModuleElementType } from "../types/module";

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

    const evaluatedCHeaderFileArg = context.evaluateExpression({
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

  const elements: ModuleElement[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const { type: element, env: nextEnv } = evaluateModuleElementType({
      expr: arg,
      env,
      moduleElementIndex: i,
      context: {
        ...context,
        SelfType: undefined, // No SelfType in module context
      },
    });

    // Check if there is duplicate labels
    const duplicateLabel = elements.find(
      (elem) => elem.label === element.label
    );
    if (duplicateLabel) {
      throw formatErrorMessage({
        token: exprIsFunctionCall(arg)
          ? (arg.args[0]?.token ?? arg.token)
          : arg.token,
        errorMessage: `Duplicate label "${element.label}" in module`,
      });
    }

    // Set the isExtern and cInclude for the element type
    element.type.isExtern = "c";
    element.type.cInclude = cHeaderFile;

    // Expect element to be compile-time only
    if (!element.isCompileTimeOnly) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compile-time only element for extern module, got ${exprToString(arg)}`,
      });
    }

    elements.push(element);
    env = nextEnv;

    // Prevent having Linear variables in "c" extern modules
    if (isLinearOrType0Type(element.type)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Cannot have "Linear" or "Type" type in "c" extern module.
Only "Free" is allowed.
Got ${typeToString(element.type)}`,
      });
    }
    if (isLinearOrType0Type(typeOfType(element.type))) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Cannot have "Linear" or "Type" value in "c" extern module.
Only "Free" is allowed.
Got ${typeToString(typeOfType(element.type))}`,
      });
    }

    // Add element to env
    const { env: nextNextEnv } = addVariableToEnv({
      env,
      variable: {
        name: element.label,
        type: element.type,
        value:
          element.assignedValue ??
          createUnknownValue(element.type, element.label),
        isCompileTimeOnly: element.isCompileTimeOnly,
        isImplicit: element.isImplicit,
        isMutable: false,
        token: element.exprs.expr.token,
        initializedAtToken: element.exprs.expr.token,
        consumedAtToken: undefined, // Not consumed yet
      },
    });
    env = nextNextEnv;
  }

  expr.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    isMutable: false,
  };

  // "extern" token
  expr.func.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    isMutable: false,
  };

  return expr;
}
