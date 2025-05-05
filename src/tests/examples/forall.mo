// https://wasp.sh/blog/2021/09/01/haskell-forall-tutorial
// 
// forall(type_variables) . type_expression
//
// `forall` is universal quantification, which means that the type variable
// can be instantiated to any type. It is used to express polymorphic types.
// It is a way to say that a function works for all types, not just one specific type.

// (forall a. (t a -> r)) ≅ ((exists a. t a) -> r)

// Scoped Type Variables
def id_func:
  forall(compt(T): Type).
    (x: T)-> T,
  (xx : T) = x; // Use `T` inside the function body
  xx
;


/**
 * Rank N Types
 * enabled you to use `forall` nested in type signatures, so that it
 * does not apply to the whole type signature, but just part of it.  
 */

foo :
  (forall(compt(T): Type) . (T -> T)) -> 
    (char, boolean)
;
bar :
  forall(compt(T): Type) .
    ((T -> T) -> (char, boolean))
;
specific_func :
  i32 -> i32;
polymorphic_func :
  forall(compt(T): Type) . (T -> T);

// foo(specific_func);    // not okay
// foo(polymorphic_func); // okay
// bar(specific_func);    // okay
// bar(polymorphic_func); // okay

/**
 * Existential quantification
 * enables us to use `forall` in the type signature of data constructors.
 * QUESTION: Does it mean we need to use dynamic dispatch here?
 */
Showable :: enum
  forall(compt(T): Type) .
    (Show(T)) =>
      Showable(T)
;
// Now we can do
(some_showable : (Showable, Showable)) =
  (.Showable(1), .Showable(true))
;

