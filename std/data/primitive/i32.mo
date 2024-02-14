import {*} from "../../builtins.mo";
import {*} from "../../interface/arithmetic.mo";
import {*} from "../../interface/logic.mo";
import {*} from "../../interface/eq.mo";

/**
 * arithmetic
 */
implements Add<i32> {
  (+): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

implements Sub<i32> {
  (-): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

implements Mul<i32> {
  (*): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

implements Div<i32> {
  (/): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

implements Mod<i32> {
  (%): (a: i32, b: i32)-> i32 {
    @codegenInline(C=@"(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}

/**
 * logic
 */
implements LogicalNot<i32> {
  (!): (a: i32)-> boolean {
    @codegenInline(C=@"!((int32_t)$1)");
    recur(a)
  }
}


/**
 * eq
 */
implements Eq<i32> {
  (==): (a: i32, b: i32)-> boolean {
    @codegenInline(C=@"(((int32_t)$1) == ((int32_t)$2))");
    recur(a, b)
  };
  (!=): (a: i32, b: i32)-> boolean {
    @codegenInline(C=@"(((int32_t)$1) != ((int32_t)$2))");
    recur(a, b)
  }
}