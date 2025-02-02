import * from "../../builtins.mo";
import * from "../../interface/arithmetic.mo";
import * from "../../interface/logic.mo";
import * from "../../interface/eq.mo";

/**
 * arithmetic
 */
instance Add<i32> {
  (+): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

instance Sub<i32> {
  (-): (a, b) => {
    codegen_inline(C="(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

instance Mul<i32> {
  (*): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

instance Div<i32> {
  (/): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

instance Mod<i32> {
  (%): (a, b)=> {
    codegen_inline(C="(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}

/**
 * logic
 */
instance LogicalNot<i32> {
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