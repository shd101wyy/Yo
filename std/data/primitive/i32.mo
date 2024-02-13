import {*} from "../../builtins.mo";
import {*} from "../arithmetic.mo";

/**
 * arithmetic
 */
implement Add<i32> {
  (+): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

implement Sub<i32> {
  (-): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

implement Mul<i32> {
  (*): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

implement Div<i32> {
  (/): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

implement Mod<i32> {
  (%): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}
