import { DocumentSymbol, SymbolKind, type Range } from "vscode-languageserver";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import {
  isFunctionType,
  isStructType,
  isEnumType,
  isUnionType,
} from "../types/guards";
import { typeToString } from "../types/utils";
import type { LspDocumentManager } from "./document-manager";
import { uriToModulePath } from "./utils";

/**
 * Handle textDocument/documentSymbol requests.
 * Returns a flat list of DocumentSymbols for the given file.
 */
export function handleDocumentSymbol(
  uri: string,
  docManager: LspDocumentManager
): DocumentSymbol[] {
  try {
    const mod = docManager.getModule(uri);
    if (!mod) return [];

    const exprs = mod.evaluator.getProgram();
    const modulePath = uriToModulePath(uri);
    const symbols: DocumentSymbol[] = [];
    const seenNames = new Set<string>();

    for (const expr of exprs) {
      const symbol = extractSymbol(expr, modulePath);
      if (symbol && !seenNames.has(symbol.name)) {
        seenNames.add(symbol.name);
        symbols.push(symbol);
      }
    }

    return symbols;
  } catch {
    return [];
  }
}

/**
 * Try to extract a DocumentSymbol from a top-level expression.
 */
function extractSymbol(expr: Expr, modulePath: string): DocumentSymbol | null {
  if (!exprIsFunctionCall(expr)) return null;
  if (expr.token.modulePath !== modulePath) return null;

  const fnCall = expr as FnCallExpr;
  const op = fnCall.func;
  if (!exprIsAtom(op)) return null;

  const opName = (op as AtomExpr).token.value;

  // Declaration operators: := and ::
  if (opName === ":=" || opName === "::") {
    return extractDeclarationSymbol(fnCall);
  }

  // import / export / open
  if (opName === "import" || opName === "export" || opName === "open") {
    return extractImportExportSymbol(fnCall, opName);
  }

  // impl blocks
  if (opName === "impl") {
    return extractImplSymbol(fnCall);
  }

  // test declarations
  if (opName === "test") {
    return extractTestSymbol(fnCall);
  }

  return null;
}

/**
 * Extract symbol from a := or :: declaration.
 */
function extractDeclarationSymbol(fnCall: FnCallExpr): DocumentSymbol | null {
  if (fnCall.args.length < 2) return null;

  const lhs = fnCall.args[0];
  if (!lhs || !exprIsAtom(lhs)) return null;

  const nameToken = (lhs as AtomExpr).token;
  const name = nameToken.value;
  if (!name || name.startsWith("__")) return null;

  const rhs = fnCall.args[1];
  const kind = classifyDeclaration(rhs);
  const detail = getTypeDetail(fnCall);
  const range = tokenRange(nameToken);

  return DocumentSymbol.create(name, detail, kind, range, range);
}

/**
 * Classify what kind of symbol this declaration is based on the RHS.
 */
function classifyDeclaration(rhs: Expr | undefined): SymbolKind {
  if (!rhs) return SymbolKind.Variable;

  // Check evaluated type information first
  const exprMeta = rhs.$;
  if (exprMeta?.type) {
    if (isFunctionType(exprMeta.type)) return SymbolKind.Function;
    if (isStructType(exprMeta.type)) return SymbolKind.Struct;
    if (isEnumType(exprMeta.type)) return SymbolKind.Enum;
    if (isUnionType(exprMeta.type)) return SymbolKind.Enum;
  }

  // Check AST shape for unevaluated or complex expressions
  if (exprIsFunctionCall(rhs)) {
    const rhsCall = rhs as FnCallExpr;
    if (exprIsAtom(rhsCall.func)) {
      const opName = (rhsCall.func as AtomExpr).token.value;
      switch (opName) {
        case "fn":
        case "unsafe_fn":
          return SymbolKind.Function;
        case "struct":
        case "object":
        case "newtype":
          return SymbolKind.Struct;
        case "enum":
          return SymbolKind.Enum;
        case "union":
          return SymbolKind.Enum;
        case "trait":
          return SymbolKind.Interface;
        case "module":
          return SymbolKind.Module;
      }
    }
  }

  // Check if the expression evaluated to a compile-time type
  if (exprMeta?.value !== undefined) {
    const val = exprMeta.value;
    if (Array.isArray(val) && val.length > 0 && val[0]) {
      const v = val[0];
      if (typeof v === "object" && "tag" in v) {
        if (v.tag === "TypeValue") return SymbolKind.Class;
        if (v.tag === "StructValue") return SymbolKind.Module;
      }
    }
  }

  return SymbolKind.Variable;
}

