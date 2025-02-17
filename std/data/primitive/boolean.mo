let { codegen_inline } = @import("../../builtins.mo");
let { LogicalNot } = @import("../../classes/logic.mo");
let { Eq } = @import("../../classes/eq.mo");
let { Drop } = @import("../../classes/common.mo");

/**
 * logic
 */
instance LogicalNot<boolean> {
  (!): (a)-> {
    codegen_inline(C="(!($1))");
    recur(a)
  }
}

/**
 * eq
 */
implement Eq<boolean> {
  (==): (a, b)-> {
    codegen_inline(C="(($1) == ($2))");
    recur(a, b)
  }
  (!=): (a, b)-> {
    codegen_inline(C="(($1) != ($2))");
    recur(a, b)
  }
}

/**
 * drop
 */
implement Drop<boolean> {
  @noop() // ignored by the compiler when generating C code
  drop(value) {}
}