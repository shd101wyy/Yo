// Activate the extension
import * as vscode from "vscode";

// Import the parser and lexer from Yo project
// This assumes your extension can access the Yo project code
import {
  Environment,
  getMethodsByNameFromEnv,
  getVariablesFromEnv,
} from "@yo/env";
import { YoError, YoLexerError } from "@yo/error";
import Evaluator from "@yo/evaluator";
import {
  AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "@yo/expr";
import { ModuleManager } from "@yo/module-manager";
import { stringIsOperator, Token, TokenType } from "@yo/token";
import {
  areTypesCompatible,
  isArrayType,
  isEnumType,
  isFunctionType,
  isMutPtrType,
  isSliceType,
  isStructType,
  isUnionType,
  Type,
  TypeTag,
  typeToString,
} from "@yo/types";
import { isModuleValue, ModuleValue, valueToString } from "@yo/value";
import { ValueTag } from "@yo/value-tag";

const basicKeywords: string[] = [];
for (const keyword in BuiltinKeywords) {
  basicKeywords.push(...BuiltinKeywords[keyword]);
}
for (const keyword in BuiltinFunctions) {
  basicKeywords.push(...BuiltinFunctions[keyword]);
}
for (const key in TypeTag) {
  basicKeywords.push(TypeTag[key]);
}

// Shared utility functions for code deduplication
const findTokenAtPosition = (
  tokens: Token[],
  line: number,
  character: number
): Token | null => {
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
};

const collectExpressionCandidates = (
  exprs: Expr[],
  targetToken: Token,
  candidateExprs: AtomExpr[]
): void => {
  const findExprWithToken = (expr: Expr) => {
    if (
      exprIsAtom(expr) &&
      expr.token.value === targetToken.value &&
      expr.token.position.row === targetToken.position.row &&
      expr.token.position.column === targetToken.position.column
    ) {
      candidateExprs.push(expr as AtomExpr);
      return;
    }

    if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FuncCallExpr;
      findExprWithToken(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        findExprWithToken(arg);
      }
    }
  };

  for (const expr of exprs) {
    findExprWithToken(expr);
  }
};

const sortExpressionCandidates = (
  candidateExprs: AtomExpr[],
  currentLine: number
): AtomExpr[] => {
  return candidateExprs.sort((a, b) => {
    // First, check if the candidates are within a function scope (after "main :: " line)
    const aIsInFunction = a.token.position.row > 4; // After "main :: (fn() -> unit) {"
    const bIsInFunction = b.token.position.row > 4;

    if (aIsInFunction !== bIsInFunction) {
      return bIsInFunction ? -1 : 1; // Prefer expressions in function scope
    }

    // If both are in function scope, prefer the one that's declared before the current position
    // but after the function start
    if (aIsInFunction && bIsInFunction) {
      const aIsBeforeCurrent = a.token.position.row < currentLine;
      const bIsBeforeCurrent = b.token.position.row < currentLine;
      const aIsAfterFunctionStart = a.token.position.row >= 5; // After function body starts
      const bIsAfterFunctionStart = b.token.position.row >= 5;

      // Prefer variables declared in the current function scope before the current line
      if (
        aIsBeforeCurrent &&
        aIsAfterFunctionStart &&
        !(bIsBeforeCurrent && bIsAfterFunctionStart)
      ) {
        return -1;
      }
      if (
        bIsBeforeCurrent &&
        bIsAfterFunctionStart &&
        !(aIsBeforeCurrent && aIsAfterFunctionStart)
      ) {
        return 1;
      }
    }

    const aHasEvalInfo = a.$ ? 1 : 0;
    const bHasEvalInfo = b.$ ? 1 : 0;

    // Second priority: expressions with evaluation info
    if (aHasEvalInfo !== bHasEvalInfo) {
      return bHasEvalInfo - aHasEvalInfo;
    }

    // Third priority: if both have eval info, prefer the one with a local variable type
    // (not i32 which suggests struct field definition)
    if (aHasEvalInfo && bHasEvalInfo && a.$?.type && b.$?.type) {
      const aTypeString = typeToString(a.$.type);
      const bTypeString = typeToString(b.$.type);

      // Prefer non-primitive types (like Expr) over primitive types (like i32)
      const aIsPrimitive =
        aTypeString === "i32" ||
        aTypeString === "f64" ||
        aTypeString === "bool" ||
        aTypeString === "str";
      const bIsPrimitive =
        bTypeString === "i32" ||
        bTypeString === "f64" ||
        bTypeString === "bool" ||
        bTypeString === "str";

      if (aIsPrimitive !== bIsPrimitive) {
        return aIsPrimitive ? 1 : -1; // Prefer non-primitive (return -1 for a if a is not primitive)
      }
    }

    // Fourth priority: prefer expressions that have environment info (suggests they're in a local scope)
    const aHasEnv = a.$?.env ? 1 : 0;
    const bHasEnv = b.$?.env ? 1 : 0;

    if (aHasEnv !== bHasEnv) {
      return bHasEnv - aHasEnv;
    }

    return 0;
  });
};

