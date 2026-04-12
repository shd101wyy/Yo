import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { LspDocumentManager } from "./document-manager";
import { getDiagnosticsForUri } from "./diagnostics";
import { handleHover } from "./hover";
import { handleCompletion } from "./completion";
import { handleDefinition } from "./definition";
import { handleDocumentSymbol } from "./symbols";
import { handleReferences } from "./references";
import { handleRename, handlePrepareRename } from "./rename";
import { handleSignatureHelp } from "./signature-help";
import { handleFoldingRange } from "./folding";

// Explicitly use stdio transport
const connection = createConnection(
  ProposedFeatures.all,
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

// Create the text document manager
const documents = new TextDocuments(TextDocument);

// Our document manager wrapping the Yo evaluator
let docManager: LspDocumentManager;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  // Try to find the std path from workspace folders
  let stdPath: string | undefined;
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    // The document manager will resolve std path per-file
    stdPath = undefined;
  }

  docManager = new LspDocumentManager(stdPath);

  // Wire up document lifecycle to diagnostics
  docManager.attachToDocuments(documents, (uri: string) => {
    const document = documents.get(uri);
    const diagnostics = getDiagnosticsForUri(
      uri,
      docManager,
      document?.getText()
    );
    connection.sendDiagnostics({ uri, diagnostics });
  });

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      completionProvider: {
        triggerCharacters: [".", ":", "("],
        resolveProvider: false,
      },
      definitionProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
      },
      foldingRangeProvider: true,
    },
  };
});

connection.onHover((params) => {
  return handleHover(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    docManager
  );
});

connection.onCompletion((params) => {
  // We need the line text for dot-completion detection
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const lineText =
    document.getText({
      start: { line: params.position.line, character: 0 },
      end: { line: params.position.line + 1, character: 0 },
    }) ?? "";

  return handleCompletion(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    lineText,
    docManager
  );
});

connection.onDefinition((params) => {
  return handleDefinition(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    docManager
  );
});

connection.onDocumentSymbol((params) => {
  return handleDocumentSymbol(params.textDocument.uri, docManager);
});

connection.onReferences((params) => {
  return handleReferences(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    docManager
  );
});

connection.onRenameRequest((params) => {
  return handleRename(params, docManager);
});

connection.onPrepareRename((params) => {
  return handlePrepareRename(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    docManager
  );
});

connection.onSignatureHelp((params) => {
  return handleSignatureHelp(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    docManager
  );
});

connection.onFoldingRanges((params) => {
  return handleFoldingRange(params.textDocument.uri, docManager);
});

// Listen for document events
documents.listen(connection);

// Start listening
connection.listen();
