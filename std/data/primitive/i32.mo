import {*} from "../../builtins";
import {*} from "../arithmetic";

/**
 * Operators for i32
 */
instance Add<i32> {
  (+): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 + $2)");
    0
  }
}

instance Sub<i32> {
  (-): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 - $2)");
    0
  }
}

instance Mul<i32> {
  (*): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 * $2)");
    0
  }
}

instance Div<i32> {
  (/): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 / $2)");
    0
  }
}

instance Mod<i32> {
  (%): (a: i32, b: i32)-> i32 {
    @codegenInline(C="($1 % $2)");
    0
  }
}
