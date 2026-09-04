# Yo Version Management (`.yo-version`)

## Problem

When users pin their projects to a specific Yo version, the toolchain (CLI, LSP) must use
the correct version's compiler and standard library. Currently there is no version-pinning
mechanism — everyone runs whatever global `yo` they have installed. This causes:

1. **Reproducibility issues** — different developers may have different Yo versions.
2. **Incorrect go-to-definition** — the LSP resolves `import "std/string"` to the local
   `std/` directory, which may not match the version the project targets.
3. **No upgrade path** — there's no way to test a new Yo version without globally updating.

## Design

### `.yo-version` file

A plain-text file at the project root (next to `build.yo`) containing a single line:

```
0.1.12
```

Rules:

- Leading `v` is automatically stripped (`v0.1.12` → `0.1.12`).
- The version must be a valid semver string published on npm (`@shd101wyy/yo`).
- `latest` is **not** supported — it defeats the purpose of pinning.
- Invalid or unpublished versions produce a clear error with available versions.
- Whitespace and trailing newlines are trimmed.

### Version resolution

When any `yo` CLI command is invoked:

1. Walk up from `process.cwd()` looking for `.yo-version` (stop at filesystem root).
2. If not found → use the globally installed version (current behavior, no change).
3. If found → parse the version string.
4. Compare with the currently running version (`packageJson.version`).
5. If they match → proceed normally.
6. If they differ → download/cache the specified version, then re-exec the command
   using the cached version's `yo-cli.cjs`.

### Version cache

Versioned Yo installations are stored in the global cache directory:

```
~/.cache/yo/
  deps/               ← existing git dependency cache
  versions/           ← NEW: versioned Yo installations
    0.1.12/
      out/            ← compiled JS (yo-cli.cjs, etc.)
      std/            ← standard library for this version
      vendor/         ← vendored dependencies
      package.json
    0.1.13/
      ...
```

Download mechanism:

- Fetch the npm tarball: `https://registry.npmjs.org/@shd101wyy/yo/-/yo-<version>.tgz`
- Extract to `~/.cache/yo/versions/<version>/`
- First-time download prints a message: `Downloading Yo v0.1.12...`
- If already cached, no network request needed.

### CLI re-dispatch

At the very top of `yo-cli.ts`, before yargs processes any command:

```typescript
// Pseudocode
const pinnedVersion = findYoVersion(process.cwd());
if (pinnedVersion && pinnedVersion !== packageJson.version) {
  const cachedDir = await ensureCachedVersion(pinnedVersion);
  // Re-exec with the same arguments
  const cliPath = path.join(cachedDir, "out/cjs/yo-cli.cjs");
  const runtime = findRuntime(); // "node" or "bun"
  const result = execFileSync(runtime, [cliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, YO_VERSION_DISPATCHED: "1" },
  });
  process.exit(result.status ?? 0);
}
```

Key details:

- `YO_VERSION_DISPATCHED=1` env var prevents infinite re-dispatch loops.
- `stdio: "inherit"` ensures transparent passthrough of stdin/stdout/stderr.
- Runtime detection: tries `node` first, then `bun`. If neither is found, prompts the user.
- Uses `child_process.execFileSync` for synchronous dispatch (CLI is inherently synchronous).
- The outer process exits with the same code as the inner process.

### LSP std path resolution

For go-to-definition on `import "std/XXX"`, the LSP needs the correct `std/` directory:

1. In `document-manager.ts`, `findStdPath()` currently walks up looking for `std/`.
2. **New behavior**: Before the walk-up, check for `.yo-version` in the workspace.
3. If `.yo-version` exists and specifies a non-current version:
   - Ensure the version is cached (download if needed).
   - Return `~/.cache/yo/versions/<version>/std/` as the std path.
4. If `.yo-version` matches the current version or doesn't exist → existing behavior.

This ensures that "Go to Definition" on `import "std/string"` opens the correct version's
`std/string.yo` file, not the development workspace's `std/`.

### CLI commands

#### `yo version` (new command group)

```bash
yo version                    # Show current Yo version and .yo-version if present
yo version pin [version]      # Create .yo-version in current directory
yo version install <version>  # Pre-download a specific version to cache
yo version list               # List all cached versions
yo version clean              # Remove all cached versions
```

**`yo version pin [version]`:**

- If `version` is specified: validates against npm registry, writes `.yo-version`.
- If no version: writes the currently running version to `.yo-version`.
- Example: `yo version pin 0.1.12` → creates `.yo-version` with `0.1.12`.

**`yo version install <version>`:**

