import type { Location } from "vscode-languageserver";
import type { Environment } from "../env";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { TokenType, type Token } from "../token";
import { isModuleValue, type ModuleValue } from "../value";
import type { LspDocumentManager } from "./document-manager";
import {
  findTokenAtPosition,
  findBestExpressionMatch,
  modulePathToUri,
} from "./utils";

/**
 * Handle textDocument/definition requests.
 */
export function handleDefinition(
  uri: string,
  line: number,
  character: number,
  docManager: LspDocumentManager
): Location | null {
  let module = docManager.getModule(uri);
  if (!module || module.moduleError) {
    const fallback = docManager.getLastGoodModule(uri);
    if (fallback) {
      module = fallback;
    } else if (!module) {
      return null;
    }
  }

  const exprs = module.evaluator.getProgram();
  const tokens = module.evaluator.getTokens();

  const tokenAtPosition = findTokenAtPosition(tokens, line, character);

  if (!tokenAtPosition) {
    return null;
  }

  // Check if this is an import path string — go to the imported module file
  if (tokenAtPosition.type === TokenType.String) {
    const importLocation = findImportDefinition(exprs, tokenAtPosition);
    if (importLocation) return importLocation;
  }

  const foundExpr = findBestExpressionMatch(exprs, tokenAtPosition, line);

  if (!foundExpr || !exprIsAtom(foundExpr)) {
    return null;
  }

  const expr: AtomExpr = foundExpr;
  const env = expr.$?.env;

  if (!env) {
    return null;
  }

  const tokenText = tokenAtPosition.value;
  const foundDefinition = findVariableDefinition(env, tokenText);

  if (!foundDefinition) {
    return null;
  }

  const { definitionToken, definitionModulePath } = foundDefinition;
  const defUri = modulePathToUri(definitionModulePath);

  return {
    uri: defUri,
    range: {
      start: {
        line: definitionToken.position.row,
        character: definitionToken.position.column,
      },
      end: {
        line: definitionToken.position.row,
        character:
          definitionToken.position.column + definitionToken.value.length,
      },
    },
  };
}

/**
 * Find the location of an imported module from an import path string token.
 * Walks the AST looking for import("path") calls containing the target token,
 * then extracts the resolved module path from the import expression's value.
 */
function findImportDefinition(
  exprs: Expr[],
  stringToken: Token
): Location | null {
  let result: Location | null = null;

  const search = (expr: Expr) => {
    if (result) return;
    if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      // Check if this is import("...") where the string arg matches our token
      if (
        exprIsAtom(funcCallExpr.func) &&
        (funcCallExpr.func as AtomExpr).token.value === "import" &&
        funcCallExpr.args.length >= 1
      ) {
        const importArg = funcCallExpr.args[0]!;
        if (
          exprIsAtom(importArg) &&
          (importArg as AtomExpr).token.position.row ===
            stringToken.position.row &&
          (importArg as AtomExpr).token.position.column ===
            stringToken.position.column
        ) {
          // The import expression's value should be a ModuleValue
          // which has an env with the resolved module path
          const importValue = funcCallExpr.$?.value;
          if (importValue && isModuleValue(importValue)) {
            const modulePath = importValue.type.env.modulePath;
            if (modulePath) {
              result = {
                uri: modulePathToUri(modulePath),
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              };
              return;
            }
          }
        }
      }
      search(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        search(arg);
      }
    }
  };

  for (const expr of exprs) {
    search(expr);
  }
  return result;
}

/**
 * Search through environment frames to find a variable definition.
 */
function findVariableDefinition(
  env: Environment,
  variableName: string
): { definitionToken: Token; definitionModulePath: string } | null {
  try {
    // Search local scopes
    for (
      let frameIndex = env.frames.length - 1;
      frameIndex >= 0;
      frameIndex--
    ) {
      const frame = env.frames[frameIndex];
      if (frame?.variables) {
        for (const variable of frame.variables) {
          if (variable.name === variableName) {
            return {
              definitionToken: variable.token,
              definitionModulePath: variable.token.modulePath,
            };
          }
        }
      }
    }

    // Search module values for the symbol
    for (
      let frameIndex = env.frames.length - 1;
      frameIndex >= 0;
      frameIndex--
    ) {
      const frame = env.frames[frameIndex];
      if (frame?.variables) {
        for (const variable of frame.variables) {
          if (variable.value && isModuleValue(variable.value[0])) {
            const moduleValue = variable.value[0] as ModuleValue;
            if (moduleValue.type && moduleValue.type.fields) {
              for (const element of moduleValue.type.fields) {
                if (element && element.label === variableName) {
                  return {
                    definitionToken: element.exprs.expr.token,
                    definitionModulePath: element.exprs.expr.token.modulePath,
                  };
                }
              }
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
