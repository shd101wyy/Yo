infix  40 ==  // Equality
infix  40 !=  // Inequality

export class Eq<Rhs = Self> {
  eq: (lhs: &Self, rhs: &Rhs)-> boolean;
  ne: (lhs: &Self, rhs: &Rhs)-> boolean = (lhs, rhs)-> {
    !lhs.eq(rhs)
    // or
    // !Eq<Self>.eq(lhs, rhs)
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