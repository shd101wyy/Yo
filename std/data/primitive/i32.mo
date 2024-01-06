import {*} from "../../builtins";
import {*} from "../arithmetic";

/**
 * arithmetic
 */
instance Add<i32> {
  (+): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 + $2)");
    recur(a, b)
  }
}

instance Sub<i32> {
  (-): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 - $2)");
    recur(a, b)
  }
}

instance Mul<i32> {
  (*): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 * $2)");
    recur(a, b)
  }
}

instance Div<i32> {
  (/): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 / $2)");
    recur(a, b)
  }
}

instance Mod<i32> {
  (%): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 % $2)");
    recur(a, b)
  }
}
