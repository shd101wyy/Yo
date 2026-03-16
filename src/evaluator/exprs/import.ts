import { existsSync } from "fs";
import path from "path";
import type { Environment } from "../../env";
import { formatErrorMessage, YoError, YoLexerError } from "../../error";
import {
  BuiltinKeywords,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { resolveDependencyPath } from "../../fetch";
import { isComptimeStringValue } from "../../value";
import type { EvaluatorContext } from "../context";
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
  stdPath: string;
}): FnCallExpr {
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

  if (!isComptimeStringValue(value)) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Expected comptime_string for module path, got:\n${exprToString(moduleArg)}`,
    });
  }

  // Import the module
  let modulePathToImport = value.value; // Remove the quotes

  if (modulePathToImport.endsWith("prelude.yo")) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Directly importing module with name "prelude.yo" is not allowed.`,
    });
  }

  // Handle the std library path
  if (modulePathToImport.startsWith("std/")) {
    // std library
    modulePathToImport = path.relative(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      path.resolve(stdPath, modulePathToImport.replace("std/", "./"))
    );
    // Ensure it starts with "./" or "../" for consistency
    if (!modulePathToImport.startsWith(".")) {
      modulePathToImport = "./" + modulePathToImport;
    }
  } else if (modulePathToImport === "std") {
    // std library
    modulePathToImport = path.relative(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      path.resolve(stdPath, "./index.yo")
    ); // Let's set prelude.yo as the default for now
    // Ensure it starts with "./" or "../" for consistency
    if (!modulePathToImport.startsWith(".")) {
      modulePathToImport = "./" + modulePathToImport;
    }
  }

  if (!modulePathToImport.startsWith(".")) {
    // Try to resolve as a dependency name (e.g., "json-parser" → .yo-cache/deps/...)
    const currentFilePath = env.modulePath.replace(/^file:\/\//, "");
    const projectDir = findProjectRoot(currentFilePath);
    if (projectDir) {
      const depPath = resolveDependencyPath(projectDir, modulePathToImport);
      if (depPath) {
        // Resolve to the dependency's src/lib.yo or the root
        let entryPoint = depPath;
        const libYo = path.join(depPath, "src", "lib.yo");
        const indexYo = path.join(depPath, "index.yo");
        const rootYo = depPath + ".yo";
        if (existsSync(libYo)) {
          entryPoint = libYo;
        } else if (existsSync(indexYo)) {
          entryPoint = indexYo;
        } else if (existsSync(rootYo)) {
          entryPoint = rootYo;
        }
        // Convert to relative path from current module
        modulePathToImport = path.relative(
          path.dirname(currentFilePath),
          entryPoint
        );
        if (!modulePathToImport.startsWith(".")) {
          modulePathToImport = "./" + modulePathToImport;
        }
      }
    }

    // If still not relative after dependency resolution, it's an unknown module
    if (!modulePathToImport.startsWith(".")) {
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Module "${modulePathToImport}" not found. If this is a dependency, add it to build.yo and run 'yo fetch'.
${exprToString(expr)}`,
      });
    }
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
    // If no extension, try both <path>.yo and <path>/index.yo
    const yoFilePath = moduleAbsolutePath.replace(/^file:\/\//, "") + ".yo";
    const indexYoPath = path.join(
      moduleAbsolutePath.replace(/^file:\/\//, ""),
      "index.yo"
    );
    const yoFileExists = existsSync(yoFilePath);
    const indexYoExists = existsSync(indexYoPath);

    if (yoFileExists && indexYoExists) {
      // Ambiguous: both <path>.yo and <path>/index.yo exist
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Ambiguous import "${modulePathToImport}": both "${modulePathToImport}.yo" and "${modulePathToImport}/index.yo" exist. Use an explicit path to resolve the ambiguity.`,
      });
    } else if (yoFileExists) {
      moduleAbsolutePath = "file://" + yoFilePath;
    } else if (indexYoExists) {
      moduleAbsolutePath = "file://" + indexYoPath;
    } else {
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Module not found: tried "${"file://" + yoFilePath}" and "${indexYoPath}"`,
      });
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
      errorMessage: `Failed to import module "${modulePathToImport}":
${
  error instanceof YoError || error instanceof YoLexerError
    ? error.toString()
    : error instanceof Error
      ? error.message
      : String(error)
}`,
    });
  }
}

/**
 * Walk up the directory tree to find the project root.
 * Looks for `yo.lock` or `build.yo` as project root markers.
 */
function findProjectRoot(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (
      existsSync(path.join(dir, "yo.lock")) ||
      existsSync(path.join(dir, "build.yo"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}
