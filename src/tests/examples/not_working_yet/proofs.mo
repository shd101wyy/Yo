/**
 * Proofs can be defined with `=>` operator.
 * Proofs can be attached to the following types:
 * - function
 * - interface
 *
 * Proofs can appear in the following places:
 * - after `forall`
 * - after function `->`, before its return type
 */

 def Id:
  (compt(T): Type) -> compt(Type),
    interface
      (This: Type) = T,
      id: 
        (x: This) -> This
;

// Attach to function type.
/// after function `->`, before its return type
def func1:
  (compt(T): Type, x: T) ->
    given(Id(T)) => T,
  x.id()
;
/*
def SomeStruct:
  (compt(T): Type) ->
    given(Id(T)) => compt(Type),
  struct(value: T)
;

/// after `forall`
def func2:
  forall(compt(T): Type) .
    given(Id(T)) =>
      (x: T)-> T,
  x.id()
;

// Attach to interface type.
def SomeInterface:
  (compt(T): Type) -> compt(Type),
    interface
      some_func: 
        (x: T) -> T
;
/// impl the interface:
forall(compt(T): Type) .
  given(Id(T)) =>
    SomeInterface(T)
      some_func: 
        fn(x)-> x.id()
;
*/