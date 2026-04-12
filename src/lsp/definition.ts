import type { Location } from "vscode-languageserver";
import type { Environment } from "../env";
import { type AtomExpr, exprIsAtom } from "../expr";
import type { Token } from "../token";
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