- Downloads and caches the specified version without running anything.
- Useful for CI/offline environments.

**`yo version list`:**

- Shows locally cached versions.
- Marks the currently active version (from `.yo-version` or global).

**`yo version clean [version]`:**

- With no argument: removes `~/.cache/yo/versions/` directory (all cached versions).
- With a version argument: removes only that specific version from cache.
- Asks for confirmation first.

### Integration with `yo init`

`yo init` does not auto-create `.yo-version`. Users opt in via `yo version pin`
after project creation. The `.gitignore` template does NOT ignore `.yo-version` —
it should be committed when present.

## Implementation Plan

### Phase 1: Core version file + cache infrastructure

**New files:**

- `src/version.ts` — `.yo-version` file discovery, parsing, validation
- `src/version-cache.ts` — Version download, extraction, cache management

**Modified files:**

- `src/cache.ts` — Add `getGlobalVersionsCacheDir()` helper
- `src/yo-cli.ts` — Add re-dispatch logic at top, add `version` command group
- `src/init.ts` — Generate `.yo-version` in new projects

**Implementation details:**

`src/version.ts`:

- `findYoVersionFile(startDir: string): string | null` — walk up to find `.yo-version`
- `parseYoVersion(content: string): string` — trim, strip `v`, validate semver
- `getCurrentYoVersion(): string` — return `packageJson.version`

`src/version-cache.ts`:

- `getGlobalVersionsCacheDir(): string` — returns `<cache>/versions/`
- `isVersionCached(version: string): boolean` — check if version dir exists
- `downloadVersion(version: string): Promise<string>` — download from npm, extract
- `ensureCachedVersion(version: string): Promise<string>` — download if needed
- `listCachedVersions(): string[]` — list cached version dirs
- `cleanVersionCache(): void` — remove all cached versions

### Phase 2: CLI integration

- Add version detection + re-dispatch at top of `yo-cli.ts`
  (before `yargs` processes anything)
- Add `yo version` command group with subcommands
- Add `YO_VERSION_DISPATCHED` env var guard

### Phase 3: LSP integration

**Modified files:**

- `src/lsp/document-manager.ts` — Update `findStdPath()` to check `.yo-version`

### Phase 4: Tests + documentation

**Tests:**

- `src/tests/version.test.ts` — version file parsing, discovery, validation
- Test: valid version `0.1.12`
- Test: version with `v` prefix `v0.1.12`
- Test: whitespace trimming
- Test: invalid version errors
- Test: `.yo-version` discovery (walks up directories)
- Test: no `.yo-version` → returns null

**Documentation:**

- `docs/en-US/VERSION_MANAGEMENT.md`
- `docs/zh-CN/VERSION_MANAGEMENT.md`
- Update `README.md` with version management section

## Error Messages

```
Error: Yo version 0.1.99 specified in .yo-version is not available.
Available versions: 0.1.0, 0.1.1, ..., 0.1.14

Run `yo version pin 0.1.14` to use the latest version.
```

```
Error: Invalid version "latest" in .yo-version.
Specify a concrete version number (e.g., 0.1.14).
```

```
Downloading Yo v0.1.12 from npm...
Installed Yo v0.1.12 to ~/.cache/yo/versions/0.1.12/
```

## Cache Directory Layout (Updated)

```
~/.cache/yo/
  deps/                      ← git dependency cache (existing)
    repo-abc123def456/
  versions/                  ← versioned Yo installations (NEW)
    0.1.12/
      package.json
      out/cjs/yo-cli.cjs    ← CLI entry point for this version
      std/                   ← standard library
      vendor/                ← vendored deps (mimalloc, etc.)
    0.1.13/
      ...
```

## Security Considerations

- Only fetch from `registry.npmjs.org` — no arbitrary URLs.
- Validate that the downloaded package name matches `@shd101wyy/yo`.
- Tarball integrity is verified by npm's registry (SHA-512 in manifest).
- Never execute code from the tarball during download — only extract files.
- The re-dispatch uses `execFileSync("node", ...)`, not `exec(string)`.

## Future Considerations

- **Range specifiers** (`^0.1.0`, `~0.1.12`): Not supported initially.
  Could be added later, but concrete versions are simpler and more reproducible.
- **Auto-update**: `yo version update` could check for newer versions and
  update `.yo-version`. Not in initial scope.
- **CI integration**: `yo version install` pre-downloads for offline CI.
- **Multiple version files**: Like `.nvmrc`, we only look for `.yo-version`.
  No support for `package.json` engines field or similar.
