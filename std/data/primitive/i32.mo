let { codegen_inline } = import("../../builtins.mo");
let { Add, Sub, Mul, Div, Mod } = import("../../classes/arithmetic.mo");
let { LogicalNot } = import("../../classes/logic.mo");
let { Eq } = import("../../classes/eq.mo");
let { Drop } = import("../../classes/common.mo");

/**
 * arithmetic
 */
instance Add<i32, i32> {
  Output: i32;

  (+): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

instance Sub<i32, i32> {
  Output: i32;

  (-): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

instance Mul<i32, i32> {
  Output: i32;
  
  (*): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

instance Div<i32, i32> {
  Output: i32;

  (/): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

instance Mod<i32, i32> {
  Output: i32;

  (%): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}

/**
 * logic
 */
instance LogicalNot<i32> {
  Output: i32;

  (!): (a)=> {
    codegen_inline(C="!((int32_t)$1)");
    recur(a)
  }
}


/**
 * eq
 */
instance Eq<i32> {
  (==): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) == ((int32_t)$2))");
    recur(a, b)
  };
  (!=): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) != ((int32_t)$2))");
    recur(a, b)
  }
}

/**
 * drop
 */
instance Drop<i32> {
  @noop() // ignored by the compiler when generating C code
  drop: (value)=> {}
}