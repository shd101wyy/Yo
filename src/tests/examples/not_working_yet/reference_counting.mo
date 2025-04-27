LinearString ::
  struct
    ptr: Ptr(char), // Pointer to the string data
    length: usize,
    allocator: Allocator // Allocator for memory management
;

String ::
  struct
    data: LinearString, // Linear string data
    ref_count: Box(usize) // Reference count for the string
;

x := String.from("Hello, World"); // x: String (Linear)
y := Rc.new(RefCell.new(x)); // y: Rc(RefCell(String)) (Linear)
