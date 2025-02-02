import * from "../../builtins.mo";
import * from "../../interface/logic.mo";
import * from "../../interface/eq.mo";

/**
 * logic
 */
instance LogicalNot<boolean> {
  (!): (a)=> {
    codegen_inline(C="(!($1))");
    recur(a)
  }
}