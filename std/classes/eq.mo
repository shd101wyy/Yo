infix  40 ==  // Equality
infix  40 !=  // Inequality

export class Eq<Lhs: Type, Rhs: Type = Lhs> {
  (eq): (a: &Lhs, b: &Rhs)=> boolean;
  (ne): (a: &Lhs, b: &Rhs)=> boolean;
}

// x == y
// automatically converted to
// Eq<T>.eq(&x, &y)