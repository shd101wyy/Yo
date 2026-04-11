import type { Diagnostic } from "vscode-languageserver";
import { DiagnosticSeverity } from "vscode-languageserver";
import { YoError, YoLexerError } from "../error";
import type { LspDocumentManager } from "./document-manager";
import { uriToModulePath } from "./utils";

/**
 * Produce LSP diagnostics for a given document URI.
 * Inspects the module's error state in the evaluator.
 */
export function getDiagnosticsForUri(
  uri: string,
  docManager: LspDocumentManager
): Diagnostic[] {
  const modulePath = uriToModulePath(uri);
  const module = docManager.getModuleManager().modules.get(modulePath);

  if (!module) {
    return [];
  }

  const moduleError = module.moduleError;
  if (!moduleError) {
    return [];
  }

  return errorToDiagnostics(moduleError);
}

/**
 * Convert a Yo error into an array of LSP Diagnostic objects.
 */
export function errorToDiagnostics(error: Error): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (error instanceof YoError) {
    for (const { token, errorMessage: message } of error.tokenAndErrorList) {
      const { row, column } = token.position;
      diagnostics.push({
        range: {
          start: { line: row, character: column },
          end: { line: row, character: column + token.value.length },
        },
        message,
        severity: DiagnosticSeverity.Error,
        source: "yo",
      });
    }
  } else if (error instanceof YoLexerError) {
    // YoLexerError has characterIndex — we need the source text to compute line/col
    // For now, place at start of file as we don't have the text here
    const { message } = error;
    diagnostics.push({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      message,
      severity: DiagnosticSeverity.Error,
      source: "yo",
    });
  } else {
    diagnostics.push({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      message: String(error),
      severity: DiagnosticSeverity.Error,
      source: "yo",
    });
  }

  return diagnostics;
}

/**
 * Compute YoLexerError diagnostics with the document text for accurate positions.
 */
export function lexerErrorToDiagnostic(
  error: YoLexerError,
  text: string
): Diagnostic {
  const { characterIndex, message } = error;
  let row = 0;
  let column = 0;
  for (let i = 0; i < characterIndex && i < text.length; i++) {
    if (text[i] === "\n") {
      row++;
      column = 0;
    } else {
      column++;
    }
  }

  return {
    range: {
      start: { line: row, character: column },
      end: { line: row, character: column + 1 },
    },
    message,
    severity: DiagnosticSeverity.Error,
    source: "yo",
  };
}
