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
import {
  getBuildRegistry,
  getRootBuildProjectDir,
  getModuleImportRoot,
} from "../builtins/build";

/**
 * Safely convert an absolute target path to a relative path from a base directory.
 * On Windows, path.relative() between different drive letters (e.g., D:\ vs C:\)
 * returns the absolute target path unchanged. This helper detects that case and
 * returns the absolute path directly instead of a broken relative path.
 */
export function safeRelativePath(
  fromDir: string,
  toPath: string,
  pathModule: typeof path = path
): string {
  const relativePath = pathModule.relative(fromDir, toPath);
  if (pathModule.isAbsolute(relativePath)) {
    // Cross-drive on Windows: relative path is impossible, use absolute path
    return toPath;
  }
  if (!relativePath.startsWith(".")) {
    return "./" + relativePath;
  }
  return relativePath;
}

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
      errorMessage: `Expected comptime_str for module path, got:\n${exprToString(moduleArg)}`,
    });
  }

  // Import the module
  let modulePathToImport = value.value; // Remove the quotes

  if (
    modulePathToImport === "std/prelude" ||
    modulePathToImport === "std/prelude.yo"
  ) {
    throw formatErrorMessage({
      token: moduleArg.token,
      errorMessage: `Importing the prelude module is not allowed — it is automatically loaded for every file.`,
    });
  }

  // Handle the std library path
  if (modulePathToImport.startsWith("std/")) {
    // std library
    modulePathToImport = safeRelativePath(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      path.resolve(stdPath, modulePathToImport.replace("std/", "./"))
    );
  } else if (modulePathToImport === "std") {
    // std library
    modulePathToImport = safeRelativePath(
      path.dirname(env.modulePath.replace(/^file:\/\//, "")),
      path.resolve(stdPath, "./index.yo")
    );
  }

  if (
    !modulePathToImport.startsWith(".") &&
    !path.isAbsolute(modulePathToImport)
  ) {
    // Check module import roots first (from build.module() + add_import())
    const moduleRoot = getModuleImportRoot(modulePathToImport);
    if (moduleRoot) {
      const currentFilePath = env.modulePath.replace(/^file:\/\//, "");
      modulePathToImport = safeRelativePath(
        path.dirname(currentFilePath),
        moduleRoot
      );
    }
  }

  if (
    !modulePathToImport.startsWith(".") &&
    !path.isAbsolute(modulePathToImport)
  ) {
    // Try to resolve as a dependency name (e.g., "json-parser" → .yo-cache/deps/...)
    const currentFilePath = env.modulePath.replace(/^file:\/\//, "");
    const projectDir = findProjectRoot(currentFilePath);
    if (projectDir) {
      const resolveGitDependencyPath = (
        rootDir: string
      ): string | undefined => {
        try {
          return resolveDependencyPath(rootDir, modulePathToImport);
        } catch (error) {
          throw formatErrorMessage({
            token: moduleArg.token,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      };

      // Check path dependencies first (from build registry)
      const registry = getBuildRegistry();
      const pathDep = registry.findPathDependency(modulePathToImport);
      let depRoot: string | undefined;

      if (pathDep) {
        // Path dependency: resolve relative to project directory
        depRoot = path.resolve(projectDir, pathDep.path);
      } else {
        // Try git dependency via yo.lock cache
        depRoot = resolveGitDependencyPath(projectDir);
      }

      // Fallback: try the root build project directory for transitive deps
      // This handles the case where dep A's code imports dep B,
      // and dep B is in the root project's yo.lock (fetched transitively)
      if (!depRoot) {
        const rootDir = getRootBuildProjectDir();
        if (rootDir && rootDir !== projectDir) {
          depRoot = resolveGitDependencyPath(rootDir);
        }
      }

      if (depRoot) {
        // Resolve entry point: convention
        const entryPoint = resolveDependencyEntryPoint(
          depRoot,
          modulePathToImport
        );
        // Convert to relative path from current module
        modulePathToImport = safeRelativePath(
          path.dirname(currentFilePath),
          entryPoint
        );
      }
    }

    // If still not relative/absolute after dependency resolution, it's an unknown module
    if (
      !modulePathToImport.startsWith(".") &&
      !path.isAbsolute(modulePathToImport)
    ) {
      throw formatErrorMessage({
        token: moduleArg.token,
        errorMessage: `Module "${modulePathToImport}" not found. If this is a dependency, add it to build.yo and run 'yo fetch'.
${exprToString(expr)}`,
      });
    }
  }

  // TODO: Support other protocol like https://
  // If modulePathToImport is already absolute (e.g., Windows cross-drive std path),
  // use it directly. Otherwise resolve relative to the current module's directory.
  let moduleAbsolutePath =
    "file://" +
    (path.isAbsolute(modulePathToImport)
      ? modulePathToImport
      : path.resolve(
          path.dirname(env.modulePath.replace(/^file:\/\//, "")),
          modulePathToImport
        ));
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

/**
 * Resolve the entry point file for a dependency.
 *
 * Resolution order:
 * 1. Convention: index.yo → <name>.yo
 * 2. Fall back to the dependency root directory itself
 */
function resolveDependencyEntryPoint(depRoot: string, depName: string): string {
  // Convention-based fallback
  const indexYo = path.join(depRoot, "index.yo");
  const namedYo = path.join(depRoot, depName + ".yo");

  if (existsSync(indexYo)) return indexYo;
  if (existsSync(namedYo)) return namedYo;

  return depRoot;
}
