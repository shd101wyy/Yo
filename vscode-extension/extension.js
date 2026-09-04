// Yo Language extension entry — LSP client wiring (plans/archive/P4_LSP.md slice 6,
// brought forward for the diagnostics MVP).
//
// Plain JavaScript ON PURPOSE: the extension stayed build-step-free when it
// went syntax-only (P2.5 B2), and a plain-JS entry keeps it that way —
// `vsce package` ships this file and the vscode-languageclient dependency
// as-is, no bundler, no tsc.
//
// The server is the `yo` binary itself (`yo lsp`, stdio transport). The
// binary comes from the `yo.binPath` setting, defaulting to "yo" on PATH.

"use strict";

const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client = null;

function serverOptions() {
  const config = vscode.workspace.getConfiguration("yo");
  const binPath = (config.get("binPath") || "yo").trim() || "yo";
  return {
    command: binPath,
    args: ["lsp"],
    transport: TransportKind.stdio,
  };
}

async function startClient(context) {
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "yo" }],
    // Full-document sync is what the server advertises; the client library
    // follows the server's capabilities automatically.
  };

  client = new LanguageClient(
    "yoLsp",
    "Yo Language Server",
    serverOptions(),
    clientOptions
  );

  try {
    await client.start();
  } catch (err) {
    client = null;
    const pick = await vscode.window.showWarningMessage(
      `Yo: could not start the language server (\`${serverOptions().command} lsp\`). ` +
        "Set `yo.binPath` to your yo binary, or install yo (https://github.com/shd101wyy/Yo). " +
        "Syntax highlighting keeps working without it.",
      "Open Settings"
    );
    if (pick === "Open Settings") {
      vscode.commands.executeCommand("workbench.action.openSettings", "yo.binPath");
    }
  }
}

async function stopClient() {
  if (client) {
    const c = client;
    client = null;
    try {
      await c.stop();
    } catch (_e) {
      /* already dead */
    }
  }
}

function activate(context) {
  const config = vscode.workspace.getConfiguration("yo");
  if (config.get("lsp.enabled") !== false) {
    startClient(context);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("yo.binPath") || e.affectsConfiguration("yo.lsp.enabled")) {
        await stopClient();
        const cfg = vscode.workspace.getConfiguration("yo");
        if (cfg.get("lsp.enabled") !== false) {
          await startClient(context);
        }
      }
    })
  );
}

function deactivate() {
  return stopClient();
}

module.exports = { activate, deactivate };
