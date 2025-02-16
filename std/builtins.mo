// Also needs to update the src/builtins.ts file
export extern "Mo" {
  codegen_function: (C: &str = "")-> ();
  codegen_inline: (C: &str = "")-> ();
  consume: <T: Type>(value: T)-> ();
  compile_error: (message: &str)-> ();
  // @noop: <T>()-> T;
  // castToFree: <T: Type>(value: &T)-> T;
}