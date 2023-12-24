## Function call transformation

Run the `parser` first to get the AST, then run the `transformer` to transform the AST.  
The borrow checker is also performed in the `transformer` phase.  

```typescript
add(1, add(2, 3));

// 1. Insert argument variables
{
  let _arg0 = 1;
  let _arg1 = { // block 2
    let _arg0 = 2;
    let _arg1 = 3;
    let _ret0 = add(_arg0, _arg1);
    _ret0
  }
  let _ret0 = add(_arg0, _arg1);
  _ret0
}

// 2. Flatten the blocks
{
  let _arg0 = 1;

  // ===== block 2 begin
  let _arg0_ = 2;
  let _arg1_ = 3;
  let _ret0_ = add(_arg0, _arg1);
  // ===== block 2 end

  let _arg1 = _ret0_;
  let _ret0 = add(_arg0, _arg1);
  _ret0
}

// 3. Reduce the number of variables.
// there should be only one `let` statement.
{
  let arg0?:i32, arg1?:i32, arg2?:i32, ret0?:i32; // from `frame` allocation

  arg0 = 1;

  // ===== block 2 begin
  arg1 = 2;
  arg2 = 3;
  ret0 = add(arg1, arg2);
  // ===== block 2 end

  arg1 = ret0;
  ret0 = add(arg0, arg1);
  ret0
}
```

### another example:

```typescript
function main() {
  String.from("Hello, world");
  ()
}

// Transform to

function main() {
  {
    let _arg0 = "Hello, world";
    let _ret0 = String.from(_arg0);
    _ret0
  }
  ()
}

// Transform to

function main() {
  let _arg0 = "Hello, world";
  let _ret0 = String.from(_arg0);
  _ret0;
  ();
}

// The compiler will then be able to detect the error that
// `_ret0` is not used.
```
