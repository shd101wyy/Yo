import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // The LSP server is bundled into the main yo project build output.
  // Look for it relative to this extension's root or via the yo-cli.
  const serverModule = resolveServerPath(context);
  if (!serverModule) {
    vscode.window.showErrorMessage(
      "Yo LSP server not found. Run `bun run build` in the Yo project root."
    );
    return;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "yo" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.yo"),
    },
  };

  client = new LanguageClient(
    "yoLanguageServer",
    "Yo Language Server",
    serverOptions,
    clientOptions
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

/**
 * Resolve the path to the LSP server module.
 * Search order:
 * 1. Sibling `yo-lsp.cjs` (when extension ships bundled with the server)
 * 2. `../../out/cjs/yo-lsp.cjs` (development: relative to vscode-extension/)
 */
function resolveServerPath(
  context: vscode.ExtensionContext
): string | undefined {
  const candidates = [
    // Bundled alongside the extension
    path.join(context.extensionPath, "out", "yo-lsp.cjs"),
    // Development layout: vscode-extension/out/../../../out/cjs/yo-lsp.cjs
    path.join(context.extensionPath, "..", "out", "cjs", "yo-lsp.cjs"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
