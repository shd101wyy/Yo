// Activate the extension
import * as vscode from "vscode";

// Import the parser and lexer from Mo project
// This assumes your extension can access the Mo project code
import { getVariablesFromEnv } from "@mo/env";
import { MoLexerError, MoParserError } from "@mo/error";
import Evaluator from "@mo/evaluator";
import { AtomExpr, Expr, exprIsAtom, exprToString } from "@mo/expr";
import { stringIsOperator, TokenType } from "@mo/token";
import { getSizeString, typeOfType, typeToString } from "@mo/type-checker";
import { ValueTag, valueToString } from "@mo/value";

export function activate(context: vscode.ExtensionContext) {
  // Create a diagnostic collection for Mo language errors
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("mo");
  context.subscriptions.push(diagnosticCollection);

  // Map to store evaluated expressions by file path
  const evaluatedFiles = new Map<string, { evaluator: Evaluator }>();

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
    let evaluator: Evaluator | null = null;

    try {
      // Clear any previous evaluation for this file
      evaluatedFiles.delete(filePath);

      // Then try to evaluate:
      evaluator = new Evaluator({
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

    if (evaluator) {
      // Store the evaluated expressions for hover provider to use
      evaluatedFiles.set(filePath, {
        evaluator,
      });
    }
  };

  // Register hover provider for Mo language
  const hoverProvider = vscode.languages.registerHoverProvider("mo", {
    provideHover(document, position) {
      const filePath = document.uri.fsPath;
      const fileData = evaluatedFiles.get(filePath);

      if (!fileData) {
        return null; // No evaluated data for this file
      }

      // NOTE: The code below will ignore operators like +, -, etc.
      // Get the word at the current position
      // const range = document.getWordRangeAtPosition(position);
      // if (!range) {
      //   return null;
      // }

      // Get the text of the document and tokenize it
      // const text = document.getText();
      const exprs = fileData.evaluator.getProgram();
      const tokens = fileData.evaluator.getTokens();

      // Find the token at the current position
      const line = position.line;
      const character = position.character;
      const tokenAtPosition = tokens.find((token) => {
        return (
          token.position.row === line &&
          character >= token.position.column &&
          character < token.position.column + token.value.length &&
          token.type !== TokenType.Whitespace &&
          token.type !== TokenType.SingleLineComment &&
          token.type !== TokenType.MultiLineComment
        );
      });

      if (!tokenAtPosition) {
        return null;
      }

      // Find an expression with matching token
      let foundExpr: Expr | null = null;

      // Recursive function to search through expressions
      const findExprWithToken = (expr: Expr) => {
        if (
          exprIsAtom(expr) &&
          expr.token.value === tokenAtPosition.value &&
          expr.token.position.row === tokenAtPosition.position.row &&
          expr.token.position.column === tokenAtPosition.position.column
        ) {
          foundExpr = expr;
          return;
        }

        if (expr.tag === "FuncCall") {
          findExprWithToken(expr.func);
          for (const arg of expr.args) {
            findExprWithToken(arg);
          }
        }
      };

      // Search through all expressions
      for (const expr of exprs) {
        findExprWithToken(expr);
        if (foundExpr) break;
      }

      if (foundExpr && exprIsAtom(foundExpr)) {
        const expr: AtomExpr = foundExpr as AtomExpr;

        // Create a MarkdownString for the hover content
        const markdownContent = new vscode.MarkdownString();
        markdownContent.supportHtml = true;
        markdownContent.isTrusted = true; // Enable trusted content for richer formatting

        // Get the token text for the expression
        // const tokenText = tokenAtPosition.value;
        let tokenText = exprToString(expr);
        if (stringIsOperator(tokenText)) {
          // Wrap operators in parentheses
          tokenText = `(\`${tokenText}\`)`;
        }

        // Get variable from the env
        if (expr.env) {
          const variables = getVariablesFromEnv(expr.env, expr.token.value);
          if (
            variables &&
            variables.length > 0 &&
            variables[variables.length - 1].isMutable
          ) {
            tokenText = `mut(${tokenText})`;
          }
        }

        // Start with the token name in code format
        markdownContent.appendMarkdown(`\`\`\`\n${tokenText}`);

        // Add type if available
        if (expr.type) {
          const typeString = typeToString(expr.type);
          markdownContent.appendMarkdown(
            `\n: ${typeString} (${getSizeString(expr.type)})`
          );
          markdownContent.appendMarkdown(
            `\n  : ${typeToString(typeOfType(expr.type))}`
          );
        }

        // Add value if available
        if (expr.value) {
          const valueString = valueToString(expr.value);
          if (expr.value.tag === ValueTag.Type) {
            markdownContent.appendMarkdown(
              `\n:= ${valueString} (${getSizeString(expr.value.value)})`
            );
          } else {
            markdownContent.appendMarkdown(`\n:= ${valueString}`);
          }
        }

        // Close the code block
        markdownContent.appendMarkdown("\n```");

        return new vscode.Hover(markdownContent);
      }

      return null;
    },
  });

  context.subscriptions.push(hoverProvider);

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
