# Hover claims markdown `MarkupContent` without consulting `hover.contentFormat`

**Severity:** polish — hover always answered
`{"kind":"markdown","value":…}` even for clients whose
`textDocument.hover.contentFormat` excludes markdown (they asked for
plaintext and may render the markdown source verbatim). Found 2026-09-30 by
the closeout review. VS Code accepts markdown, so nothing showed there.

## Fix

`initialize` reads the capability (`_client_accepts_markdown_hover` —
absent or empty means the protocol default, markdown first) and records it
in `protocol.yo` (`set_hover_markdown`); the hover reply's `MarkupContent`
kind follows it. The value keeps its shape: the markdown-flavored text is
still readable as plaintext, and stripping it would lose the code blocks
for clients that DO want them.
