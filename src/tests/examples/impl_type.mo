extern
  add: ((x: i32, y: i32)-> i32)
;

impl i32, (
  add_method: ((fn(self: i32, another_value: i32): i32) ->
    add(self, another_value))
);

x := i32.add_method(3, 4);
x := 3.add_method(4);