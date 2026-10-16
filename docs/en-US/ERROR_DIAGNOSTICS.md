# Error diagnostics — codes, `yo explain`, and machine-readable output

Yo's error channel is designed for both humans and the agents that iterate on
compiler feedback. Every error the compiler reports is a structured
diagnostic: a severity, a message, an exact source span, an optional error
code, and an optional help hint — rendered in whichever format the consumer
asks for.

## The render formats

The default (human) format is rustc-shaped — one block per entry, entry 0 is
the primary error, later entries are notes:

```bash
$ yo check ./src
error[E0401]: Variable "undefined_fn_xyz" not found.
 --> src/main.yo:12:5
  |
1 |   undefined_fn_xyz();
  |   ^^^^^^^^^^^^^^^^^^
help: run `yo explain E0401` for more information
```

`--error-format` selects the rendering. It is a **global** flag — it goes
before the subcommand — and the `YO_ERROR_FORMAT` environment variable sets
the same thing at lower precedence:

```bash
yo --error-format short check ./src     # one line per entry
yo --error-format json compile app.yo   # machine-readable
YO_ERROR_FORMAT=json yo build           # same, via the environment
```

- `human` (default) — the block render above.
- `short` — `path:row:col: error[CODE]: message`, grep-friendly.
- `json` — one JSON object per diagnostic, 0-based positions, plus the human
  render under `rendered` so a single consumer can show either:

```json
{
  "severity": "error",
  "code": "E0401",
  "message": "Variable \"undefined_fn_xyz\" not found.",
  "span": { "file": "src/main.yo", "row": 11, "col": 2, "end_col": 19 },
  "rendered": "error[E0401]: ..."
}
```

