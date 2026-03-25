import { addVariableToEnv, type Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import type { ExternLanguage, ModuleField } from "../../types/definitions";
import {
  isFunctionType,
  isStructType,
  isEnumType,
  isUnionType,
  isTypeHierarchyType,
} from "../../types/guards";
import { VUnit } from "../../unit-value";
import {
  createUnknownValue,
  isComptimeStringValue,
  isTypeValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
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
        ...(field.label === "__yo_io_async"
          ? { ioBuiltin: "io_async" as const }
          : {}),
        ...(field.label === "__yo_io_await"
          ? { ioBuiltin: "io_await" as const }
          : {}),
        ...(field.label === "__yo_io_state"
          ? { ioBuiltin: "io_state" as const }
          : {}),
        ...(field.label === "__yo_io_spawn"
          ? { ioBuiltin: "io_spawn" as const }
          : {}),
        ...(field.label === "__yo_join_handle_await"
          ? { ioBuiltin: "join_handle_await" as const }
          : {}),
      };
    } else {
      field.type = { ...field.type, isExtern: language };
    }

    // When a field has an assigned type value (e.g., (Color : Type) = struct(r: u8, ...)),
    // propagate extern metadata to the underlying type so codegen uses the extern name
    // instead of generating a mangled __yo_<id> name and struct definition.
    if (
      field.assignedValue &&
      isTypeValue(field.assignedValue) &&
      (isStructType(field.assignedValue.value) ||
        isEnumType(field.assignedValue.value) ||
        isUnionType(field.assignedValue.value))
    ) {
      const underlyingType = field.assignedValue.value;
      underlyingType.isExtern = language;
      underlyingType.externName = field.label;
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