/**
 * Get type detail string from a declaration.
 */
function getTypeDetail(fnCall: FnCallExpr): string | undefined {
  try {
    const exprMeta = fnCall.$;
    if (exprMeta?.type) {
      return typeToString(exprMeta.type);
    }
    // Try the RHS
    const rhs = fnCall.args[1];
    if (rhs?.$?.type) {
      return typeToString(rhs.$.type);
    }
  } catch {
    // Ignore type string errors
  }
  return undefined;
}

/**
 * Extract symbol from import/export/open declarations.
 */
function extractImportExportSymbol(
  fnCall: FnCallExpr,
  opName: string
): DocumentSymbol | null {
  if (fnCall.args.length === 0) return null;

  // export name; → just marks a symbol as exported, skip
  if (opName === "export") {
    if (fnCall.args.length === 1 && exprIsAtom(fnCall.args[0])) {
      return null;
    }
  }

  // open import "path" → Module symbol
  if (opName === "open") {
    const inner = fnCall.args[0];
    if (inner && exprIsFunctionCall(inner)) {
      const innerCall = inner as FnCallExpr;
      if (
        exprIsAtom(innerCall.func) &&
        (innerCall.func as AtomExpr).token.value === "import"
      ) {
        const importPath = innerCall.args[0];
        if (importPath && exprIsAtom(importPath)) {
          const pathStr = (importPath as AtomExpr).token.value;
          const range = tokenRange(fnCall.func.token);
          return DocumentSymbol.create(
            `open import ${pathStr}`,
            undefined,
            SymbolKind.Namespace,
            range,
            range
          );
        }
      }
    }
    return null;
  }

  // import "path" → not a named symbol unless assigned
  return null;
}

/**
 * Extract symbol from an impl(...) block.
 */
function extractImplSymbol(fnCall: FnCallExpr): DocumentSymbol | null {
  if (fnCall.args.length === 0) return null;

  const target = fnCall.args[0];
  if (!target) return null;

  let implName = "impl";
  if (exprIsAtom(target)) {
    implName = `impl(${(target as AtomExpr).token.value})`;
  }

  const range = tokenRange(fnCall.func.token);
  return DocumentSymbol.create(
    implName,
    undefined,
    SymbolKind.Class,
    range,
    range
  );
}

/**
 * Extract symbol from a test declaration.
 */
function extractTestSymbol(fnCall: FnCallExpr): DocumentSymbol | null {
  if (fnCall.args.length < 1) return null;

  const nameArg = fnCall.args[0];
  if (!nameArg) return null;

  let testName = "test";
  if (exprIsAtom(nameArg)) {
    testName = `test ${(nameArg as AtomExpr).token.value}`;
  }

  const range = tokenRange(fnCall.func.token);
  return DocumentSymbol.create(
    testName,
    undefined,
    SymbolKind.Function,
    range,
    range
  );
}

/**
 * Create a minimal LSP Range from a token.
 */
function tokenRange(token: {
  position: { row: number; column: number };
  value: string;
}): Range {
  return {
    start: { line: token.position.row, character: token.position.column },
    end: {
      line: token.position.row,
      character: token.position.column + token.value.length,
    },
  };
}
