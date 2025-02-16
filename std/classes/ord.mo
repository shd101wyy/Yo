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
export trait Ord with Eq {
  compare: (&self, other: &Self)=> Ordering;
  lt: (&self, other: &Self)=> boolean;
  gt: (&self, other: &Self)=> boolean;
  le: (&self, other: &Self)=> boolean;
  ge: (&self, other: &Self)=> boolean;
}