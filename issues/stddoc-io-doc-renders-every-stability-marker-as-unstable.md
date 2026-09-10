# `yo doc` renders a `stable` `## Stability` marker as "this one may still change"

**Status:** open. Found while adding `## Stability` sections during the
2026-09-11 std `///` doc sweep. Documentation-only PR — filed, not fixed.

**This affects the whole sweep.** Five agents are adding `## Stability`
sections to ~41 std modules, and every one that honestly says `stable` will
render as a warning that says the opposite.

## What happens

Both renderers append a HARDCODED tail to the marker text, and the tail
assumes the module is unstable.

`src/doc/render_html.yo:1481`:

```rust
html.push_string(`<div class="stability stability-${_escape_html(level)}"><strong>Stability: ${_escape_html(st)}</strong> — stable modules only change additively; this one may still change.</div>`);
```

`src/doc/render_markdown.yo:605`:

```rust
lines.push(`> **Stability: ${st}** — stable modules only change additively; this one may still change.`);
```

So a module whose header says

```
//! ## Stability
//!
//! stable — names mirror Rust's `csv` crate, the surface is covered by
//! tests/encoding/csv.test.yo, and additions would be additive.
```

renders as

> **Stability: stable — names mirror Rust's `csv` crate, … additions would be
> additive.** — stable modules only change additively; **this one may still
> change.**

which contradicts itself in one sentence.

`level` (the marker's first word, lowercased) IS computed and interpolated
into the CSS class, so the renderer already knows the difference — it just
does not use it for the prose.

## The CSS compounds it

`src/doc/render_html_assets.yo:240-244`:

```rust
s.push_str(".stability {\n");
s.push_str("  margin: 0.5rem 0 1rem 0; padding: 0.5rem 0.75rem; border-radius: 6px;\n");
s.push_str("  border: 1px solid #d8a200; background: #fff7d6; color: #5a4300;\n");
s.push_str("}\n");
s.push_str(".stability-unstable strong { color: #a36b00; }\n");
```

The amber warning box (`#d8a200` border, `#fff7d6` background) is on the base
`.stability` class, not on `.stability-unstable`. Only the `strong` colour is
per-level, and there is no `.stability-stable` rule at all — so a `stable`
marker gets the same "caution" styling as an unstable one.

## Why nobody hit it before

Until now the section only ever appeared on modules that WERE unstable. The
convention in `.github/instructions/yo-design.instructions.md` is that a std
module is stable *by the absence* of the section:

> every `std` module is **stable** unless its module doc carries a
> `## Stability` section … Drop the section to freeze it.

`std/encoding/csv.yo` is the worked example: #352 added
`unstable — new in v0.2.20`, and #421 ("decide the four expired windows")
DELETED the section to freeze the module. Under that convention the hardcoded
tail was always true, because the section's mere presence meant unstable.

The doc sweep changes the premise: it asks every module for an EXPLICIT
`stable` or `unstable` plus a reason, which is more useful to a reader than an
absence — but the renderers were written for the old rule.

## Suggested fix (not applied)

Key the tail on the `level` the renderer already computes, in both renderers:

```rust
tail := cond(
  (level == `stable`) => ` — additive changes only.`,
  true => ` — stable modules only change additively; this one may still change.`
);
```

and add a `.stability-stable` CSS rule with a neutral or green palette,
moving the amber into `.stability-unstable`.

Worth deciding at the same time: whether the ABSENCE of the section should
keep meaning "stable" once every module carries one explicitly. Two ways to
say the same thing is how the two got out of sync.

## Coverage

`tests/internal/doc_stability.test.yo` and `tests/internal/doc_sections`
exercise the marker's extraction and collapsing (`module_stability`,
`src/doc/builder.yo:99` — correct, and well documented). Neither asserts
anything about the rendered PROSE, which is why this survived. A fix wants a
test per level in both renderers.
