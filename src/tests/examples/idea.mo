// Path / Origins
x := 1;
y := 3;
x_ref := &(x); // x_ref: (&(i32) @ [x]);
x_ref = &(y);  // x_ref: (&(i32) @ [y]);

defn longest_str(a: (&(str) @ [str1]), b: (&(str) @ [str2])): (&(str) @ [str1, str2]),
  if (a.length > b.length) {
    a
  } else {
    b
  };

longest : &(str);
x := String.from("Hello");
{
  y := String.from("World");
  longest := longest_str(x.as_str(), y.as_str()); // longest: (&(str) @ [x, y]);
} // error: longest has origin `y` so `y` cannot be consumed.

arr := ArrayList.new(...);
first_ref := &(arr(0)); // first_ref: (&(i32) @ [arr]);
arr.reallocate(10); // maybe error here: as arr is already borrowed as immutable ref in first_ref
// first_ref has error



defn set_container_value(container: &!(SomeContainer), value: &(Data)), {
  SomeContainer.value = value;
};

// Life
mut(x) := 1;
mut(y) := 2;

?(r1) := life();
x_ref = &!(x, r1);
y_ref = &!(y, r1);
swap(x_ref, y_ref);