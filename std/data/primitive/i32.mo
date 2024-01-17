import {*} from "../../builtins.mo";
import {*} from "../arithmetic.mo";

/**
 * arithmetic
 */
export instance Add<i32> {
  (+): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

export instance Sub<i32> {
  (-): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

export instance Mul<i32> {
  (*): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

export instance Div<i32> {
  (/): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

export instance Mod<i32> {
  (%): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}
