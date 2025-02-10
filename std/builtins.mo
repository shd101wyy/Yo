// Also needs to update the src/builtins.ts file
export extern "Mo" {
  codegen_function: (C: cstring = "")=> ();
  codegen_inline: (C: cstring = "")=> ();
  consume: <T: Type>(value: T)=> ();
  compile_error: (message: cstring)=> ();
  // @noop: <T>()=> T;
  // castToFree: <T: Type>(value: &T)=> T;
}