- `sarif` — the whole diagnostic group as one [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
  2.1.0 log on stdout: codes become driver rules, positions are 1-based per
  the SARIF spec, and a mechanical repair becomes a `fixes` entry — the
  field GitHub code scanning and most CI lint pipelines ingest. Never
  colored, whatever `--color` says.

`--json-summary` (accepted by the test/check drivers) additionally prints the
final `N passed / M failed` style footer as one machine-readable line, so a
harness can parse the outcome without scraping prose.

### Color

The human render colors its output when it is writing to a terminal: the
severity header and its carets carry the severity color (red/yellow/cyan),
the `-->` anchor and gutter carry blue, and `help:` labels magenta. It is a
**global** flag like `--error-format`, with the `YO_COLOR` environment
variable at lower precedence:

```bash
yo --color always check ./src    # force color even into a pipe
yo --color never check ./src     # force plain text
YO_COLOR=always yo build         # same, via the environment
```

`auto` (the default) colors only when stderr is a terminal, `NO_COLOR` is
unset (https://no-color.org), and `TERM` is not `dumb`; an explicit
`--color always` overrides all three. `short` output stays plain — it exists
for grepping — and `json` output never carries ANSI escapes, including the
human text embedded in its `rendered` field, so a machine consumer gets
byte-identical payloads whatever `--color` says. `yo lsp` ignores the flag:
protocol frames are a data channel.

### Repairs and `yo fix`

A diagnostic carries a `repair` when exactly ONE edit fixes it; the compiler
never guesses between alternatives, so a message that names two possible fixes
carries none. In the JSON render the field is
`{ "file", "row", "col", "end_col", "replacement", "description" }` (0-based,
rune columns; `col == end_col` is an insertion) — the same edit `yo fix <path>`
applies, formatting each file it rewrites and re-running until a pass changes
nothing. `yo fix --dry-run` prints the repairs without writing.

The repairs the compiler computes today:

| diagnostic | repair |
| --- | --- |
| E0401 name not found, one close candidate in scope | rename the token (`countr` → `counter`) |
| E0401 name not found, exported by exactly one std module | insert `{ name } :: import("std/…");` above the first non-comment line (the help names the module; two exporting modules, or a rename candidate as well, give help only) |
| E0007 `{ f(x) }` — one expression between braces, no `;` | insert `;` before the `}` (two or more comma-separated items give the message only) |
| E0618 a named callable passed bare into a `Dyn(Fn(...))` slot | wrap the name: `run(f)` → `run(dyn(f))` (a longer value gives help only; `--migrate dyn-spelling` wraps it) |

`yo fix <path> --migrate <name>` runs a migration rather than a repair, for
the parameter-convention change (VALUES_BY_DEFAULT V3b) and the borrow
spelling (decision 42):

- `--migrate borrow-spelling` rewrites every borrow spelled with a mode word
  to the sigil spelling: `imm(x) : T` becomes `x : &T` and `mut(x) : T`
  becomes `x : &mut T` (parameters, receivers, closure parameters, `Fn(...)`
  slots), `comptime(imm(x)) : T` becomes `comptime(x) : &T`, a local borrow
  `mut(y) := place` becomes `y := &mut place`, a re-point `mut(cur) = place`
  becomes `cur = &mut place`, the capture puns `{ imm(y), mut(z) }` become
  `{ &y, &mut z }`, and `for(xs, mut(x) => …)` becomes `for(&mut xs, x => …)`.
  The compiler rejects the mode words (E0009), and each meant exactly the
  sigil spelling. It only parses each file, so it reaches macro arguments,
  `quote(...)` templates and generic bodies too; a mode word in a position no
  rule covers is listed with its position and left as written. `inout(x) : T`,
  the spelling before `mut`, becomes `x : &mut T` as well.
- `--migrate modes` rewrites the deleted `own(x)` parameter to `sink(x)`
  (E0009 rejects `own`). It only parses each file, so it also reaches code
  evaluation never sees (macro arguments, `quote(...)` templates, test
  bodies).
- `--migrate addr-of` rewrites each `&x` that was the raw-pointer address-of
  to `addr_of(x)`. It evaluates every file, because only the evaluator knows
  which `&x` is a borrow (`show(&s)` to a `&T` parameter stays) and which is
  the address-of (a binding, a raw-pointer, by-value or variadic argument, a
  receiver). A site evaluation never reaches, or whose text no longer matches,
  is listed with its position and left as written.
- `--migrate params` runs on files that already evaluate: a plain parameter
  whose type is not `Copy` becomes a `&T` borrow, which is what a plain
  parameter meant before the flip. A generic parameter becomes a `&T` borrow
  unless its `where` bounds make it `Copy`. It writes `x : &T`.
- `--migrate markers` inserts the call-site borrow markers: `&x` before a
  bare named place (a variable, a field path, an element `xs(i)`) passed to a
  `&T` parameter, and `&mut x` before one passed to a `&mut T` parameter. It
  evaluates every file, because only the evaluator knows a parameter's mode;
  receivers, temporaries, operator operands, by-value and compile-time
  parameters, a borrow binding passed whole and ghost code (contract
  predicates, `ghost_fn` bodies) stay bare. A missing marker is E0914, always
  on, std included.

The semantic migrations reach only what evaluation reaches, so two options
widen it. `yo fix ./std ./tests --migrate markers` evaluates several paths
in one session: a generic `std` body is evaluated when a test instantiates
it, and its sites are rewritten because `std` is among the paths.
`--target <triple>` evaluates for that target, as `compile --target` does,
so a `cond(platform == ...)` arm for another platform is migrated too.

None of them changes what a program does. A file that does not evaluate keeps
what evaluation never reached, and `fix` exits non-zero naming it.

`yo fix <path> --migrate match-scrutinee` is the migration for decision 26,
under which a `match` takes an owned scrutinee by value. It evaluates each file
with the new rule and writes `&` before a scrutinee wherever the move would be
an error: an owned local used after the `match` (`match(x, …)` →
`match(&x, …)`), a module-level binding, a closure capture, and a field, element
or dereference (`match(x.f, …)` → `match(&x.f, …)`). It leaves the argument of a
`comptime_expect_error` alone, since that error is the point. A second run
records nothing.

`yo fix <path> --migrate drop-trait` is the migration for decision 45, which
renamed the destructor trait `Dispose` to `Drop` (its method `dispose` to
`drop`) and made an explicit destructor call E0915. `Dispose` becomes `Drop`
wherever it is an identifier (an `impl` entry, a `<:` bound or witness, an
import), the impl entry's `dispose :` label and every `.dispose` member that
resolves to the destructor become `drop`, a written receiver `dispose : (fn(self :
&Self)` becomes `drop : (fn(self : &mut Self)` (`Drop.drop` takes `&mut Self`,
as Rust's `drop(&mut self)`; also in a `Dispose :: trait(...)` definition), and an explicit call that ends a named value,
`x.dispose()` or `(T <: Dispose).dispose(&x)`, becomes `drop(x)`. That last row
does change the program: `drop(x)` moves `x` in, so a later use of `x` is E0901
and `check` says where. Any other explicit call (`self.dispose()`, a field's
`s.f.dispose()`) is renamed, listed with its position and left for a hand edit:
a destructor never calls a field's destructor (the fields drop after it
returns), and a resource that must be released while other references live
gets an ordinary method, such as `TcpStream.close_sync()`. The names are
rewritten from the parse, but a `.dispose` member may also be an inherent
method, another trait's method or a field, so the migration first evaluates
each file and rewrites only the members that resolve to the destructor; any
other `.dispose` member (or one in code evaluation never reached) is listed
and left as written. An inherent method named `dispose`
(`impl(T, dispose : ...)`) is listed for a hand edit too: the old compiler ran
a method of that name as a reference type's destructor, and only a `Drop`
impl's `drop` runs now, so move its body into a `Drop(drop : (fn(self : &mut
Self) -> unit)(...))` entry.

`yo fix <path> --migrate dyn-spelling` is the migration for decision 44, under
which every erasure into a `Dyn` is spelled. It evaluates each file and wraps
each callable passed bare into a `Dyn(Fn(...))` binding, field, argument or
result in `dyn(...)`: a named closure, a named `fn`, an `Impl(Fn(...))`
parameter, a closure literal (`run(f)` → `run(dyn(f))`, `S(cb : f)` →
`S(cb : dyn(f))`, a body ending in `g` → `dyn(g)`). The rejection it stands
in for is E0618. A value whose text no longer prints as the evaluated
expression on one line is listed with its position and left as written.

`yo fix <path> --migrate mutable-globals` is the migration for decision 47,
under which a module-level or `thread_local` runtime binding is immutable
(Rust's `static`) unless its name is wrapped in `mut(...)` (`static mut`).
Writing an immutable global is E0917: reassigning it, writing a field or
element of a value it holds, lending a place of that value as `&mut`, or
calling a `&mut self` method on it. A write through a `ref` handle the global
holds (`g.push(x)` on an `ArrayList`, `h.name = …` on a `ref(struct)`) is not
a write of the binding and needs no marker; only reassigning the binding does.
The migration evaluates each file and wraps the declared name of every global
written this way: `G := v` becomes `mut(G) := v`, `(G : T) = v` becomes
`(mut(G) : T) = v`, and `thread_local(G)` becomes `thread_local(mut(G))`.

The marker is what decision 18 rule 3 reads: lending a `mut(...)` global, or a
place under it, to a call (a `&`/`&mut` argument, a borrowed receiver, an
operand its operator borrows, an interpolated value) is E0916, because the
callee could reach the global by name, or await while another task writes it,
and the borrow would then change under it. Read it into a local first
(`v := G; f(&v)`) and write it back after a `&mut` call. An unmarked global
is lent freely. A global holding a `ref` handle adds two conflicts, each
reported wherever the compiler sees the second site: a lend into the storage
behind it (`&g(i)`) is E0916 when a `&mut self` method is called on it
anywhere, and a lend of a field written through it (`&h.name` after
`h.name = …`) is E0916 too. The migration marks declarations only; check the
migrated files and rewrite each E0916 it reports. In this release both errors
apply outside `std` and the compiler's own sources.

## Warnings

`check`, `compile` and `build` also carry warning-severity diagnostics for
code that compiles but looks wrong. The first family is **unused variables**:
an initialized local whose value nothing ever reads warns once at the end of
its scope —

```text
warning: unused variable `x`
 --> src/main.yo:3:3
  |
