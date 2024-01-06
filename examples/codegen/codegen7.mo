extern "Mo" {
  @codegenInline: (C: string = "")-> ();
}

let add = (x: i32, y: i32)-> i32 {
  @codegenInline(
    C = "($1 + $2)"
  );
  0
}

let main = ()-> i32 {
  let x = add(1, 2);
  x
}