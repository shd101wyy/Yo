let { codegen_inline } =  @import("../../builtins.mo");
let { Add, Sub, Mul, Div, Mod } =  @import("../../classes/arithmetic.mo");
let { LogicalNot } =  @import("../../classes/logic.mo");
let { Eq } =  @import("../../classes/eq.mo");
let { Drop } =  @import("../../classes/common.mo");

/**
 * arithmetic
 */
impl Add<i32, i32> {
  Output: i32;

  (+): (a, b)-> {
    codegen_inline(C="(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

impl Sub<i32, i32> {
  Output: i32;

  (-): (a, b)-> {
    codegen_inline(C="(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

impl Mul<i32, i32> {
  Output: i32;
  
  (*): (a, b)-> {
    codegen_inline(C="(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

impl Div<i32, i32> {
  Output: i32;

  (/): (a, b)-> {
    codegen_inline(C="(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

impl Mod<i32, i32> {
  Output: i32;

  (%): (a, b)-> {
    codegen_inline(C="(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}

/**
 * logic
 */
impl LogicalNot<i32> {
  Output: i32;

  (!): (a)-> {
    codegen_inline(C="!((int32_t)$1)");
    recur(a)
  }
}


/**
 * eq
 */
impl Eq<i32, i32> {
  (eq): (a, b)-> {
    codegen_inline(C="(((int32_t)*$1) == ((int32_t)*$2))");
    recur(a, b)
  };
  (ne): (a, b)-> {
    codegen_inline(C="(((int32_t)*$1) != ((int32_t)*$2))");
    recur(a, b)
  }
}

/**
 * drop
 */
impl Drop<i32> {
  @noop() // ignored by the compiler when generating C code
  drop: (value)-> {}
}