3 |   x := i32(7);
  |   ^
help: prefix the name with `_` to silence this warning
```

Reading a variable marks it used; only assigning it does not (`x := 1; x = 2;`
still warns — the value never influenced anything). A `_` name prefix silences
the warning, parameters and module-level bindings are never warned, and
warnings never change the exit code. In the `json` render they arrive as JSON
Lines with `"severity":"warning"`, in `short` as `warning:` lines.

## Error codes and `yo explain`

Errors of a known family carry a stable `EXXXX` code in the header and a
`help:` tail pointing at the explainer. The code belongs to the mistake, not to
the wording: the place that raises an error names its family, so the same
underlying mistake produces the same code whichever stage reports it (an
argument of the wrong type is E0601 whether it is a function argument or a
variant payload), and rewording a message never moves its code. Errors
without a family render without a code.

Codes are allocated in bands: E00xx–E02xx syntax, E03xx–E05xx name/scope/
module resolution, E06xx–E08xx types and traits, E09xx–E10xx ownership and
async, E11xx–E12xx comptime, E13xx internal codegen, E15xx the CLI/build/
dependency toolchain. Two of those bands name failures that have no source
span. `E1301` is the internal-compiler-error wrapper — a compiler bug, to
report rather than chase in your program. The E15xx family is what
`yo install` / `yo add` / `yo update` raise — the fetch, manifest and lock
failures an agent hits on a fresh clone:

| code | failure |
| --- | --- |
| E1501 | a dependency could not be fetched (`--offline` with nothing cached, an unreachable repository, a failed clone) |
| E1502 | no `yo.toml` at or above the working directory |
| E1503 | `yo.lock` disagrees with `yo.toml` (out of date, absent or unusable under `--locked`) |
| E1504 | the fetched dependency tree does not hash to what `yo.lock` records |
| E1505 | no tag of the dependency satisfies every requirement on it |

These render with their code and the `explain` tail like any other error, and
`--error-format json` carries the code, so an error router can branch on the
family instead of string-matching prose.

```bash
$ yo explain E0401
E0401 — name not found

