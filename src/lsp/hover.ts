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
import type { StructType, Type } from "../types/definitions";
import {
  isStructType,
  isTraitType,
  isTypeHierarchyType,
} from "../types/guards";
import { typeToString } from "../types/utils";
import { isTypeValue, valueToString } from "../value";
import type { Value } from "../value";
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
  const currentModule = docManager.getModule(uri);
  const fallbackModule = docManager.getLastGoodModule(uri);

  // Use current module if available, otherwise fall back to last good module
  const primaryModule = currentModule ?? fallbackModule;
  if (!primaryModule) return null;

  // Always use the current module's tokens for position lookup when available,
  // since they match the actual buffer content the user sees.
  const tokensModule = currentModule ?? fallbackModule;
  if (!tokensModule) return null;
  const tokens = tokensModule.evaluator.getTokens();

  const tokenAtPosition = findTokenAtPosition(tokens, line, character);
  if (!tokenAtPosition) {
    return null;
  }

  // Try to find expression match in the current module first, then fallback
  const modulesToSearch = [currentModule, fallbackModule].filter(
    (m): m is NonNullable<typeof m> => m != null
  );

  let foundExpr: Expr | null = null;
  for (const mod of modulesToSearch) {
    const modExprs = mod.evaluator.getProgram();
    foundExpr = findBestExpressionMatch(modExprs, tokenAtPosition, line);
    if (foundExpr && exprIsAtom(foundExpr)) break;

    // Try variable fallback in this module's AST
    if (tokenAtPosition.type === TokenType.Identifier) {
      foundExpr = findVariableByFallback(modExprs, tokenAtPosition);
      if (foundExpr && exprIsAtom(foundExpr)) break;
    }
    foundExpr = null;
  }

  // If still not found via expression search, try environment lookup from
  // the fallback module as a last resort for known identifiers like `Option`
  if (
    !foundExpr &&
    tokenAtPosition.type === TokenType.Identifier &&
    fallbackModule
  ) {
    const fallbackExprs = fallbackModule.evaluator.getProgram();
    foundExpr = findVariableByNameInAnyEnv(
      fallbackExprs,
      tokenAtPosition.value
    );
  }

  if (!foundExpr || !exprIsAtom(foundExpr)) {
    return null;
  }

  // Get the best available AST for field/doc-comment lookups
  const exprs = primaryModule.evaluator.getProgram();

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

  // Fallback: if the atom has no type info (e.g., label in `impl(Point, add : ...)`),
  // look for the parent ":" call and get type/value from the right-hand side
  if (!varType) {
    const fieldInfo = findFieldDefinitionInfo(exprs, expr);
    if (fieldInfo) {
      varType = fieldInfo.type;
      varValue = fieldInfo.value;
      varDocComment = fieldInfo.docComment;
      foundVariable = true;
      isCompileTimeOnly = true;
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
    // Skip displaying "= <runtime value>" when the type already provides
    // sufficient information (e.g., function types, struct types)
    if (valueString !== "<runtime value>") {
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
 * Look up a variable by name in any available environment from the AST.
 * Used when the current (errored) module's tokens show a known identifier
 * but the expression wasn't fully evaluated. Searches the deepest env
 * available in the fallback module.
 */
function findVariableByNameInAnyEnv(
  exprs: Expr[],
  name: string
): AtomExpr | null {
  let bestEnv: Environment | null = null;
  let bestDepth = -1;

  const findDeepestEnv = (expr: Expr) => {
    if (exprIsAtom(expr)) {
      if (expr.$?.env && expr.$.env.frames.length > bestDepth) {
        bestEnv = expr.$.env;
        bestDepth = expr.$.env.frames.length;
      }
    } else if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      findDeepestEnv(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        findDeepestEnv(arg);
      }
    }
  };

  for (const expr of exprs) {
    findDeepestEnv(expr);
  }

  if (!bestEnv) return null;

  try {
    const variables = getVariablesFromEnv(bestEnv, name);
    if (!variables || variables.length === 0) return null;

    const selectedVariable = variables[variables.length - 1];
    if (!selectedVariable?.type) return null;

    return {
      tag: ExprTag.Atom,
      token: {
        value: name,
        type: TokenType.Identifier,
        position: { row: 0, column: 0 },
        modulePath: "",
      },
      $: {
        type: selectedVariable.type,
        value: selectedVariable.value?.[0],
        env: bestEnv,
        pathCollection: [],
        docComment: selectedVariable.docComment,
      },
    } as unknown as AtomExpr;
  } catch {
    return null;
  }
}

/**
 * When hovering a label like `add` in `impl(Point, add : (fn...))` or
 * a struct field label like `x` in `struct((x : i32) ?= 0)`,
 * find the parent ":" call and return type/value from the right-hand side.
 */
function findFieldDefinitionInfo(
  exprs: Expr[],
  targetExpr: AtomExpr
): { type: Type; value?: Value; docComment?: string } | null {
  function findParentColonCall(expr: Expr): FnCallExpr | null {
    if (!exprIsFunctionCall(expr)) return null;
    const fnExpr = expr as FnCallExpr;

    // Check if this is `label : value` where targetExpr is the label
    if (
      exprIsFunctionCallOf(fnExpr, ":") &&
      fnExpr.args.length >= 2 &&
      fnExpr.args[0] === targetExpr
    ) {
      return fnExpr;
    }

    // Recurse into sub-expressions
    let found = findParentColonCall(fnExpr.func);
    if (found) return found;
    for (const arg of fnExpr.args) {
      found = findParentColonCall(arg);
      if (found) return found;
    }
    return null;
  }

  for (const topExpr of exprs) {
    const colonCall = findParentColonCall(topExpr);
    if (colonCall) {
      const valueExpr = colonCall.args[1];
      if (valueExpr?.$?.type) {
        // Look for doc comment on the receiver type's trait fields
        const fieldName = targetExpr.token.value;
        let docComment: string | undefined;

        // Walk up to find the impl call and get the receiver type
        const implInfo = findParentImplCall(topExpr, colonCall);
        if (implInfo) {
          const receiverType = implInfo.receiverType;
          if (receiverType?.trait) {
            for (const tf of receiverType.trait.fields) {
              if (tf.label === fieldName && tf.docComment) {
                docComment = tf.docComment;
                break;
              }
            }
          }
        }

        return {
          type: valueExpr.$.type,
          value: valueExpr.$.value,
          docComment,
        };
      }
    }
  }
  return null;
}

/**
 * Find a parent `impl(Type, ...)` call that contains the given field expression,
 * and extract the receiver type.
 */
function findParentImplCall(
  expr: Expr,
  targetFieldExpr: FnCallExpr
): { receiverType: Type } | null {
  if (!exprIsFunctionCall(expr)) return null;
  const fnExpr = expr as FnCallExpr;

  if (exprIsFunctionCallOf(fnExpr, "impl")) {
    // Check if the target field is among impl's arguments
    for (const arg of fnExpr.args) {
      if (arg === targetFieldExpr) {
        // The impl's $.type is the trait type itself (tag: "Trait")
        // with receiverType pointing to the actual struct/enum
        const implType = fnExpr.$?.type;
        if (implType && isTraitType(implType) && implType.receiverType) {
          return { receiverType: implType.receiverType };
        }
        // Fallback: get receiver type from the first arg (Point)
        const firstArg = fnExpr.args[0];
        if (firstArg?.$?.value && isTypeValue(firstArg.$.value)) {
          return { receiverType: firstArg.$.value.value };
        }
        break;
      }
    }
  }

  // Recurse
  let found = findParentImplCall(fnExpr.func, targetFieldExpr);
  if (found) return found;
  for (const arg of fnExpr.args) {
    found = findParentImplCall(arg, targetFieldExpr);
    if (found) return found;
  }
  return null;
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
      let receiverType = receiver?.$?.type;
      // Unwrap TypeValue for type-level access (e.g., `Point.add`)
      if (
        receiverType &&
        isTypeHierarchyType(receiverType) &&
        receiver?.$?.value &&
        isTypeValue(receiver.$.value)
      ) {
        receiverType = receiver.$.value.value;
      }
      if (receiverType) {
        // Check struct fields
        if (isStructType(receiverType)) {
          const field = (receiverType as StructType).fields.find(
            (f) => f.label === fieldName
          );
          if (field?.docComment) {
            return field.docComment;
          }
        }
        // Check trait fields (methods from impl blocks)
        if (receiverType.trait) {
          for (const tf of receiverType.trait.fields) {
            if (tf.label === fieldName && tf.docComment) {
              return tf.docComment;
            }
          }
        }
      }
    }
  }

  return undefined;
}
