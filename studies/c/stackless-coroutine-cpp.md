https://github.com/xinyang-go/stackless-coroutine-cpp

```python
def generator(x):
    for i in range(x):
        yield i
```

```typescript
enum Status {
  Status0,
  Status1,
  Done,
}
type Frame = {
  x: i32;
  i: i32;
};
function newFrame(x: i32, i: i32): Frame {
  return { x, i };
}

function generator(frame: Frame, status: Status) {
  // Destructure frame
  let { x, i } = frame; // frame is consumed

  switch (status) {
    case Status.Status0:
      for (frame.i = 0; i < frame.x; frame.i++) {
        status = Status.Status1;
        return { frame: newFrame(x, i), status, value: frame.i };
      }
      break;
    case Status.Status1:
      break;
  }
  status = Status.Done;
  return { frame: newFrame(x, i), status, value: undefined };
}
```