const findBestExpressionMatch = (
  exprs: Expr[],
  tokenAtPosition: Token,
  currentLine: number
): AtomExpr | null => {
  const candidateExprs: AtomExpr[] = [];

  // Collect all candidate expressions
  collectExpressionCandidates(exprs, tokenAtPosition, candidateExprs);

  if (candidateExprs.length > 0) {
    // Sort and return the best candidate
    const sortedCandidates = sortExpressionCandidates(
      candidateExprs,
      currentLine
    );
    return sortedCandidates[0] || null;
  }

  return null;
};

export function activate(context: vscode.ExtensionContext) {
  // Create a diagnostic collection for Yo language errors
  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("yo");
  context.subscriptions.push(diagnosticCollection);

  // Yo language module manager
  const moduleManager = new ModuleManager();

  // Function to analyze Yo file and show diagnostics
  const analyzeYoFile = async (document: vscode.TextDocument) => {
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

      if (error instanceof YoError) {
        // Handle YoError with its structured information
        for (const {
          token,
          errorMessage: message,
        } of error.tokenAndErrorList) {
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
        }
      } else if (error instanceof YoLexerError) {
        // Handle YoLexerError
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

      const tokenAtPosition = findTokenAtPosition(tokens, line, character);

      if (!tokenAtPosition) {
        return null;
      }

      // Find an expression with matching token
      let foundExpr = findBestExpressionMatch(
        exprs,
        tokenAtPosition,
        position.line
      );

      // If no exact expression match was found, try to find variable in scope using fallback
      if (!foundExpr && tokenAtPosition.type === TokenType.Identifier) {
        // Find the most recent expression that has environment info and is before the current position
        let bestEnv: unknown = null;
        let bestExprPosition = -1;

        for (const expr of exprs) {
          const findBestEnv = (expr: Expr) => {
            if (exprIsAtom(expr)) {
              const atomExpr = expr as AtomExpr;
              if (
                atomExpr.$?.env &&
                atomExpr.token.position.row < tokenAtPosition.position.row &&
                atomExpr.token.position.row > bestExprPosition
              ) {
                bestEnv = atomExpr.$.env;
                bestExprPosition = atomExpr.token.position.row;
              }
            } else if (expr.tag === "FuncCall") {
              const funcCallExpr = expr as FuncCallExpr;
              findBestEnv(funcCallExpr.func);
              for (const arg of funcCallExpr.args) {
                findBestEnv(arg);
              }
            }
          };

          findBestEnv(expr);
        }

        if (bestEnv) {
          try {
            const variables = getVariablesFromEnv(
              bestEnv as Parameters<typeof getVariablesFromEnv>[0],
              tokenAtPosition.value
            );

            if (variables && variables.length > 0) {
              // Filter out variables that are likely struct fields by checking their position
              const localVariables = variables.filter((variable) => {
                // If the variable has an initializedAtToken, check if it's a reasonable local variable
                if (variable.initializedAtToken) {
                  const varRow = variable.initializedAtToken.position.row;
                  // Variable should be declared after line 0 (not in imports/top-level struct definitions)
                  // and before the current position
                  const isLocalVar =
                    varRow > 2 && varRow < tokenAtPosition.position.row;
                  return isLocalVar;
                }
                return false;
              });

              if (localVariables.length > 0) {
                // Use the most recent local variable
                const selectedVariable =
                  localVariables[localVariables.length - 1];

                // Create a synthetic expression for the fallback
                if (selectedVariable?.type) {
                  const syntheticExpr: AtomExpr = {
                    tag: ExprTag.Atom,
                    token: tokenAtPosition,
                    $: {
                      type: selectedVariable.type,
                      value: selectedVariable.value,
                      env: bestEnv as Parameters<typeof getVariablesFromEnv>[0],
                      pathCollection: [], // Empty path collection for fallback
                    },
                  };

                  foundExpr = syntheticExpr;
                }
              }
            }
          } catch (error) {
            // Ignore errors in fallback variable lookup
          }
        }
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
            !variables[variables.length - 1]!.initializedAtToken;

          if (isImplicit) {
            tokenText = `given(${tokenText})`;
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
          // markdownContent.appendMarkdown(
          //   `\n  : ${typeToString(typeOfType(expr.$.type))}`
          // );
        }

        if (foundVariable && isUndefined) {
          markdownContent.appendMarkdown(`\nundefined`);
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

        // Check if completion is triggered after a dot for method calls
        const line = document.lineAt(position.line).text;
        const textUpToCursor = line.substring(0, position.character);
        const isDotCompletion = textUpToCursor.endsWith(".");

        if (isDotCompletion) {
          return provideDotCompletionItems(document, position, module);
        }

        // Get the word at the current position to filter suggestions
        const range = document.getWordRangeAtPosition(position);
        const prefix = range ? document.getText(range) : "";

        // Collect all variables and functions from the parsed program
        const completionItems: vscode.CompletionItem[] = [];
        const candidateVariables = new Map<string, AtomExpr[]>(); // Collect all candidates per variable name

        // Helper function to add completion items (now collects candidates instead of immediately adding)
        const addCandidateVariable = (atomExpr: AtomExpr, name: string) => {
          if (name.toLowerCase().includes(prefix.toLowerCase())) {
            if (!candidateVariables.has(name)) {
              candidateVariables.set(name, []);
            }
            candidateVariables.get(name)!.push(atomExpr);
          }
        };

        // Function to create completion item from the best candidate
        const createCompletionItem = (
          name: string,
          bestCandidate: AtomExpr,
          kind: vscode.CompletionItemKind
        ) => {
          let detail = "";
          let documentation = "";

          // Try to get type information if available
          if (bestCandidate.$?.type) {
            try {
              detail = typeToString(bestCandidate.$.type);
            } catch (error) {
              // Ignore type conversion errors
            }
          }

          if (bestCandidate.$?.value) {
            try {
              documentation = `Value: ${valueToString(bestCandidate.$.value)}`;
            } catch (error) {
              // Ignore value conversion errors
            }
          }

          const item = new vscode.CompletionItem(name, kind);
          if (detail) item.detail = detail;
          if (documentation) item.documentation = documentation;

          // Sort priority: items starting with prefix get higher priority
          if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
            item.sortText = `0_${name}`;
          } else {
            item.sortText = `1_${name}`;
          }

          return item;
        };

        try {
          // Get all expressions from the program
          const program = module.evaluator.getProgram();
          const currentLine = position.line;
          const currentCharacter = position.character;

          // Extract variable names from expressions, but only those that are in scope
          const extractVariables = (expr: Expr) => {
            if (exprIsAtom(expr)) {
              const atomExpr = expr as AtomExpr;
              if (atomExpr.token.type === TokenType.Identifier) {
                // Only include variables that are declared before the current position
                const tokenLine = atomExpr.token.position.row;
                const tokenColumn = atomExpr.token.position.column;

                // Check if this variable is declared before the current cursor position
                const isBeforeCurrentPosition =
                  tokenLine < currentLine ||
                  (tokenLine === currentLine && tokenColumn < currentCharacter);

                if (!isBeforeCurrentPosition) {
                  return; // Skip variables declared after current position
                }

                addCandidateVariable(atomExpr, atomExpr.token.value);
              }
            } else if (exprIsFunctionCall(expr)) {
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

          // Process collected candidates and select the best one for each variable name
          for (const [varName, candidates] of candidateVariables) {
            if (candidates.length === 1) {
              // Only one candidate, use it
              const kind = isFunctionType(candidates[0]!.$?.type)
                ? vscode.CompletionItemKind.Function
                : vscode.CompletionItemKind.Variable;
              completionItems.push(
                createCompletionItem(varName, candidates[0]!, kind)
              );
            } else {
              // Multiple candidates, prioritize them
              candidates.sort((a, b) => {
                const currentLine = position.line;

                // First priority: prefer variables declared closer to current position (but before it)
                const aIsBeforeCurrent = a.token.position.row < currentLine;
                const bIsBeforeCurrent = b.token.position.row < currentLine;

                if (aIsBeforeCurrent && bIsBeforeCurrent) {
                  // Both are before current, prefer the one closer to current position
                  return b.token.position.row - a.token.position.row;
                } else if (aIsBeforeCurrent !== bIsBeforeCurrent) {
                  // One is before current, one is not - prefer the one before current
                  return bIsBeforeCurrent ? 1 : -1;
                }

                // Second priority: prefer expressions with evaluation info
                const aHasEvalInfo = a.$ ? 1 : 0;
                const bHasEvalInfo = b.$ ? 1 : 0;

                if (aHasEvalInfo !== bHasEvalInfo) {
                  return bHasEvalInfo - aHasEvalInfo;
                }

                // Third priority: prefer non-primitive types over primitive types
                if (aHasEvalInfo && bHasEvalInfo && a.$?.type && b.$?.type) {
                  const aTypeString = typeToString(a.$.type);
                  const bTypeString = typeToString(b.$.type);

                  const aIsPrimitive =
                    aTypeString === "i32" ||
                    aTypeString === "f64" ||
                    aTypeString === "bool" ||
                    aTypeString === "str";
                  const bIsPrimitive =
                    bTypeString === "i32" ||
                    bTypeString === "f64" ||
                    bTypeString === "bool" ||
                    bTypeString === "str";

                  if (aIsPrimitive !== bIsPrimitive) {
                    return aIsPrimitive ? 1 : -1; // Prefer non-primitive
                  }
                }

                return 0;
              });

              // Use the best candidate
              const bestCandidate = candidates[0]!;
              const kind = isFunctionType(bestCandidate.$?.type)
                ? vscode.CompletionItemKind.Function
                : vscode.CompletionItemKind.Variable;
              completionItems.push(
                createCompletionItem(varName, bestCandidate, kind)
              );
            }
          }

          // Add built-in functions and keywords
          for (const builtin of basicKeywords) {
            if (builtin.toLowerCase().includes(prefix.toLowerCase())) {
              const item = new vscode.CompletionItem(
                builtin,
                vscode.CompletionItemKind.Keyword
              );

              // Sort priority: items starting with prefix get higher priority
              if (builtin.toLowerCase().startsWith(prefix.toLowerCase())) {
                item.sortText = `0_${builtin}`;
              } else {
                item.sortText = `1_${builtin}`;
              }

              completionItems.push(item);
            }
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

  // Helper function to provide dot completion items for method calls
  const provideDotCompletionItems = (
    document: vscode.TextDocument,
    position: vscode.Position,
    module: {
      moduleValue: ModuleValue;
      moduleError: Error | undefined;
      evaluator: Evaluator;
    }
  ): vscode.CompletionItem[] => {
    const completionItems: vscode.CompletionItem[] = [];

    try {
      // Get tokens to find the exact position
      const tokens = module.evaluator.getTokens();
      const program = module.evaluator.getProgram();

      // Find the token right before the dot at the current position
      const currentLine = position.line;
      const dotPosition = position.character - 1; // Position of the dot character

      // Find the token that is right before the dot
      // We need to find the token that ends right at the dot position
      let tokenBeforeDot = tokens.find((token: unknown) => {
        const t = token as {
          position: { row: number; column: number };
          value: string;
          type: TokenType;
        };
        const tokenEnd = t.position.column + t.value.length;

        const isOnSameLine = t.position.row === currentLine;
        const isNotWhitespaceOrComment =
          t.type !== TokenType.Whitespace &&
          t.type !== TokenType.SingleLineComment &&
          t.type !== TokenType.MultiLineComment;
        const tokenEndsAtDot = tokenEnd === dotPosition; // Token should end exactly where dot starts

        return isOnSameLine && isNotWhitespaceOrComment && tokenEndsAtDot;
      });

      if (!tokenBeforeDot) {
        // Approach: Look at what the user typed before the dot and find a matching variable
        const line = document.lineAt(currentLine).text;
        const textBeforeDot = line.substring(0, dotPosition).trim();

        if (textBeforeDot && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(textBeforeDot)) {
          // This looks like a valid identifier before the dot
          const identifierName = textBeforeDot;

          // Find the most recent token with this name that's before the current line
          const candidateTokens = tokens.filter((token: unknown) => {
            const t = token as {
              position: { row: number; column: number };
              value: string;
              type: TokenType;
            };
            return (
              t.value === identifierName &&
              t.type === TokenType.Identifier &&
              t.position.row < currentLine // Must be before current line
            );
          });

          if (candidateTokens.length > 0) {
            // Use the most recent one (closest to current line)
            const sortedCandidates = candidateTokens.sort(
              (a: unknown, b: unknown) => {
                const ta = a as { position: { row: number } };
                const tb = b as { position: { row: number } };
                return tb.position.row - ta.position.row; // Descending order (most recent first)
              }
            );

            tokenBeforeDot = sortedCandidates[0];
          }
        }

        if (!tokenBeforeDot) {
          return completionItems;
        }
      }

      const token = tokenBeforeDot as {
        position: { row: number; column: number };
        value: string;
        type: TokenType;
      };

      // Find the expression that corresponds to this token
      let targetExpr: Expr | null = null;

      const findExprByToken = (expr: Expr): boolean => {
        if (exprIsAtom(expr)) {
          const atomExpr = expr as AtomExpr;
          if (
            atomExpr.token.position.row === token.position.row &&
            atomExpr.token.position.column === token.position.column &&
            atomExpr.token.value === token.value
          ) {
            targetExpr = atomExpr;
            return true;
          }
        } else if (exprIsFunctionCall(expr)) {
          const funcCallExpr = expr as FuncCallExpr;
          if (findExprByToken(funcCallExpr.func)) return true;
          for (const arg of funcCallExpr.args) {
            if (findExprByToken(arg)) return true;
          }
        }
        return false;
      };

      // Search through all expressions
      for (const expr of program) {
        if (findExprByToken(expr)) break;
      }

      // If we couldn't find the exact token (e.g., when typing incomplete code),
      // try to find a variable with the same name in scope
      if (!targetExpr && token.type === TokenType.Identifier) {
        // Look for the most recent declaration of this variable
        const findVariableInScope = (expr: Expr): AtomExpr | null => {
          if (exprIsAtom(expr)) {
            const atomExpr = expr as AtomExpr;
            if (
              atomExpr.token.type === TokenType.Identifier &&
              atomExpr.token.value === token.value &&
              atomExpr.$?.type
            ) {
              // Prefer variables that are before the current line
              if (atomExpr.token.position.row < currentLine) {
                return atomExpr;
              }
            }
          } else if (exprIsFunctionCall(expr)) {
            const funcCallExpr = expr as FuncCallExpr;
            const result = findVariableInScope(funcCallExpr.func);
            if (result) return result;

            for (const arg of funcCallExpr.args) {
              const result = findVariableInScope(arg);
              if (result) return result;
            }
          }
          return null;
        };

        // Search through all expressions to find the variable
        for (const expr of program) {
          const result = findVariableInScope(expr);
          if (result) {
            targetExpr = result;
            break;
          }
        }
      }

      // Get the type from the found expression
      let variableType: Type | null = null;
      if (targetExpr) {
        if (exprIsAtom(targetExpr)) {
          // TypeScript narrowing should work here, but let's be explicit
          const atomExpr = targetExpr as AtomExpr;
          const evalInfo = atomExpr.$ as { type?: Type } | undefined;
          if (evalInfo?.type) {
            variableType = evalInfo.type;
          }
        } else {
          // Must be a FuncCall since we only set targetExpr for these two types
          const funcCallExpr = targetExpr as FuncCallExpr;
          const evalInfo = (
            funcCallExpr as FuncCallExpr & { $?: { type?: Type } }
          ).$;
          if (evalInfo?.type) {
            variableType = evalInfo.type;
          }
        }
      }

      // If no type found and we have a valid token, try fallback using environment lookup
      if (!variableType && token.type === TokenType.Identifier) {
        // Find the most recent expression that has environment info and is before the current position
        let bestEnv: unknown = null;
        let bestExprPosition = -1;

        for (const expr of program) {
          const findBestEnv = (expr: Expr) => {
            if (exprIsAtom(expr)) {
              const atomExpr = expr as AtomExpr;
              if (
                atomExpr.$?.env &&
                atomExpr.token.position.row < currentLine &&
                atomExpr.token.position.row > bestExprPosition
              ) {
                bestEnv = atomExpr.$.env;
                bestExprPosition = atomExpr.token.position.row;
              }
            } else if (exprIsFunctionCall(expr)) {
              const funcCallExpr = expr as FuncCallExpr;
              findBestEnv(funcCallExpr.func);
              for (const arg of funcCallExpr.args) {
                findBestEnv(arg);
              }
            }
          };

          findBestEnv(expr);
        }

        if (bestEnv) {
          try {
            const variables = getVariablesFromEnv(
              bestEnv as Parameters<typeof getVariablesFromEnv>[0],
              token.value
            );

            if (variables && variables.length > 0) {
              // Filter out variables that are likely struct fields by checking their position
              const localVariables = variables.filter((variable) => {
                if (variable.initializedAtToken) {
                  const varRow = variable.initializedAtToken.position.row;
                  // Variable should be declared after line 2 (not in imports/top-level struct definitions)
                  // and before the current position
                  return varRow > 2 && varRow < currentLine;
                }
                return false;
              });

              if (localVariables.length > 0) {
                // Use the most recent local variable
                const selectedVariable =
                  localVariables[localVariables.length - 1];
                if (selectedVariable?.type) {
                  variableType = selectedVariable.type;
                }
              }
            }
          } catch (error) {
            // Ignore errors in fallback variable lookup
          }
        }
      }

      // If we found a variable type, provide method suggestions based on the type
      if (variableType) {
        // Store the original type for method call compatibility checking
        const originalReceiverType = variableType;

        // Automatically dereference pointer/reference types for field access only
        let fieldAccessType = variableType;
        while (isMutPtrType(fieldAccessType)) {
          fieldAccessType = fieldAccessType.type;
        }

        const methods: {
          name: string;
          detail: string;
          documentation: string;
        }[] = [];

        if (isArrayType(fieldAccessType)) {
          // For array types, show the length field
          methods.push({
            name: "length",
            detail: "compt(usize)",
            documentation: `Get the compile-time known length of the array`,
          });
        } else if (isSliceType(fieldAccessType)) {
          // For slice types, show the length field
          methods.push({
            name: "length",
            detail: "usize",
            documentation: `Get the runtime length of the slice`,
          });
        } else if (isStructType(fieldAccessType)) {
          // For struct types, show all available fields (using dereferenced type for field access)
          for (const element of fieldAccessType.elements) {
            methods.push({
              name: element.label,
              detail: typeToString(element.type),
              documentation: `Access ${element.label} field of type ${typeToString(element.type)}`,
            });
          }

          // Also check for methods defined in the struct's module (using original type for method calls)
          if (fieldAccessType.module && fieldAccessType.module.elements) {
            // Get environment from the target expression for type compatibility checking
            let env: unknown = null;
            if (targetExpr && exprIsAtom(targetExpr)) {
              const atomExpr = targetExpr as AtomExpr;
              const evalInfo = atomExpr.$ as { env?: unknown } | undefined;
              env = evalInfo?.env;
            }

            for (const element of fieldAccessType.module.elements) {
              if (isFunctionType(element.type)) {
                // Check if the first parameter of the function matches the original receiver type (not dereferenced)
                if (element.type.parameters.length > 0 && env) {
                  const firstParamType = element.type.parameters[0]!.type;

                  // Check type compatibility between original receiver and first parameter
                  try {
                    const receiverTypeInfo = {
                      type: originalReceiverType, // Use original type for method calls
                      env: env as Parameters<
                        typeof areTypesCompatible
                      >[0]["env"],
                    };
                    const paramTypeInfo = {
                      type: firstParamType,
                      env: env as Parameters<
                        typeof areTypesCompatible
                      >[1]["env"],
                    };

                    if (areTypesCompatible(receiverTypeInfo, paramTypeInfo)) {
                      methods.push({
                        name: element.label,
                        detail: typeToString(element.type),
                        documentation: `Method ${element.label} on ${fieldAccessType.typeName || "struct"}`,
                      });
                    }
                  } catch (error) {
                    // If type compatibility check fails, include the method anyway
                    methods.push({
                      name: element.label,
                      detail: typeToString(element.type),
                      documentation: `Method ${element.label} on ${fieldAccessType.typeName || "struct"}`,
                    });
                  }
                } else {
                  // If no first parameter or no env, include the method
                  methods.push({
                    name: element.label,
                    detail: typeToString(element.type),
                    documentation: `Method ${element.label} on ${fieldAccessType.typeName || "struct"}`,
                  });
                }
              }
            }
          }
        } else if (isEnumType(fieldAccessType)) {
          // For enum types, show all available variants
          for (const variant of fieldAccessType.variants) {
            methods.push({
              name: variant.name,
              detail: variant.elements
                ? `(${variant.elements.map((e) => typeToString(e.type)).join(", ")})`
                : "()",
              documentation: `Access ${variant.name} variant of enum`,
            });
          }

          // Also check for methods defined in the enum's module
          if (fieldAccessType.module && fieldAccessType.module.elements) {
            // Get environment from the target expression for type compatibility checking
            let env: unknown = null;
            if (targetExpr && exprIsAtom(targetExpr)) {
              const atomExpr = targetExpr as AtomExpr;
              const evalInfo = atomExpr.$ as { env?: unknown } | undefined;
              env = evalInfo?.env;
            }

            for (const element of fieldAccessType.module.elements) {
              if (isFunctionType(element.type)) {
                // Check if the first parameter of the function matches the original receiver type (not dereferenced)
                if (element.type.parameters.length > 0 && env) {
                  const firstParamType = element.type.parameters[0]!.type;

                  // Check type compatibility between original receiver and first parameter
                  try {
                    const receiverTypeInfo = {
                      type: originalReceiverType, // Use original type for method calls
                      env: env as Parameters<
                        typeof areTypesCompatible
                      >[0]["env"],
                    };
                    const paramTypeInfo = {
                      type: firstParamType,
                      env: env as Parameters<
                        typeof areTypesCompatible
                      >[1]["env"],
                    };

                    if (areTypesCompatible(receiverTypeInfo, paramTypeInfo)) {
                      methods.push({
                        name: element.label,
                        detail: typeToString(element.type),
                        documentation: `Method ${element.label} on ${fieldAccessType.typeName || "enum"}`,
                      });
                    }
                  } catch (error) {
                    // If type compatibility check fails, include the method anyway
                    methods.push({
                      name: element.label,
                      detail: typeToString(element.type),
                      documentation: `Method ${element.label} on ${fieldAccessType.typeName || "enum"}`,
                    });
                  }
                } else {
                  // If no first parameter or no env, include the method
                  methods.push({
                    name: element.label,
                    detail: typeToString(element.type),
                    documentation: `Method ${element.label} on ${fieldAccessType.typeName || "enum"}`,
                  });
                }
              }
            }
          }
        } else if (isUnionType(fieldAccessType)) {
          // For union types, show all possible type elements (use dereferenced type for field access)
          for (const element of fieldAccessType.elements) {
            methods.push({
              name: element.label,
              detail: typeToString(element.type),
              documentation: `Access ${element.label} variant of union`,
            });
          }

          // Also check for methods defined in the union's module (use original type for method calls)
          if (fieldAccessType.module && fieldAccessType.module.elements) {
            // Get environment from the target expression for type compatibility checking
            let env: unknown = null;
            if (targetExpr && exprIsAtom(targetExpr)) {
              const atomExpr = targetExpr as AtomExpr;
              const evalInfo = atomExpr.$ as { env?: unknown } | undefined;
              env = evalInfo?.env;
            }

            for (const element of fieldAccessType.module.elements) {
              if (isFunctionType(element.type)) {
                // Check if the first parameter of the function matches the original receiver type (not dereferenced)
                if (element.type.parameters.length > 0 && env) {
                  const firstParamType = element.type.parameters[0]!.type;

                  // Check type compatibility between original receiver and first parameter
                  try {
                    const receiverTypeInfo = {
                      type: originalReceiverType, // Use original type for method calls
                      env: env as Parameters<
                        typeof areTypesCompatible
                      >[0]["env"],
                    };
                    const paramTypeInfo = {
                      type: firstParamType,
                      env: env as Parameters<
                        typeof areTypesCompatible
                      >[1]["env"],
                    };

                    if (areTypesCompatible(receiverTypeInfo, paramTypeInfo)) {
                      methods.push({
                        name: element.label,
                        detail: typeToString(element.type),
                        documentation: `Method ${element.label} on ${fieldAccessType.typeName || "union"}`,
                      });
                    }
                  } catch (error) {
                    // If type compatibility check fails, include the method anyway
                    methods.push({
                      name: element.label,
                      detail: typeToString(element.type),
                      documentation: `Method ${element.label} on ${fieldAccessType.typeName || "union"}`,
                    });
                  }
                } else {
                  // If no first parameter or no env, include the method
                  methods.push({
                    name: element.label,
                    detail: typeToString(element.type),
                    documentation: `Method ${element.label} on ${fieldAccessType.typeName || "union"}`,
                  });
                }
              }
            }
          }
        } else {
          // For other types, try to find methods using getMethodsByNameFromEnv
          // We'll check for common method names and see if they're available
          const commonMethodNames = [
            "is_atom",
            "is_fn_call",
            "get_callee",
            "get_args",
            "cons",
            "to_string",
            "clone",
            "equals",
            "map",
            "filter",
            "fold",
            "length",
            "head",
            "tail",
          ];

          // Get the environment from the target expression
          if (targetExpr && exprIsAtom(targetExpr)) {
            const atomExpr = targetExpr as AtomExpr;
            const evalInfo = atomExpr.$ as { env?: unknown } | undefined;
            const env = evalInfo?.env;

            if (env) {
              for (const methodName of commonMethodNames) {
                try {
                  // Type assertion is necessary here since env comes from evaluated expressions
                  const foundMethods = getMethodsByNameFromEnv(
                    env as Parameters<typeof getMethodsByNameFromEnv>[0],
                    methodName,
                    originalReceiverType // Use original type for method calls
                  );

                  if (foundMethods && foundMethods.length > 0) {
                    // Show all available methods, but check type compatibility first
                    for (const method of foundMethods) {
                      if (method && isFunctionType(method.type)) {
                        // Check if the first parameter of the function matches the original receiver type
                        if (method.type.parameters.length > 0) {
                          const firstParamType =
                            method.type.parameters[0]!.type;

                          try {
                            const receiverTypeInfo = {
                              type: originalReceiverType, // Use original type for method calls
                              env: env as Parameters<
                                typeof areTypesCompatible
                              >[0]["env"],
                            };
                            const paramTypeInfo = {
                              type: firstParamType,
                              env: env as Parameters<
                                typeof areTypesCompatible
                              >[1]["env"],
                            };

                            if (
                              areTypesCompatible(
                                receiverTypeInfo,
                                paramTypeInfo
                              )
                            ) {
                              methods.push({
                                name: methodName,
                                detail: typeToString(method.type),
                                documentation: `Method ${methodName} available on this type`,
                              });
                            }
                          } catch (error) {
                            // If type compatibility check fails, include the method anyway
                            methods.push({
                              name: methodName,
                              detail: typeToString(method.type),
                              documentation: `Method ${methodName} available on this type`,
                            });
                          }
                        } else {
                          // No parameters, include the method
                          methods.push({
                            name: methodName,
                            detail: typeToString(method.type),
                            documentation: `Method ${methodName} available on this type`,
                          });
                        }
                      }
                    }
                  }
                } catch (error) {
                  // Ignore errors for individual method lookups
                }
              }
            }
          }
        }

        // Add all found methods to completion items
        for (const method of methods) {
          const item = new vscode.CompletionItem(
            method.name,
            vscode.CompletionItemKind.Method
          );

          item.detail = method.detail;
          item.documentation = method.documentation;
          item.sortText = `0_${method.name}`;

          completionItems.push(item);
        }
      }
    } catch (error) {
      // Ignore errors and return empty completion
      console.error("Error in provideDotCompletionItems:", error);
    }

    return completionItems;
  };

  context.subscriptions.push(completionProvider);

  // Register event handlers

  // Analyze the current active editor when extension is activated
  if (vscode.window.activeTextEditor) {
    analyzeYoFile(vscode.window.activeTextEditor.document);
  }

  // Analyze when a document is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(analyzeYoFile)
  );

  // Analyze when a document is changed
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      analyzeYoFile(event.document);
    })
  );

  // Analyze when the active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        analyzeYoFile(editor.document);
      }
    })
  );

  // Register definition provider for Yo language
  const definitionProvider = vscode.languages.registerDefinitionProvider("yo", {
    provideDefinition(document, position) {
      const filePath = document.uri.fsPath;
      const modulePath = "file://" + filePath;

      // Get the module evaluator
      const module = moduleManager.modules.get(modulePath);
      if (!module) {
        return null; // No evaluated data for this file
      }

      // Get the text of the document and tokenize it
      const exprs = module.evaluator.getProgram();
      const tokens = module.evaluator.getTokens();

      // Find the token at the current position
      const line = position.line;
      const character = position.character;

      const tokenAtPosition = findTokenAtPosition(tokens, line, character);

      if (!tokenAtPosition) {
        return null;
      }

      // Find an expression with matching token
      const foundExpr = findBestExpressionMatch(
        exprs,
        tokenAtPosition,
        position.line
      );

      if (foundExpr && exprIsAtom(foundExpr)) {
        const expr: AtomExpr = foundExpr as AtomExpr;

        // Try to find the definition location
        if (expr.$?.env) {
          const env = expr.$?.env;
          const tokenText = tokenAtPosition.value; // Look for the variable in the environment
          const foundDefinition = findVariableDefinition(env, tokenText);

          if (foundDefinition) {
            const { definitionToken, definitionModulePath } = foundDefinition;

            // Convert the module path to a VS Code URI
            let definitionUri: vscode.Uri;
            if (definitionModulePath.startsWith("file://")) {
              definitionUri = vscode.Uri.file(
                definitionModulePath.replace("file://", "")
              );
            } else {
              // Handle relative paths or other formats
              definitionUri = vscode.Uri.file(definitionModulePath);
            }

            // Create the position for the definition
            const definitionPosition = new vscode.Position(
              definitionToken.position.row,
              definitionToken.position.column
            );

            // Create the range for the definition
            const definitionRange = new vscode.Range(
              definitionPosition,
              new vscode.Position(
                definitionToken.position.row,
                definitionToken.position.column + definitionToken.value.length
              )
            );

            return new vscode.Location(definitionUri, definitionRange);
          }
        }
      }

      return null;
    },
  });

  // Helper function to find variable definition in environment
  const findVariableDefinition = (
    env: Environment,
    variableName: string
  ): { definitionToken: Token; definitionModulePath: string } | null => {
    try {
      // Search through environment frames to find the variable
      for (
        let frameIndex = env.frames.length - 1;
        frameIndex >= 0;
        frameIndex--
      ) {
        const frame = env.frames[frameIndex];
        if (frame?.variables) {
          for (const variable of frame.variables) {
            if (variable.name === variableName) {
              // Found the variable definition
              return {
                definitionToken: variable.token,
                definitionModulePath: variable.token.modulePath,
              };
            }
          }
        }
      }

      // If not found in local scope, check if there's a module value in the environment
      // Look for module values in the current environment frames
      for (
        let frameIndex = env.frames.length - 1;
        frameIndex >= 0;
        frameIndex--
      ) {
        const frame = env.frames[frameIndex];
        if (frame?.variables) {
          for (const variable of frame.variables) {
            // Check if this variable is a module value that might contain the symbol
            if (variable.value && isModuleValue(variable.value)) {
              const moduleValue = variable.value as ModuleValue;
              if (moduleValue.type && moduleValue.type.elements) {
                for (let i = 0; i < moduleValue.type.elements.length; i++) {
                  const element = moduleValue.type.elements[i];
                  if (element && element.label === variableName) {
                    // Found the symbol in the module, return the variable's token as definition
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
    } catch (error) {
      console.error("Error finding variable definition:", error);
      return null;
    }
  };

  context.subscriptions.push(definitionProvider);

  // ...existing code...
}
