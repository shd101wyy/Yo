infix  40 ==  // Equality
infix  40 !=  // Inequality

export trait Eq<Rhs = Self> {
  eq: (&self, b: &Rhs)=> boolean;
  ne: (&self, b: &Rhs)=> boolean = (a, b)=> {
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