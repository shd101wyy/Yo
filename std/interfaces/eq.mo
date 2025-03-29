fn Eq(Lhs: Type, Rhs = Lhs), interface {
  eq: (fn(lhs: &(Lhs), rhs: &(Rhs)) -> boolean),
  (ne: (fn(lhs: &(Lhs), rhs: &(Rhs)) -> boolean)) = (fn(lhs, rhs) -> {
    !(lhs.eq(rhs))
    // or
    // !(Eq(Lhs, Rhs).eq(lhs, rhs))
    // or
    // !(this.eq(lhs, rhs))
  })
};

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

{ Eq }