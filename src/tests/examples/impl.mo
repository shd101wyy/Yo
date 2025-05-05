// Function that returns the interface
def Stringer(compt(Self): Type): compt(Type),
  interface
    (Self: Type) = Self,
    to_string: ((Self)-> String)
;

// Implement the Stringer interface
// for generic tuples.  
forall(compt(X): Type, compt(Y): Type) .
  using(Stringer(X), Stringer(Y)) =>
    Stringer((X, Y))
  to_string:
    fn((x, y))->
      "(" + 
      x.to_string() + 
      "," + 
      y.to_string() + 
      ")"
;

// Introduce the =< operator
Stringer((any(compt(T): Type), any(compt(U): Type))) =<
  using(Stringer(T), Stringer(U))
  to_string:
    fn((x, y))->
      "(" + 
      x.to_string() + 
      "," + 
      y.to_string() + 
      ")"
;