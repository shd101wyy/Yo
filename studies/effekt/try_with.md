```typescript
effect GiveInt {
  giveInt(): i32
}

function test() {
  try {
    let x = giveInt();
    let y = giveInt();
    x + y
  } with GiveInt {
    giveInt() { 1 }
  }
}

```