```typescript
function promise(): [Async] Promise<string> {
  Promise.new((resolve, reject) => {
    setTimeout(() => {
      resolve("hello");
    }, 1000);
  });
}

function usePromise(): [Async] () {
  const x = await(promise());
}

```
