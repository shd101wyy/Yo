// module { ... }
// creates a special struct value.
// that has "module" attribute.  

// Create a module type.
Drop :: type module
  This: Type,
  drop:
    (x : This)-> ()
;

(I32Drop : Drop) = module {
  This :: i32;

  def drop:
    (x: This) -> (),
    ()
  ;
}

def Add :
  (Lhs: compt(Type), Rhs: compt(Type)) -> compt(Type),
  type module
    (This: Type) = Lhs,
    (Output: Type) = Lhs,
    add:
      (x: This, y: This) -> Self.Output
;

(AddI32 : Add(i32, i32)) = module {
  This :: i32;
  Output :: i32;
  
  def add:
    (x: This, y: This) -> Output,
    x + y
  ;

  // Allowed to define extra functions
  def add2:
    (x: This, y: This) -> Output,
    x + y
  ;
};
