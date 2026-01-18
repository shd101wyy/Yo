import { Expr, exprIsAtom, exprIsFunctionCall } from "../../expr";

export function getDeferredDupTargetAtomName(
  dupExpr: Expr
): string | undefined {
  if (!exprIsFunctionCall(dupExpr) || dupExpr.args.length < 1) {
    return;
  }
  const firstArg = dupExpr.args[0];
  if (!firstArg || !exprIsAtom(firstArg)) {
    return;
  }
  return firstArg.token.value;
}
