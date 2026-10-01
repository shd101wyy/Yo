# The VS Code extension's `engines.vscode` floor is below its own client library's

**Severity:** S3 — `vscode-extension/package.json` declared
`"engines": {"vscode": "^1.70.0"}` while its dependency
`vscode-languageclient@^9.0.1` requires `^1.82.0`. On VS Code 1.70–1.81 the
Marketplace happily installs the extension (the engine floor says it works),
where the client library may fail to activate — the user gets syntax
highlighting with no language server and no error pointing at the version.
Found 2026-09-30 by the closeout review of the 2026-09-29 audit (the
extension was in the audit's scope, the version floor was not).

## Fix

Raise `engines.vscode` to `^1.82.0` — the client library's own floor — and
say so in the README. Nothing in `extension.js` needs a higher API level.
