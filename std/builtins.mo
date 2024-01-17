export extern "Mo" {
  @codegenFunction: (C: symbol = @"")-> ();
  @codegenInline: (C: symbol = @"")-> ();
  @consume: <T: Type>(value: T)-> ();
}