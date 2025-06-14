// Activate the extension
import * as vscode from "vscode";

// Import the parser and lexer from Yo project
// This assumes your extension can access the Yo project code
import { getVariablesFromEnv } from "@yo/env";
import { MoLexerError, MoParserError } from "@yo/error";
import {
  AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprToString,
  FuncCallExpr,
} from "@yo/expr";
import { ModuleManager } from "@yo/module-manager";
import { stringIsOperator, TokenType } from "@yo/token";
import { isFunctionType, typeOfType, typeToString } from "@yo/type-checker";
import { valueToString } from "@yo/value";
import { ValueTag } from "@yo/value-tag";

const basicKeywords: string[] = [];
for (const keyword in BuiltinKeywords) {
  basicKeywords.push(...BuiltinKeywords[keyword]);
}
for (const keyword in BuiltinFunctions) {
  basicKeywords.push(...BuiltinFunctions[keyword]);
}

export function activate(context: vscode.ExtensionContext) {
  // Create a diagnostic collection for Yo language errors
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("yo");
  context.subscriptions.push(diagnosticCollection);

  // Yo language module manager
  const moduleManager = new ModuleManager();

  // Function to analyze Yo file and show diagnostics
  const analyzeMoFile = async (document: vscode.TextDocument) => {
    // Only analyze Yo files
    if (!document.languageId.match(/^yo$/i)) {
      return;
    }

    // Clear previous diagnostics for this file
    diagnosticCollection.delete(document.uri);

    const text = document.getText();
    const filePath = document.uri.fsPath;

    try {
      // Include protocol in the file path
      const modulePath = "file://" + filePath;

      // Clear any previous evaluation for this file
      moduleManager.deleteModule(modulePath);

      // Load the module again
      const { moduleError } = moduleManager.loadModule(modulePath);
      if (moduleError) {
        throw moduleError;
      }

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
        // Create a range for the error
        // at the end of the document
        const range = new vscode.Range(
          document.lineCount - 1,
          document.lineAt(document.lineCount - 1).text.length,
          document.lineCount - 1,
          document.lineAt(document.lineCount - 1).text.length + 1
        );

        // Create a diagnostic
        const diagnostic = new vscode.Diagnostic(
          range,
          error.toString(),
          vscode.DiagnosticSeverity.Error
        );

        diagnostics.push(diagnostic);
      }

      // Set the diagnostics for the file
      diagnosticCollection.set(document.uri, diagnostics);
    }
  };

  // Register hover provider for Yo language
  const hoverProvider = vscode.languages.registerHoverProvider("yo", {
    provideHover(document, position) {
      const filePath = document.uri.fsPath;

      // Include protocol in the file path
      const modulePath = "file://" + filePath;

      // Get the module evaluator
      const module = moduleManager.modules.get(modulePath);

      if (!module) {
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
      const exprs = module.evaluator.getProgram();
      const tokens = module.evaluator.getTokens();

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
          tokenText = `(${tokenText})`;
        } else if (
          exprIsAtom(expr) &&
          expr.token.type === TokenType.BacktickIdentifier
        ) {
          // Remove backticks from identifiers
          tokenText = tokenText.slice(1, -1);
        }

        // Get variable from the env
        let isUndefined = true;
        let foundVariable = false;
        if (expr.$?.env) {
          const variables = getVariablesFromEnv(expr.$.env, expr.token.value);
          foundVariable = variables && variables.length > 0;
          const isMutable =
            variables &&
            variables.length > 0 &&
            variables[variables.length - 1]!.isMutable;
          const isCompileTimeOnly =
            variables &&
            variables.length > 0 &&
            variables[variables.length - 1]!.isCompileTimeOnly;
          const isImplicit =
            variables &&
            variables.length > 0 &&
            variables[variables.length - 1]!.isImplicit;

          isUndefined =
            variables &&
            variables.length > 0 &&
            !!variables[variables.length - 1]!.isUndefined;

          if (isMutable) {
            tokenText = `mut(${tokenText})`;
          }
          if (isImplicit) {
            tokenText = `implicit(${tokenText})`;
          }
          if (isCompileTimeOnly) {
            tokenText = `compt(${tokenText})`;
          }
        }

        // Start with the token name in code format
        markdownContent.appendMarkdown(`\`\`\`\n${tokenText}`);

        // Add type if available
        if (expr.$?.type) {
          const typeString = typeToString(expr.$.type);
          markdownContent.appendMarkdown(`\n: ${typeString}`);
          markdownContent.appendMarkdown(
            `\n  : ${typeToString(typeOfType(expr.$.type))}`
          );
        }

        if (foundVariable && isUndefined) {
          markdownContent.appendMarkdown(`\nNot initialized`);
        } else {
          // Add value if available
          const valueString = valueToString(expr.$?.value);
          if (expr.$?.value?.tag === ValueTag.Type) {
            markdownContent.appendMarkdown(`\n= ${valueString}`);
          } else {
            markdownContent.appendMarkdown(`\n= ${valueString}`);
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

  // Register completion provider for Yo language
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    "yo",
    {
      provideCompletionItems(document, position) {
        const filePath = document.uri.fsPath;
        const modulePath = "file://" + filePath;

        // Get the module evaluator
        const module = moduleManager.modules.get(modulePath);
        if (!module) {
          // If no module is available, provide basic language keywords
          return getBasicCompletionItems(document, position);
        }

        // Get the word at the current position to filter suggestions
        const range = document.getWordRangeAtPosition(position);
        const prefix = range ? document.getText(range) : "";

        // Collect all variables and functions from the parsed program
        const completionItems: vscode.CompletionItem[] = [];
        const addedItems = new Set<string>(); // Prevent duplicates

        // Helper function to add completion items
        const addCompletionItem = (
          name: string,
          kind: vscode.CompletionItemKind,
          detail?: string,
          documentation?: string
        ) => {
          if (
            !addedItems.has(name) &&
            name.toLowerCase().includes(prefix.toLowerCase())
          ) {
            addedItems.add(name);
            const item = new vscode.CompletionItem(name, kind);
            if (detail) item.detail = detail;
            if (documentation) item.documentation = documentation;

            // Sort priority: items starting with prefix get higher priority
            if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
              item.sortText = `0_${name}`;
            } else {
              item.sortText = `1_${name}`;
            }

            completionItems.push(item);
          }
        };

        try {
          // Get all expressions from the program
          const program = module.evaluator.getProgram();

          // Extract variable names from expressions
          const extractVariables = (expr: Expr) => {
            if (exprIsAtom(expr)) {
              const atomExpr = expr as AtomExpr;
              if (atomExpr.token.type === TokenType.Identifier) {
                let detail = "";
                let documentation = "";

                // Try to get type information if available
                if (atomExpr.$?.type) {
                  try {
                    detail = typeToString(atomExpr.$.type);
                  } catch (error) {
                    // Ignore type conversion errors
                  }
                }

                if (atomExpr.$?.value) {
                  try {
                    documentation = `Value: ${valueToString(atomExpr.$.value)}`;
                  } catch (error) {
                    // Ignore value conversion errors
                  }
                }

                // Determine the kind based on the variable type or name
                let kind = vscode.CompletionItemKind.Variable;
                if (isFunctionType(atomExpr.$?.type)) {
                  kind = vscode.CompletionItemKind.Function;
                }

                addCompletionItem(
                  atomExpr.token.value,
                  kind,
                  detail,
                  documentation
                );
              }
            } else if (expr.tag === "FuncCall") {
              // Recursively extract from function calls
              const funcCallExpr = expr as FuncCallExpr;
              extractVariables(funcCallExpr.func);
              for (const arg of funcCallExpr.args) {
                extractVariables(arg);
              }
            }
          };

          // Extract variables from all expressions in the program
          for (const expr of program) {
            extractVariables(expr);
          }

          // Add built-in functions and keywords
          for (const builtin of basicKeywords) {
            addCompletionItem(builtin, vscode.CompletionItemKind.Keyword);
          }
        } catch (error) {
          // If we can't parse the program, provide basic language keywords
          return getBasicCompletionItems(document, position);
        }

        return completionItems;
      },
    },
    // Trigger characters for completion
    ".",
    ":",
    "("
  );

  // Helper function to provide basic completion items
  const getBasicCompletionItems = (
    document: vscode.TextDocument,
    position: vscode.Position
  ) => {
    const range = document.getWordRangeAtPosition(position);
    const prefix = range ? document.getText(range) : "";

    const completionItems: vscode.CompletionItem[] = [];
    for (const keyword of basicKeywords) {
      if (keyword.toLowerCase().includes(prefix.toLowerCase())) {
        const item = new vscode.CompletionItem(
          keyword,
          vscode.CompletionItemKind.Keyword
        );

        // Sort priority: items starting with prefix get higher priority
        if (keyword.toLowerCase().startsWith(prefix.toLowerCase())) {
          item.sortText = `0_${keyword}`;
        } else {
          item.sortText = `1_${keyword}`;
        }

        completionItems.push(item);
      }
    }

    return completionItems;
  };

  context.subscriptions.push(completionProvider);

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
