import { existsSync } from "fs";
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
import { evaluateExpression } from "../exprs/expr";

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
  const evaluatedModuleArg = evaluateExpression({
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
      errorMessage: `Only local relative path is supported for now:
${exprToString(expr)}
${modulePathToImport}`,
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
    // If no extension, assume it's a .yo file
    // If no such file exists, then assume it's a directory with index.yo and check again
    moduleAbsolutePath = moduleAbsolutePath + ".yo";
    // Check if the .yo file exists
    if (!existsSync(moduleAbsolutePath.replace(/^file:\/\//, ""))) {
      // Try index.yo in the directory
      const indexYoPath = path.join(
        moduleAbsolutePath.replace(/^file:\/\//, "").replace(/\.yo$/, ""),
        "index.yo"
      );
      if (existsSync(indexYoPath)) {
        moduleAbsolutePath = "file://" + indexYoPath;
      } else {
        throw formatErrorMessage({
          token: moduleArg.token,
          errorMessage: `Module not found: tried "${moduleAbsolutePath}" and "${indexYoPath}"`,
        });
      }
    }
  }
  // NOTE: Let's not check this, because the file might be "module.test",
  // here nodejs will say its extname is ".test", which is not ".yo"
  // but the real file is "module.test.yo" which is valid
  /*
  else if (extname !== ".yo") {
    throw new Error("Only .yo file is supported for now");
  }
  */
  if (!context.loadModule) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Module loader is not provided in the context.`,
    });
  }

  try {
    // Load the module
    const { moduleValue } = context.loadModule(moduleAbsolutePath);
    expr.$ = {
      env,
      type: moduleValue.type,
      value: moduleValue,
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
