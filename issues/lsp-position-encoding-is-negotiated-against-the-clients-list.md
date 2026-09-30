# `positionEncoding` is answered without negotiating against the client's offered list

**Severity:** S3 — when a client offers ONLY `utf-8` in
`general.positionEncodings`, the server answered `utf-16` — an encoding the
client never offered — and then converted every column into units the client
cannot read (all positions off by the BMP/astral difference on any non-ASCII
line). Found 2026-09-30 by the closeout review of the 2026-09-29 audit.

## Reproduction

```
initialize params: {"capabilities":{"general":{"positionEncodings":["utf-8"]}}}
```

Pre-fix reply: `"positionEncoding":"utf-16"` — the server's logic was
"utf-32 if offered, else utf-16, unconditionally", never consulting the rest
of the list. A utf-8-only client (they exist: the encoding is legal per LSP
3.17) then receives rune↔UTF-16-converted columns where it expects byte
offsets.

## Root cause

`_client_offers_utf32` answered one boolean; the negotiation needs the whole
offered list to pick a mutually-supported encoding.

## Fix

`_negotiated_encoding` (`src/lsp/server.yo`) reads the offered list and
picks `utf-32` when offered (the server's native unit — nothing converts),
else `utf-16` (the protocol default), else `utf-8`; an absent or empty list
means the default, utf-16. `protocol.yo`'s conversion layer became a
tri-state (`set_position_encoding`), with new `rune_col_to_utf8_col` /
`utf8_col_to_rune_col` byte-offset helpers mirroring the UTF-16 pair
(mid-rune columns belong to the rune that spans them, past-the-end clamps).
Pinned by the `lsp-position-encoding-utf8` cli-case — the same emoji-line
document as the utf-16/utf-32 cases, with byte-column requests.
