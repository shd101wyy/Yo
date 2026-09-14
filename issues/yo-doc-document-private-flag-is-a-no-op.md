# `yo doc --document-private` is parsed, threaded, and never read

**Status:** OPEN — found 2026-09-14 while fixing
`issues/fixed/yo-doc-publishes-compiler-temporaries-as-api.md`. Not the cause
of that bug, and deliberately not fixed with it.

## The flag does nothing

`--document-private` is advertised in `yo doc --help`, in both languages:

```
--document-private        Include underscore-private items
--document-private        包含下划线私有的条目
```

It is parsed (`src/main.yo:5167`), stored (`src/main.yo:5168`), placed in the
config (`src/main.yo:5233`), declared on the type (`src/doc_command.yo:42`) and
forwarded by the build runner (`src/build_runner.yo:2259`) — and then **nothing
reads it**. `grep -rn 'include_private' src` returns only the assignment sites;
there is not one use in `src/doc/`. So the flag is inert in both directions:
passing it changes nothing, and omitting it hides nothing.

This is the "exported but never called" shape — a complete-looking mechanism
whose last link is missing, with every gate green because nothing tests the
behaviour the flag names.

## What actually happens today

Underscore-private items are absent from generated docs, but not because they
are filtered. The doc model is built from a module's evaluated fields, and a
helper like `std/string`'s `_is_whitespace_byte` is never exported, so it does
not reach the builder at all. The observable behaviour therefore *resembles*
`--document-private=false` by accident, which is why the dead flag went
unnoticed: the default looks implemented.

An exported-but-underscore-named item — `_helper` in a module that exports it —
is documented today regardless of the flag. That is the case where the
difference is visible.

## Why it was not fixed alongside the temps leak

They are unrelated defects that happen to meet in `build_doc_module`. The temps
fix answers "is this name compiler-generated", which has one correct answer.
This flag asks "should underscore-private API be documented", which is a policy
question needing a decision first:

- does underscore-privacy mean one leading underscore, and what about `__`?
- does the flag apply to methods and trait members, not only module fields?
- when it is off, should the items vanish or render marked-private?

`is_compiler_internal_field_name` deliberately does NOT swallow `_helper`
(tested), so it leaves this decision open rather than quietly taking it.

## Fixing it

Either implement the filter in `build_doc_module` gated on the config, or
remove the flag and its help text. Whichever is chosen, the gate must be a test
that passes the flag BOTH ways and asserts the output differs — the absence of
such a test is the whole reason a dead flag survived being threaded through
five files.
