# A `c_include` function that returns a `const` pointer fails the C build under clang

**Severity:** S2 — a valid program is rejected: any binding of a C function whose result is `const char *` (raylib's `TextFormat` and 14 other raylib functions, libc's `gai_strerror`, …) fails to compile under clang, the default C compiler on macOS and the one CI uses; the only workaround is a C flag the user has to know about.

Found by the README example-project rehearsal for v0.2.75 (tetris_yo, `DrawText(TextFormat("LINES: %04i", lines), …)`); reproduced with the v0.2.74 seed and with develop d76eac577.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
c_include("<netdb.h>", gai_strerror : (fn(code : i32) -> *char));
c_include("<stdio.h>", puts : (fn(s : *char) -> i32));

main :: (fn() -> unit)({
  unsafe(puts(gai_strerror(i32(-2))));
});

export(main);
```

```text
$ yo compile constret.yo -o a.out          # clang, any --optimize level
a.out.c:2182:9: error: initializing 'char *' with an expression of type 'const char *' discards qualifiers [-Werror,-Wincompatible-pointer-types-discards-qualifiers]
 2182 |   char* _file____home_temp_65581116933219415530 = gai_strerror(-2);
```

With `--cc gcc` the same C is a warning and the program runs (`Name or service not known`). With clang, `--cflags "-Wno-incompatible-pointer-types-discards-qualifiers"` makes it compile.

## Root cause

Three facts intersect:

1. Yo has no const-pointer spelling, so the binding can only say `*(char)` for a `const char *` result.
2. Codegen hoists the call's result into a temporary of the binding's declared C type (`char* tmp = gai_strerror(-2);`) — even when the value then goes straight into a `const char *` parameter, where the C would have been fine.
3. The driver passes `-Werror=incompatible-pointer-types` (src/main.yo, the warnings block above the `-Wno-everything` comment), and clang groups `-Wincompatible-pointer-types-discards-qualifiers` under it, so dropping `const` on initialization is a hard error. That flag is deliberate (a codegen pointer mismatch is never noise, `issues/fixed/release-builds-suppress-all-c-warnings.md`), and should stay.

`issues/fixed/windows-ucrt-execve-const-qualifiers-break-self-build.md` hit the same wall from the argument side and worked around it per call (`*void` parameters). A result has no such workaround in the binding: `-> *(void)` forces a cast at every use.

## Recommendation

When codegen stores the result of a `c_include`d function into a temporary or a local, cast it to the declared C type: `char* tmp = (char*)gai_strerror(-2);`. The cast is exactly what the Yo binding asserts (the result is a `*(char)`), it drops only qualifiers the Yo type system cannot express, and it keeps `-Werror=incompatible-pointer-types` meaningful for pointers codegen produces itself. The alternative, a const-pointer type in the language, is a design question larger than this bug.

Until then, a project that binds such functions adds `-Wno-incompatible-pointer-types-discards-qualifiers` to its executable's C flags (tetris_yo's `build.yo` does).

A test belongs in `tests/` once the fix lands: the reproducer above, compiled with clang, run, and its output checked.
