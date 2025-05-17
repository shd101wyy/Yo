fn max(T: Type, a: T, b: T):T, {
  cond 
    (T == boolean) -> a .or b,
    (a > b) -> a,
    true -> b
};

try expect(max(boolean, false, true) == true);
// compiles to
fn max(a: boolean, b: boolean): boolean, {
  {
    return a or b;
  }
};

CmdFn := .CmdFn {
  name: comp(&(str)),
  func: (fn(i32)-> i32)
};

cmd_fns = [
  CmdFn { name: "one", func: one },
  CmdFn { name: "two", func: two },
  CmdFn { name: "three", func: three }
]; // cmd_fns: comp(Array(CmdFn, 3));

fn one(value:i32):i32, value + 1;
fn two(value:i32):i32, value + 2;
fn three(value:i32):i32, value + 3;

// perform_fn is a runtime function:
fn perform_fn(prefix_char: comp(u8), start_value: i32): i32, {
  (result:i32) := start_value;
  i := 0; // i: comp(i32)
  // QUESTION: Do we need `inline` like zig here?
  compeval while i < cmd_fns.len, i += 1, {
    if cmd_fns(i).name(0) == prefix_char, {
      result = cmd_fns(i).func(result);
    }
  };
  return result;
};

// perform_fn('t', 1)
fn perform_fn(start_value: i32):i32, {
  result := start_value;
  result = two(result);
  result = three(result);
  return result;
}

// perform_fn('o', 0)
fn perform_fn(start_value: i32):i32, {
  result := start_value;
  result = one(result);
  return result;
}