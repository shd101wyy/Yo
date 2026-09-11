# `Regex.split` interleaves capture groups and emits the literal string `"undefined"`

**Status:** open (found by the `std/` `///` doc sweep, 2026-09-11)
**File:** `std/regex/index.yo` — `Regex.split`, and through it the `Pattern`
impl's `split_of`, i.e. `String.split(re)` as well.

## Behaviour

Verbatim output of the reproducer (`yo compile … --optimize 2`, macOS arm64):

```
-- ,(x)? split of a,b --
a
undefined
b
-- (-) split of a-b-c --
a
-
b
-
c
-- String.split(re) --
a
undefined
b
```

Two separate surprises:

1. **Capture groups are interleaved into the result.** After each piece, the
   text of every declared group is pushed as well, so `(-)` splitting
   `"a-b-c"` yields five entries, not three.
2. **A group that did not participate contributes the literal string
   `"undefined"`.** The body has:

   ```rust
   grp := m.group(gi);
   match(
     grp,
     .Some(g) => { parts.push(g); },
     .None => { parts.push(`undefined`); }
   );
   ```

Both are `String.prototype.split(regexp)`'s behaviour. JavaScript's array can
hold `undefined`; Yo's `ArrayList(String)` cannot, so the JS semantics were
approximated by rendering the word.

## Why it matters

`"undefined"` is indistinguishable from a real captured piece. A pattern like
`,(x)?` over user data cannot tell "the group did not match" from "the group
captured the six letters u-n-d-e-f-i-n-e-d", and there is no flag or variant
to check. The value also flows into `String.split(re)`, so a caller who never
touched `std/regex` directly can receive it.

Rust's `Regex::split` yields only the text between matches — no groups, no
sentinel. Python's `re.split` DOES include groups (like JS) but yields `None`
for a non-participating one, which is `Option`, not a magic string.

## Root cause

`std/regex/index.yo`, `Regex.split`: the group-interleaving loop with the
`.None => parts.push(`undefined`)` arm quoted above. There is no other
mechanism involved — the VM reports the group as absent correctly.

## Suggested fix (breaking either way)

Pick one and document it:

- **Rust's shape:** drop the group interleaving entirely; `split` yields only
  the pieces. Simplest, and matches the rest of `std`'s Rust-ward bearing.
- **Python's shape:** keep the interleaving but return
  `ArrayList(Option(String))`, so a non-participating group is `.None`.

Either changes the return value or the return type, so it belongs with the
other `std/regex` shape decisions listed in the module's `## Stability`
section rather than as a silent fix.

## Reproducer

`issues/repros/stddoc-str-regex-split-emits-the-literal-string-undefined.yo`

## Not fixed here

Found during a documentation-only sweep. `Regex.split`'s doc comment and the
module's `## Stability` section now describe both behaviours and point here;
the behaviour is untouched.
