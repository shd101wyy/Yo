infix  40 ==  // Equality
infix  40 !=  // Inequality

export trait Eq<Lhs: Type, Rhs = Lhs> {
  eq: (lhs: &Lhs, rhs: &Rhs)-> boolean;
  ne: (lhs: &Lhs, rhs: &Rhs)-> boolean = (lhs, rhs)-> {
    !lhs.eq(rhs)
    // or
    // !Eq<Lhs, Rhs>.eq(lhs, rhs)
    // or
    // !this.eq(lhs, rhs)
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