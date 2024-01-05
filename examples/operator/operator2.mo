infixl 60 +;   // Addition
infixl 70 *;   // Multiplication

extern "Mo" {
  @codegen: (C: string = "")-> ();
}

let (+) = (x: i32, y: i32)-> i32 {
  @codegen(
    C = "(($1) + ($2))"
  );
  0
}

let (*) = (x: i32, y: i32)-> i32 {
  @codegen(
    C = "(($1) * ($2))"
  );
  0
}

/*

let main = ()-> i32 {
  let value = 2 + 3 * 4;
  value
}
*/