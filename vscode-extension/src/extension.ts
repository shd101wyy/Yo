// Activate the extension
import * as vscode from "vscode";

// Import the parser and lexer from Mo project
// This assumes your extension can access the Mo project code
import { MoLexerError, MoParserError } from "@mo/error";
import { tokenize } from "@mo/lexer";
import Parser from "@mo/parser";

export function activate(context: vscode.ExtensionContext) {
  // Create a diagnostic collection for Mo language errors
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("mo");
  context.subscriptions.push(diagnosticCollection);

  // Function to analyze Mo file and show diagnostics
  const analyzeMoFile = async (document: vscode.TextDocument) => {
    // Only analyze Mo files
    if (document.languageId !== "mo") {
      return;
    }

    // Clear previous diagnostics for this file
    diagnosticCollection.delete(document.uri);

    const text = document.getText();
    const filePath = document.uri.fsPath;

    try {
      // First try to tokenize
      tokenize(text);

      // Then try to parse
      new Parser({
        modulePath: filePath,
        inputString: text,
      });

      // If we get here, there were no errors
    } catch (error) {
      const diagnostics: vscode.Diagnostic[] = [];

      if (error instanceof MoParserError) {
        // Handle MoParserError with its structured information
        const { token, message } = error;
        const { row, column } = token.position;

        // Create a range for the error
        const range = new vscode.Range(
          row,
          column,
          row,
          column + token.value.length
        );

        // Create a diagnostic
        const diagnostic = new vscode.Diagnostic(
          range,
          message,
          vscode.DiagnosticSeverity.Error
        );

        diagnostics.push(diagnostic);
      } else if (error instanceof MoLexerError) {
        // Handle MoLexerError
        const { characterIndex, message } = error;
        // Caculate position based on text and character index
        let index = 0;
        let row = 0;
        let column = 0;
        while (index < characterIndex) {
          if (text[index] === "\n") {
            row += 1;
            column = 0;
          } else {
            column += 1;
          }
          index += 1;
        }

        // Create a range for the error
        const range = new vscode.Range(row, column, row, column + 1);

        // Create a diagnostic
        const diagnostic = new vscode.Diagnostic(
          range,
          message,
          vscode.DiagnosticSeverity.Error
        );

        diagnostics.push(diagnostic);
      } else {
        // Don't handle the error type we don't know
      }

      // Set the diagnostics for the file
      diagnosticCollection.set(document.uri, diagnostics);
    }
  };

  // Register event handlers

  // Analyze the current active editor when extension is activated
  if (vscode.window.activeTextEditor) {
    analyzeMoFile(vscode.window.activeTextEditor.document);
  }

  // Analyze when a document is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(analyzeMoFile)
  );

  // Analyze when a document is changed
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      analyzeMoFile(event.document);
    })
  );

  // Analyze when the active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        analyzeMoFile(editor.document);
      }
    })
  );
}
