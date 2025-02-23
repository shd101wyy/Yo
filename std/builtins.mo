// Also needs to update the src/builtins.ts file

// TODO: All of them should be converted to comptime expr function.  
export extern "Mo" {
  codegen_function: (C: *u8 = c"")-> ();
  codegen_inline: (C: *u8 = c"")-> ();
  consume: <T: Type>(value: T)-> ();
  compile_error: (message: &str)-> ();
  // @noop: <T>()-> T;
  // castToFree: <T: Type>(value: &T)-> T;
}
