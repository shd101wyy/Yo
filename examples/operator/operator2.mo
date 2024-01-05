infixl 60 +;   // Addition
infixl 70 *;   // Multiplication

/*
extern "Mo" {
  @codegen: (C = char[])-> ();
}

let (+) = (x: i32, y: i32)-> {
  @codegen(
    C = "$1 + $2"
  )
}

let (*) = (x: i32, y: i32)-> {
  @codegen(
    C = "$1 * $2"
  )
}

let main = ()-> i32 {
  let value = 2 + 3 * 4;
  value
}
*/