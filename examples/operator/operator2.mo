infixl 60 +;   // Addition
infixl 70 *;   // Multiplication

extern "Mo" {
  codegenFunction: (C: string = "")=> ();
}

let (+) = (x: i32, y: i32)=> i32 {
  codegenFunction(
    C = "(($1) + ($2))"
  );
  0
}

let (+) = (x: f32, y: f32)=> f32 {
  codegenFunction(
    C = "(($1) + ($2))"
  );
  0.0
}

let (*) = (x: i32, y: i32)=> i32 {
  codegenFunction(
    C = "(($1) * ($2))"
  );
  0
}

let main = ()=> i32 {
  let a = 1 + 2 + 3;
  let x = (+)(2.3, 4.5);
  let y = 2 * 3 + 4 * 5;
  0
}