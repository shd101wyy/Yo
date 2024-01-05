extern "Mo" {
  @codegen: (C: string = "")-> ();
}

infixl 60 +   // Addition

let add = (x: i32, y: i32)-> i32 {
  @codegen(
    C = "inline int32_t $0(int32_t $1, int32_t $2) { return $1 + $2; }

"
  );
  0
}

let (+) = (x: i32, y: i32)-> i32 {
  @codegen(
    C = "inline int32_t $0(int32_t $1, int32_t $2) { return $1 + $2; }

"
  );
  0
}

let main = ()-> i32 {
  let x = add(1, 2);
  let y = 3 + 4;
  x + y
}