export extern "Mo" {
  @codegenFunction: (C: symbol = @"")=> ();
  @codegenInline: (C: symbol = @"")=> ();
  @consume: <T: Type>(value: T)=> ();
  @compileError: (message: symbol)=> ();
  @noop: <T>()=> T;
  @castToFree: <T: Type>(value: read T)=> T;
}