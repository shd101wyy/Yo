infix  40 ==  // Equality
infix  40 !=  // Inequality

export class Eq<Lhs, Rhs = Lhs> {
  eq: (a: &Lhs, b: &Rhs)=> boolean;
  ne: (a: &Lhs, b: &Rhs)=> boolean = (a, b)=> {
    !eq(a, b)
  }
}

// x == y
// automatically converted to
// Eq.eq(&x, &y)
// or
// x.eq(&y)
/*
export macro (==) <Lhs, Rhs>(lhs: Expr<Lhs>, rhs: Expr<Rhs>): Expr<boolean> {
  Eq.eq(&lhs, &rhs)
}
*/