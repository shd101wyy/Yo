函数式编程中的 algebraic effects 是什么？ - 酱紫君的回答 - 知乎
https://www.zhihu.com/question/300095154/answer/2625852587

```typescript
effect Ask<T> {
  ask(): [Ask<T>] T;
}

function addTwice(): [Ask<i32>] i32 {
  ask() + ask()
}

function askOnce(): [Console] i32 {
  let count = 0;
  with Ask {
    ask() {
      count = count + 1;
      if count <= 1 {
        resume 21
      } else {
        0 // This is like return(0)
      }
    }
  }
  console.log("Before");
  do addTwice();       // return 0 from the second ask
  console.log("after") // not executed
  12                   // not executed
}


```
