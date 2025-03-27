type Expr =
  | {
      type: "Atom";
    }
  | {
      type: "FuncCall";
      func: Expr;
      args: Expr[];
    };
