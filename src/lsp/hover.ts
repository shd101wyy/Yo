import type { Hover } from "vscode-languageserver";
import { MarkupKind } from "vscode-languageserver";
import { getVariablesFromEnv, type Environment } from "../env";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  ExprTag,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "../expr";
import { stringIsOperator, TokenType } from "../token";
import type { StructType } from "../types/definitions";
import { isStructType } from "../types/guards";
import { typeToString } from "../types/utils";
import { valueToString } from "../value";
import { ValueTag } from "../value-tag";
import type { LspDocumentManager } from "./document-manager";
import { findTokenAtPosition, findBestExpressionMatch } from "./utils";

/**
 * Handle textDocument/hover requests.
 */
export function handleHover(
  uri: string,
  line: number,
  character: number,
  docManager: LspDocumentManager
): Hover | null {
  const module = docManager.getModule(uri);
  if (!module || module.moduleError) {
    return null;
  }

  const exprs = module.evaluator.getProgram();
  const tokens = module.evaluator.getTokens();

  const tokenAtPosition = findTokenAtPosition(tokens, line, character);

  if (!tokenAtPosition) {
    return null;
  }

  // Find an expression with matching token
  let foundExpr = findBestExpressionMatch(exprs, tokenAtPosition, line);

  // If no exact expression match, try to find variable in scope using fallback
  if (!foundExpr && tokenAtPosition.type === TokenType.Identifier) {
    foundExpr = findVariableByFallback(exprs, tokenAtPosition);
  }

  if (!foundExpr || !exprIsAtom(foundExpr)) {
    return null;
  }

  const expr: AtomExpr = foundExpr;
  let tokenText = exprToString(expr);
  if (stringIsOperator(tokenText)) {
    tokenText = `(${tokenText})`;
  }

  // Get variable from the env
  let varType = expr.$?.type;
  let varValue = expr.$?.value;
  let isUndefined = false;
  let foundVariable = false;
  let isCompileTimeOnly = false;
  let varDocComment: string | undefined;

  if (expr.$?.env) {
    const variables = getVariablesFromEnv(expr.$.env, expr.token.value);
    foundVariable = variables !== undefined && variables.length > 0;

    if (foundVariable && variables) {
      const selectedVar = variables[variables.length - 1]!;
      varType = selectedVar.type;
      varValue = selectedVar.value?.[0];
      isCompileTimeOnly = selectedVar.isCompileTimeOnly;
      isUndefined = !selectedVar.initializedAtToken;
      varDocComment = selectedVar.docComment;
    }
  }

  if (isCompileTimeOnly) {
    tokenText = `comptime(${tokenText})`;
  }

  // Build markdown hover content
  let content = "```\n" + tokenText;

  if (varType) {
    const typeString = typeToString(varType);
    content += `\n: ${typeString}`;
  }

  if (foundVariable && isUndefined) {
    content += "\nundefined";
  } else {
    const valueString = valueToString(varValue);
    if (varValue?.tag === ValueTag.Type) {
      content += `\n= ${valueString}`;
    } else {
      content += `\n= ${valueString}`;
    }
  }

  content += "\n```";

  // Append doc comment — also check struct field doc comments for property access
  let docComment = varDocComment ?? expr.$?.docComment;
  if (!docComment) {
    docComment = findFieldDocComment(exprs, expr);
  }
  if (docComment) {
    content += "\n\n---\n\n" + docComment;
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: content,
    },
    range: {
      start: {
        line: tokenAtPosition.position.row,
        character: tokenAtPosition.position.column,
      },
      end: {
        line: tokenAtPosition.position.row,
        character:
          tokenAtPosition.position.column + tokenAtPosition.value.length,
      },
    },
  };
}

/**
 * Fallback: find a variable by walking exprs for the most recent env, then
 * looking up the variable name in that env.
 */
function findVariableByFallback(
  exprs: Expr[],
  targetToken: { value: string; position: { row: number }; type: TokenType }
): AtomExpr | null {
  let bestEnv: Environment | null = null;
  let bestExprPosition = -1;

  const findBestEnv = (expr: Expr) => {
    if (exprIsAtom(expr)) {
      if (
        expr.$?.env &&
        expr.token.position.row < targetToken.position.row &&
        expr.token.position.row > bestExprPosition
      ) {
        bestEnv = expr.$.env;
        bestExprPosition = expr.token.position.row;
      }
    } else if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      findBestEnv(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        findBestEnv(arg);
      }
    }
  };

  for (const expr of exprs) {
    findBestEnv(expr);
  }

  if (!bestEnv) {
    return null;
  }

  try {
    const variables = getVariablesFromEnv(bestEnv, targetToken.value);
    if (!variables || variables.length === 0) {
      return null;
    }

    const localVariables = variables.filter((variable) => {
      if (variable.initializedAtToken) {
        const varRow = variable.initializedAtToken.position.row;
        return varRow > 2 && varRow < targetToken.position.row;
      }
      return false;
    });

    if (localVariables.length === 0) {
      return null;
    }

    const selectedVariable = localVariables[localVariables.length - 1];
    if (!selectedVariable?.type) {
      return null;
    }

    return {
      tag: ExprTag.Atom,
      token: targetToken as AtomExpr["token"],
      $: {
        type: selectedVariable.type,
        value: selectedVariable.value?.[0],
        env: bestEnv,
        pathCollection: [],
      },
    } as AtomExpr;
  } catch {
    return null;
  }
}

/**
 * Find the doc comment for a struct field when hovering over a property access
 * like `p1.x`. Walks the AST to find the parent `.` call, resolves the
 * receiver's struct type, and returns the field's docComment.
 */
function findFieldDocComment(
  exprs: Expr[],
  targetExpr: AtomExpr
): string | undefined {
  const fieldName = targetExpr.token.value;

  // Walk AST to find a "." call where targetExpr is the second arg (field name)
  function findParentDotCall(expr: Expr): FnCallExpr | null {
    if (!exprIsFunctionCall(expr)) return null;
    const fnExpr = expr as FnCallExpr;

    if (
      exprIsFunctionCallOf(fnExpr, ".") &&
      fnExpr.args.length === 2 &&
      fnExpr.args[1] === targetExpr
    ) {
      return fnExpr;
    }

    // Recurse
    let found = findParentDotCall(fnExpr.func);
    if (found) return found;
    for (const arg of fnExpr.args) {
      found = findParentDotCall(arg);
      if (found) return found;
    }
    return null;
  }

  for (const topExpr of exprs) {
    const dotCall = findParentDotCall(topExpr);
    if (dotCall) {
      const receiver = dotCall.args[0];
      const receiverType = receiver?.$?.type;
      if (receiverType && isStructType(receiverType)) {
        const field = (receiverType as StructType).fields.find(
          (f) => f.label === fieldName
        );
        if (field?.docComment) {
          return field.docComment;
        }
      }
    }
  }

  return undefined;
}
