> https://medium.com/swlh/implement-a-simple-promise-in-javascript-20c9705f197a

```typescript
enum PromiseStatus {
  Pending
  Fulfilled
  Rejected
}

type Promise<ResolveType, RejectType> = {
  value: ResolveType | RejectType | null,
  status: PromiseStatus
}

let newPromise = <ResolveType, RejectType>(executor: [&](resolve: (value: ResolveType) => (), reject: [&](reason: RejectType) => ()) => ()): Promise<ResolveType, RejectType> => {
  let promise = Promise<ResolveType, RejectType> {
    value: null,
    status: PromiseStatus.Pending
  }

  let resolve = [{promise: &promise}](value: ResolveType) => {
    *promise.value = value
    *promise.status = PromiseStatus.Fulfilled
  }

  let reject = [{promise: &promise}](reason: RejectType) => {
    *promise.value = reason
    *promise.status = PromiseStatus.Rejected
  }

  executor(resolve, reject)
  return promise
}

let then = <ResolveType, RejectType>(promise: Promise<ResolveType, RejectType>, onFulfilled: (value: ResolveType) => (), onRejected: (reason: RejectType) => ()) => {
  let {value, status} = promise;
  if (status === PromiseStatus.Fulfilled) {
    onFulfilled(value)
  } else if (status === PromiseStatus.Rejected) {
    onRejected(value)
  }
}
```
