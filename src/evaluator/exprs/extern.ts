import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { ExternLanguage, ModuleField } from "../../types/definitions";
import { isFunctionType, isTypeHierarchyType } from "../../types/guards";
import { VUnit } from "../../unit-value";
import { createUnknownValue, isComptimeStringValue } from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { evaluateModuleField } from "../types/module";

export function evaluateExtern({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
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

    const evaluatedLang = evaluateExpression({
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
    if (!isComptimeStringValue(langValue)) {
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

    // Set the isExtern for the field type
    // IMPORTANT: Create a copy of the type to avoid mutating cached types
    // (e.g., the shared Type(0) object from createType0())
    // Only set externName for:
    // - type declarations (e.g., `libc_FILE : Type`)
    // - function declarations (e.g., `__yo_malloc : fn(...) -> ...`)
    // NOT for variable declarations with primitive types (e.g., `__yo_argc : i32`)
    if (isTypeHierarchyType(field.type) || isFunctionType(field.type)) {
      field.type = {
        ...field.type,
        isExtern: language,
        externName: field.label,
      };
    } else {
      field.type = { ...field.type, isExtern: language };
    }

    fields.push(field);
    env = nextEnv;

    // Add field to env
    const { env: nextNextEnv } = addVariableToEnv({
      env,
      variable: {
        name: field.label,
        type: field.type,
        value: [
          field.assignedValue ??
            createUnknownValue(field.type, {
              variableName: field.label,
              env,
              context,
            }),
        ],
        isCompileTimeOnly: true,
        token: field.exprs.expr.token,
        initializedAtToken: field.exprs.expr.token,
        consumedAtToken: undefined, // Not consumed yet
        isOwningTheRcValue: false,
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
