# Should identifier completion match by substring instead of prefix?

> Design question from the 2026-09-29 audit (`plans/archive/LSP_AUDIT_2026-09-29.md`).

**Status: DECIDED — prefix matching.** Maintainer verdict 2026-09-30 while
closing the audit out: `_matches_prefix` now uses `starts_with` (identifier,
env and import-list completion; dot completion already did), ranking
unchanged. The substring behavior was not a deliberate fuzzy decision — the
helper's name said prefix — and bare clients (Neovim without fuzzy
filtering, helix) rendered the noise on every keystroke.

`_matches_prefix` (`src/lsp/completion.yo`) is named for prefix matching but
implements `name.to_lowercase().contains(prefix_lower)`. Measured (probe
session C): at the typed prefix `oi`, the completion list contains `Point`,
`IntoIterator` and `JoinHandle` — none starts with `oi`. Items that DO start
with the prefix get `sortText` prefix `0_`, the rest `1_`, so ranking is
sensible; and VS Code applies its own client-side filter over server items,
which hides the noise there. Clients that render the server list as-is
(Neovim's built-in completion without fuzzy filtering, helix) show the
substring noise on every keystroke — a one-character prefix matches most of
the document plus most of the prelude.

## Recommendation

Keep substring matching only if it is a deliberate fuzzy-completion decision;
the evidence says it is not (the helper's name says prefix, and only
`_sort_key` was adapted around it). Recommend switching identifier/env/
import-list completion to `starts_with` (dot completion already filters by
`starts_with` in its own paths — `_import_items` and the enum-prefix path
both do), leaving ranking unchanged. If fuzzy matching is wanted, do it
deliberately: compute it per client capability or behind a setting, and name
the helper for what it does. Cheap to try either way: flip the predicate and
eyeball one session per mode (identifier, dot, import list) in VS Code and a
bare client.
