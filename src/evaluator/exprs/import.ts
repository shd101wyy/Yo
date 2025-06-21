import path from "path";
import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";

/**
 *
 * Import a module
 *
 */
export function evaluateImport({
  expr,
  env,
  context,
  stdPath,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
  stdPath: string;
}): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.import, 1)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "import" with 1 argument, got:\n${exprToString(expr)}`,
    });
  }

  const moduleArg = expr.args[0]!;
  // TODO: Support comptime string
  // Evaluate the moduleArg
  const evaluatedModuleArg = context.evaluateExpression({
    expr: moduleArg,
    env,
    context: {
      ...context,
    },
  });
  const value = evaluatedModuleArg.$?.value;

  if (!isComptStringValue(value)) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Expected compt_string for module path, got:\n${exprToString(moduleArg)}`,
    });
  }

  // Import the module
  let modulePathToImport = value.value; // Remove the quotes

  // Handle the std library path
  if (modulePathToImport.startsWith("std/")) {
    // std library
    modulePathToImport = path.relative(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      path.resolve(stdPath, modulePathToImport.replace("std/", "./"))
    );
  } else if (modulePathToImport === "std") {
    // std library
    modulePathToImport = path.relative(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      path.resolve(stdPath, "./index.yo")
    ); // Let's set prelude.yo as the default for now
  }

  if (!modulePathToImport.startsWith(".")) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: "Only local relative path is supported for now",
    });
  }
  // TODO: Support other protocol like https://
  let moduleAbsolutePath =
    "file://" +
    path.resolve(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      modulePathToImport
    );
  const extname = path.extname(moduleAbsolutePath);
  if (!extname) {
    // TODO: Check if the index.yo file exists
    // If no extension, assume it's a module directory and append index.yo
    // If no such file, throw an error
    moduleAbsolutePath = moduleAbsolutePath + ".yo";
  } else if (extname !== ".yo") {
    throw new Error("Only .yo file is supported for now");
  }

  try {
    // Load the module
    const { moduleValue } = context.loadModule(moduleAbsolutePath);
    expr.$ = {
      env,
      type: moduleValue.type,
      value: moduleValue,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  } catch (error) {
    // Failed to load the module
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Failed to import module "${modulePathToImport}":\n${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
