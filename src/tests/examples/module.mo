// variables with _ are private
// variables without _ are public

// Define a module type
// All the fields are comptile-time only. No runtime values are allowed.  
// with `module struct`:
MY_MODULE :: module struct
  x: i32,
  add_int:
    (i32, i32)-> i32
;

// Initialize a module instance
(MyModule : MY_MODULE) = {
  x: 0,
  add_int:
    fn(x, y)-> 
      x + y
}
;
// or define an anonymous module
// with `module begin`:
(MyModule : MY_MODULE) = module {
  x :: 0;
  def add_int:
    (x: i32, y: i32) -> i32,
    x + y;

  // You are also allowed to define extra variables
  y :: 1;
}

// Define anonymous module
// with `module begin`:
MyModule :: module {
  Point :: struct(i32, i32); // Point is exported
  _Color :: enum Red, Green, Blue; // _Color is private and not exported

  def new:
    (x: i32, y: i32) -> Point,
    Point(x, y);

  def (+):
    (a: Point, b: Point) -> Point,
    Point((a.x + b.x), (a.y + b.y));
}

p :: MyModule.Point(1, 2); // Explicitly call Point from MyModule

c :: MyModule._Color.Red; // Not allowed to access _Color

// Not allowed
// p :: Point(1, 2); // Implicitly call Point from MyModule

p :: MyModule.new(1, 2); // Explicitly call new from MyModule

// Not allowed
// p :: new(1, 2); // Implicitly call new from MyModule

// Uniform function call syntax
// It will implicitly call function from the module.
p1 :: Point(1, 2);
p2 :: Point(3, 4);
p1 + p2; // Implicitly call + from MyModule
p1.(MyModule.(+))(p2); // Explicitly call + from MyModule

Point :: struct(i32, i32); // We defined a new Point struct here.
p :: Point(1, 2); // Use the new Point struct.

// In this case, we either define Point in another module, or we call.
p :: Point(1, 2); // Explicitly call Point from this module.
p :: MyModule.Point(1, 2); // Explicitly call Point from MyModule.
