// let { codegen_inline } = @import("../../builtins.mo");
{ LogicalNot } := import "../../classes/logic.mo";
{ Eq } := import "../../classes/eq.mo";
{ Drop } := import "../../classes/common.mo";

/**
 * logic
 */
impl LogicalNot(boolean), {
  (!): (fn(a)-> {
    codegen_inline(C="(!($1))");
    recur(a)
  })
};

/**
 * eq
 */
impl Eq(boolean, boolean), {
  (==): (fn(a, b)-> {
    codegen_inline(C="(($1) == ($2))");
    recur(a, b)
  }),
  (!=): (fn(a, b)-> {
    codegen_inline(C="(($1) != ($2))");
    recur(a, b)
  })
};

/**
 * drop
 */
impl Drop(boolean), {
  drop: noop()
};