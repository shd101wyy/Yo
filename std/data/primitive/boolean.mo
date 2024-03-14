import * from "../../builtins.mo";
import * from "../../interface/logic.mo";
import * from "../../interface/eq.mo";

/**
 * logic
 */
implements LogicalNot<boolean> {
  (!): (a: boolean)=> boolean {
    codegenInline(C="!$1");
    recur(a)
  }
}