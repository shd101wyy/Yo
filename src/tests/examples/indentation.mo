identity :: (forall(X: Type) -> ((fn(x: X): X) -> X))
;

identity :: 
  forall(X: Type) ->
    (fn(x: X): X) ->
      X
;

add ::
  (fn(x: i32, y: i32) : i32) -> 
    x + y;
