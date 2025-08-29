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
import { ExternLanguage, ModuleElement } from "../../types";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateModuleElementType } from "../types/module";

export function evaluateExtern({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.extern)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected extern, got ${expr.tag}`,
    });
  }

  let language: ExternLanguage = "yo"; // Default to "yo"
  let args = expr.args;
  if (expr.args[0] && exprIsAtom(expr.args[0])) {
    // Evaluate the language argument
    const langArg = expr.args[0]!;
    args = expr.args.slice(1);

    const evaluatedLang = context.evaluateExpression({
      expr: langArg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedLang.$ || !evaluatedLang.$.value) {
      throw formatErrorMessage({
        token: langArg.token,
        errorMessage: `Failed to evaluate language argument: ${exprToString(langArg)}`,
      });
    }
    env = evaluatedLang.$.env;
    const langValue = evaluatedLang.$.value;
    if (!isComptStringValue(langValue)) {
      throw formatErrorMessage({
        token: langArg.token,
        errorMessage: `Expected string for language argument, got ${exprToString(langArg)}`,
      });
    }
    if (langValue.value.toLocaleLowerCase() === "yo") {
      language = "yo";
    } else if (langValue.value.toLocaleLowerCase() === "c") {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      language = "c";
    } else {
      throw formatErrorMessage({
        token: langArg.token,
        errorMessage: `Unsupported language "${langValue.value}" for extern, expected "c" or "yo"`,
      });
    }
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

    // Set the isExtern for the element type
    element.type.isExtern = language;

    // Expect element to be compile-time only
    if (!element.isCompileTimeOnly) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Expected compile-time only element for extern module, got ${exprToString(arg)}`,
      });
    }

    elements.push(element);
    env = nextEnv;

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
    pathCollection: [],
  };

  // "extern" token
  expr.func.$ = {
    env,
    value: VUnit,
    type: VUnit.type,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