A name lookup failed: the identifier is not defined in this scope.

...

Example — this fails:
    undefined_fn_xyz();
```

- `yo explain --list` — every registered code with its one-line title.
- `yo explain E0401 --format json` — the full entry as JSON (for tooling).
- `yo explain E0401 --lang zh` — the Chinese version of the entry; the
  `YO_LANG` environment variable selects the language for both `explain` and
  its defaults.

Unknown code? `yo explain` suggests the nearest registered one — the same
edit-distance engine behind the compiler's own "did you mean" hints for
misspelled names and enum variants.

## Where an error is reported

An error points at the code that caused it: the argument that does not fit its
parameter, the field a constructor call is missing. An error raised inside the
standard library, while checking a call you wrote, is reported at that call,
with the standard-library location as a note:

```
error[E0602]: Type P does not implement required trait ToString.
  --> main.yo:5:3
  |
5 |   println(p);
  |   ^^^^^^^
note: raised here, inside the standard library
  --> /…/std/fmt/index.yo:63:50
```

## Where diagnostics surface

- `yo check`, `yo compile`, `yo build`, `yo test`, `yo install` — every CLI
  edge prints each diagnostic exactly once, in the selected format.
- `yo lsp` — the language server receives diagnostics through a structured
  channel (exact ranges, no text re-parsing), so editors get precise squiggles
  even when the error originates in an imported file.
- Runtime panics carry a call-site location suffix:
  `panic: <message> (at file://…/app.yo:3:17)`.

## C-compiler diagnostics (`--line-directives`)

Yo compiles through C, and the C compiler's own diagnostics used to be the one
channel with no Yo location: an error in the generated `yo.c` pointed at a
line in a machine-generated file nobody reads. `yo compile
--line-directives` closes that gap. The emitted C carries `#line` directives
that map every statement back to its `.yo` source, and restore directives that
give compiler-generated code (drops, async state machines, runtime
scaffolding) its honest C numbering:

```c
#line 42 "app.yo"
  len := __yo_strlen(...);
#line 2603630 "out.c"
```

With the flag on:

- a C debugger (lldb/gdb on the compiled binary, ideally with `-g`) steps
  through `.yo` files — breakpoints on Yo lines and files work;
- C-compiler diagnostics for code that came from Yo report the `.yo`
  position, and a failed compile re-renders them as regular structured
  diagnostics in the selected `--error-format` — `error: incompatible
  pointer types` shows a `--> app.yo:12:9` anchor like any Yo error;
- `--emit-chunks` works: each translation unit's restore directives name that
  unit's own chunk file.

The flag is off by default (it grows the emitted C and is a debugging aid);
combine it with `-g` when you want a source-level debugging session.

## Exit codes

Errors exit `1`, success exits `0` — both in every format. Machine consumers
should rely on the exit code for the outcome and on the JSON output for the
detail, not on parsing prose.
