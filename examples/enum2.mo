enum Option<T> {
  Some(value: T),
  None,
}

enum Complex<X> {
  Real(value: X),
}

// FIXME: Complex<Option<i32>> will cause error because of `>>`.  
extern "C" {
  test: ()-> Complex<Option<i32>>;
}