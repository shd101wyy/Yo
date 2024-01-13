export extern "Mo" {
  @codegenFunction: (C: string = "")-> ();
  @codegenInline: (C: string = "")-> ();
  @consume: <T: Type>(value: T)-> ();
}