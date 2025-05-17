fn Drop(Self: Type), interface {
  drop: (fn(self: Self)-> ())
};

fn Clone(Self: Linear), interface {
  clone: (fn(self: &(Self))-> Self)
};


/*
// QUESTION: What should be the parameter type here
fn Copy(T: Free), interface {
  copy: (fn(self: T)-> T)
};
*/

{ Drop, Clone }