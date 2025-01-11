let main = ()=> {
  let mut xs: i32[] = [1, 2, 3];
  let xsRef = &!xs;
  let firstRef = &!xs[0]; // Compiler Error: Cannot borrow `xs` as mutable more than once at a time.
}