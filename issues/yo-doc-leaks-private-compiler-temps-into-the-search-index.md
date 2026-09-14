# `yo doc` publishes 790 compiler-internal temporaries in the std search index

**Status:** OPEN — found 2026-09-14, incidentally, while byte-comparing
`yo doc ./std` output across two compiler builds to confirm that switching
`markdown_to_html` from `*(Options)` to by-value changed no rendering.

**Not caused by that change**, and not fixed by this PR — it is pre-existing
and wants its own change, since a fix moves every page under `yo doc`.

## Symptom

The generated `window.__SEARCH_INDEX` on every page carries entries like

```json
{"name":"__private_tmp_temp_10626258249951560750",
 "kind":"constant",
 "href":"prelude.html#const-__private_tmp_temp_10626258249951560750",
 "module":"prelude"}
```

790 distinct ones in `module/prelude.html` alone. They are compiler-generated
temporaries, not API — a reader searching the standard-library docs is offered
them as `constant` results, with anchors to sections that document nothing.

## Second-order effect: `yo doc` output is not reproducible across builds

The numeric suffixes are stable for a given compiler binary — the same binary
run twice produces byte-identical output — but they DIFFER between compiler
builds:

```
same binary, two runs      -> byte-identical
two builds of the compiler -> all 176 html files differ
```

and in every one of those 176 files, the ONLY difference is this line. So any
byte-comparison of documentation across two compilers reports a 100% change
rate that is entirely noise. That is what made this visible: the comparison it
was invented to answer ("did the by-value switch change rendering?") could not
be read until the temps were accounted for, and the honest answer — nothing
else differs, at all — is only reachable by looking past them.

Anyone gating documentation on byte-identity, or diffing the published site
between releases, gets the same wall of false positives.

## Where to look

The doc extractor collects module exports without filtering the `__private_`
prefix. `src/doc/` (extractor → model → renderers); the search index is built
alongside the page render in `src/doc/render_html.yo`. The prefix is already
the compiler's own convention for "not user-facing", so the filter is likely
a one-line predicate — but it belongs with a look at whether other generated
names (`__yo_`, temp trait impls) reach the same list, and it will move every
generated page, so it should land on its own.
