extern "Mo" {
  codegenFunction: (C: string = "")=> ();
}

infix  40 <=
infixl 70 *
infixl 60 -

let (*) = (x: i32, y: i32)=> i32 {
  codegenFunction(
    C = "inline int32_t $0(int32_t $1, int32_t $2) { return $1 * $2; }"
  );
  0
}

let (-) = (x: i32, y: i32)=> i32 {
  codegenFunction(
    C = "inline int32_t $0(int32_t $1, int32_t $2) { return $1 - $2; }"
  );
  0
}

let (<=) = (x: i32, y: i32)=> boolean {
  codegenFunction(
    C = "inline bool $0(int32_t $1, int32_t $2) { return $1 <= $2; }"
  );
  false
}

let factorial = (i: i32)=> i32 {
  if (i <= 1) {
    1
  } else {
    i * factorial(i - 1)
  }
}

let main = ()=> i32 {
  factorial(5)
}