infix  40 <   // Less than
infix  40 <=  // Less than or equal to
infix  40 >   // Greater than
infix  40 >=  // Greater than or equal to

export type Ordering =
  | .Less,
  | .Equal,
  | .Greater


// FIXME:
// Using Eq<T>
export trait Ord<Self: Type impl Eq> {
  compare: (self: &Self, other: &Self)-> Ordering;
  lt: (self: &Self, other: &Self)-> boolean;
  gt: (self: &Self, other: &Self)-> boolean;
  le: (self: &Self, other: &Self)-> boolean;
  ge: (self: &Self, other: &Self)-> boolean;
}