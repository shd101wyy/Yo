// Compt value can be assigned to runtime variable,
// but not the other way around.

def compt_return(compt(T): Type, compt(value): T): compt(T),
  value
;

def runtime_return(compt(T): Type, value: T): T,
  value
;

xx :: compt_return(i32, 12);
// xx :: runtime_return(i32, 12);

def test(compt(x): i32, y: i32): (), {
  // Assign compt value to another compt is allowed
  xx :: x;
  xx :: compt_return(i32, x);

  // Assign compt value to another runtime is allowed
  yy := x;

  // Assign runtime value to another compt is not allowed
  // xx :: y; // expected-error {{cannot assign runtime value to a compt variable}}

  // Assign runtime value to another runtime is allowed
  yy := y;

  ()
};

// Below should give error as `value` is supposed to be compt
def some_func(compt(T): Type, value: T): compt(T), value;
