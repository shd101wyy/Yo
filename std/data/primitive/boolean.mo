import * from "../../builtins.mo";
import * from "../../classes/logic.mo";
import * from "../../classes/eq.mo";

/**
 * logic
 */
instance LogicalNot<boolean> {
  (!): (a)=> {
    codegen_inline(C="(!($1))");
    recur(a)
  }
}