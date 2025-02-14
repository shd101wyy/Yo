infix  40 <   // Less than
infix  40 <=  // Less than or equal to
infix  40 >   // Greater than
infix  40 >=  // Greater than or equal to

export enum Ordering {
  Less,
  Equal,
  Greater
}

// FIXME:
// Using Eq<T>
export class Ord<Lhs: Type, Rhs: Type = Lhs with Eq<Lhs, Rhs>> {
  compare: (a: &Lhs, b: &Rhs)=> Ordering;
  lt: (a: &Lhs, b: &Rhs)=> boolean;
  gt: (a: &Lhs, b: &Rhs)=> boolean;
  le: (a: &Lhs, b: &Rhs)=> boolean;
  ge: (a: &Lhs, b: &Rhs)=> boolean;
}