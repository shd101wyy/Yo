import * from "../../builtins.mo";
import * from "../../interface/arithmetic.mo";
import * from "../../interface/logic.mo";
import * from "../../interface/eq.mo";

/**
 * arithmetic
 */
export let {(+)} = Add<i32> {
  (+): (a: i32, b: i32)=> i32 {
    codegenInline(C="(((int32_t)$1) + ((int32_t)$2))");
    recur(a, b)
  }
}

export let {(-)} = Sub<i32> {
  (-): (a: i32, b: i32)=> i32 {
    codegenInline(C="(((int32_t)$1) - ((int32_t)$2))");
    recur(a, b)
  }
}

export let {(*)} = Mul<i32> {
  (*): (a: i32, b: i32)=> i32 {
    codegenInline(C="(((int32_t)$1) * ((int32_t)$2))");
    recur(a, b)
  }
}

export let {(/)} = Div<i32> {
  (/): (a: i32, b: i32)=> i32 {
    codegenInline(C="(((int32_t)$1) / ((int32_t)$2))");
    recur(a, b)
  }
}

export let {(%)} = Mod<i32> {
  (%): (a: i32, b: i32)=> i32 {
    codegenInline(C="(((int32_t)$1) % ((int32_t)$2))");
    recur(a, b)
  }
}

/**
 * logic
 */
export let {(!)} = LogicalNot<i32> {
  (!): (a: i32)=> boolean {
    codegenInline(C="!((int32_t)$1)");
    recur(a)
  }
}


/**
 * eq
 */
export let {(==), (!=)} = Eq<i32> {
  (==): (a: i32, b: i32)=> boolean {
    codegenInline(C="(((int32_t)$1) == ((int32_t)$2))");
    recur(a, b)
  };
  (!=): (a: i32, b: i32)=> boolean {
    codegenInline(C="(((int32_t)$1) != ((int32_t)$2))");
    recur(a, b)
  }
}