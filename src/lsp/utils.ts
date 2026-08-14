import type { Variable } from "../env";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { TokenType, type Token } from "../token";
import { canonicalizeModulePath } from "../module-manager";

/**
 * Find a token at a given (line, character) position within a list of tokens.
 * Skips whitespace and comment tokens.
 */
export function findTokenAtPosition(
  tokens: Token[],
  line: number,
  character: number
): Token | null {
  return (
    tokens.find((token) => {
      return (
        token.position.row === line &&
        character >= token.position.column &&
        character < token.position.column + token.value.length &&
        token.type !== TokenType.Whitespace &&
        token.type !== TokenType.SingleLineComment &&
        token.type !== TokenType.MultiLineComment
      );
    }) || null
  );
}

/**
 * Collect all AtomExprs from a list of expressions that match a target token
 * by value and position.
 */
export function collectExpressionCandidates(
  exprs: Expr[],
  targetToken: Token,
  candidateExprs: AtomExpr[]
): void {
  const findExprWithToken = (expr: Expr) => {
    if (exprIsAtom(expr)) {
      if (
        expr.token.value === targetToken.value &&
        expr.token.position.row === targetToken.position.row &&
        expr.token.position.column === targetToken.position.column
      ) {
        candidateExprs.push(expr);
      }
    } else if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      findExprWithToken(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        findExprWithToken(arg);
      }
    }
  };
  for (const expr of exprs) {
    findExprWithToken(expr);
  }
}

/**
 * From a list of candidate AtomExprs, find the best match at a given line.
 * Prefers candidates that are in function scope and close to the target line.
 */
export function findBestExpressionMatch(
  exprs: Expr[],
  targetToken: Token,
  targetLine: number
): Expr | null {
  const candidateExprs: AtomExpr[] = [];
  collectExpressionCandidates(exprs, targetToken, candidateExprs);

  if (candidateExprs.length === 0) {
    return null;
  }

  if (candidateExprs.length === 1) {
    return candidateExprs[0]!;
  }

  // Sort candidates: prefer those with evaluation info, in function scope,
  // and closest to the target line.
  candidateExprs.sort((a, b) => {
    // Prefer candidates with evaluation data
    const aHasEval = a.$ ? 1 : 0;
    const bHasEval = b.$ ? 1 : 0;
    if (aHasEval !== bHasEval) {
      return bHasEval - aHasEval;
    }

    // Prefer candidates that are inside a function scope (after line ~5)
    const aIsInFunction = a.token.position.row >= 5;
    const bIsInFunction = b.token.position.row >= 5;
    if (aIsInFunction !== bIsInFunction) {
      return bIsInFunction ? -1 : 1;
    }

    // Prefer candidates declared before the target line, closer is better
    const aIsBeforeTarget = a.token.position.row <= targetLine;
    const bIsBeforeTarget = b.token.position.row <= targetLine;
    if (aIsBeforeTarget && bIsBeforeTarget) {
      return b.token.position.row - a.token.position.row;
    }
    if (aIsBeforeTarget !== bIsBeforeTarget) {
      return aIsBeforeTarget ? -1 : 1;
    }

    return 0;
  });

  return candidateExprs[0] ?? null;
}

function compareVariablesByDeclarationPosition(
  a: Variable,
  b: Variable
): number {
  const aToken = a.initializedAtToken;
  const bToken = b.initializedAtToken;
  if (!aToken && !bToken) return 0;
  if (!aToken) return 1;
  if (!bToken) return -1;
  if (aToken.position.row !== bToken.position.row) {
    return bToken.position.row - aToken.position.row;
  }
  return bToken.position.column - aToken.position.column;
}

function isVariableVisibleAtPosition(
  variable: Variable,
  targetToken: Pick<Token, "position" | "modulePath">
): boolean {
  const initToken = variable.initializedAtToken;
  if (!initToken) return false;
  if (initToken.modulePath !== targetToken.modulePath) return false;
  if (initToken.position.row < targetToken.position.row) return true;
  return (
    initToken.position.row === targetToken.position.row &&
    initToken.position.column <= targetToken.position.column
  );
}

export function selectBestVariableAtPosition(
  variables: Variable[],
  targetToken: Pick<Token, "position" | "modulePath">
): Variable | undefined {
  const exactMatches = variables.filter((variable) => {
    const initToken = variable.initializedAtToken;
    return (
      initToken !== undefined &&
      initToken.modulePath === targetToken.modulePath &&
      initToken.position.row === targetToken.position.row &&
      initToken.position.column === targetToken.position.column
    );
  });
  if (exactMatches.length > 0) {
    return [...exactMatches].sort(compareVariablesByDeclarationPosition)[0];
  }

  const visibleVariables = variables.filter((variable) =>
    isVariableVisibleAtPosition(variable, targetToken)
  );
  if (visibleVariables.length > 0) {
    return [...visibleVariables].sort(compareVariablesByDeclarationPosition)[0];
  }

  const sameModuleVariables = variables.filter(
    (variable) =>
      variable.initializedAtToken?.modulePath === targetToken.modulePath
  );
  if (sameModuleVariables.length > 0) {
    return [...sameModuleVariables].sort(
      compareVariablesByDeclarationPosition
    )[0];
  }

  return variables[variables.length - 1];
}

/**
 * Walk all exprs recursively, calling `visitor` on each.
 */
export function walkExprs(exprs: Expr[], visitor: (expr: Expr) => void): void {
  for (const expr of exprs) {
    walkExpr(expr, visitor);
  }
}

function walkExpr(node: Expr, visitor: (e: Expr) => void): void {
  visitor(node);
  if (exprIsFunctionCall(node)) {
    const funcCallExpr = node as FnCallExpr;
    walkExpr(funcCallExpr.func, visitor);
    for (const arg of funcCallExpr.args) {
      walkExpr(arg, visitor);
    }
  }
}

/**
 * Convert a Yo token modulePath (e.g., "file:///path/to/file.yo") to a file URI.
 */
export function modulePathToUri(modulePath: string): string {
  if (modulePath.startsWith("file://")) {
    // Already a file URI, but Yo uses "file://" + absolute path (not "file:///")
    // LSP expects "file:///path" form
    const filePath = modulePath.replace("file://", "");
    return `file://${filePath}`;
  }
  return `file://${modulePath}`;
}

/**
 * Convert a file URI to a Yo modulePath.
 */
export function uriToModulePath(uri: string): string {
  // LSP URIs: file:///path/to/file.yo
  // Yo module paths: file:///path/to/file.yo (same format).
  // Canonicalized so lookups in ModuleManager.modules agree with the
  // canonical keys loadModule stores under.
  if (uri.startsWith("file://")) {
    return canonicalizeModulePath(uri);
  }
  return canonicalizeModulePath(`file://${uri}`);
}

/**
 * Convert a Yo module path to a file system path.
 */
export function modulePathToFsPath(modulePath: string): string {
  if (modulePath.startsWith("file://")) {
    return modulePath.replace("file://", "");
  }
  return modulePath;
}
