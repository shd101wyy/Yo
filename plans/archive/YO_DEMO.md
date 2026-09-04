I would like to start create a demo project using the Yo language.
> **ARCHIVED 2026-09-04 — TS-era scratch note** (informal demo-project
> brainstorm from the TypeScript-compiler period).

Right now this workspace contains 3 directories:

- Yo - The Yo language implementation
- raylib_yo - The raylib bindings for the Yo language
- tetris_yo - The tetris game implemented in the Yo language using the raylib bindings

Right now both raylib_yo and tetris_yo are initialized using `yo init` command. I added some devenv shell config there, so both raylib_yo and tetris_yo include the necessary packages like clang, pkg-config, raylib, etc.

The goal here is to test our Yo build system and make sure we can build the raylib bindings and the tetris game without any issues.

I suggest we follow these steps to achieve the goal:

- Build the raylib bindings for the Yo language. The raylib website cheatsheet https://www.raylib.com/cheatsheet/cheatsheet.html is quite helpful.
  We use `c_include "<raylib.h>"` with assigned struct types for types that need field access in Yo:
  ```
  c_include "<raylib.h>",
    (Color : Type) = struct(r: u8, g: u8, b: u8, a: u8),
    (Vector2 : Type) = struct(x: f32, y: f32),
    InitWindow : (fn(width: i32, height: i32, title: *(char)) -> unit),
    ...
  ;
  ```
  This uses the new c_include extension that lets us define struct layouts while using the C header's type name.
  We need to export the functions and types that we defined there.
- Make tetris_yo install that **local** raylib_yo package and use it to implement the tetris game in Yo. The https://github.com/raysan5/raylib-games/blob/master/classics/src/tetris.c contains its implementation in C, we can use it as a reference to implement the game in Yo.
- After we get the both steps above working, I will push the raylib_yo to GitHub. Let's then try to install raylib_yo from GitHub in tetris_yo and make sure it works as well.
- Finally, help me create README.md files for both raylib_yo and tetris_yo, so we can share them with others. Let's also update README.md in Yo to showcase these two projects as examples of using the Yo language.

While implementing, I suggest we use the `./yo-cli` command in `Yo` directory. This way if we found any Yo language issues, we can easily fix them and test them right away.  
For example: `./yo-cli build --build-file ../raylib_yo/build.yo`

## Implementation Notes

### c_include with struct type definitions (NEW FEATURE)

We extended `c_include` (and `extern`) to accept assigned type values:

```
c_include "<header.h>",
  (TypeName : Type) = struct(field1: type1, field2: type2)
;
```

This gives Yo knowledge of the struct field layout (for construction and field access) while the codegen uses the C type name directly (no `__yo_<id>` mangling) and skips generating a C struct definition (the header provides it).

Files changed:

- `src/evaluator/exprs/c-include.ts` — propagate extern metadata to assigned struct/enum/union types
- `src/evaluator/exprs/extern.ts` — same for `extern "C"`
- `src/codegen/types/collection.ts` — use `externName` as cName for extern types
- `src/codegen/types/generation.ts` — skip forward declarations and struct definitions for extern C types
