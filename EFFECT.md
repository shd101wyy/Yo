Effectful function that calls the effectful operation will be translated to a state machine.

## GiveInt

```typescript
enum K<ResumeType: Type, AbortType: Type> {
  Resume(value: ResumeType),
  Abort(value: AbortType),
  Running
}

effect GiveInt {
  giveInt(x: i32): i32;
}

function useGiveInt(a: i32, b: i32): {GiveInt} i32 {
  const k1: K<i32> = giveInt(a);
  const k2: K<i32> = giveInt(b);
  const k2Result: i32 = k2;
  const k1Result: i32 = k1;
  k1Result + k2Result
}

function handleGiveInt(): {} i32 {
  with handler GiveInt {
    giveInt(x) {
      if x > 1 {
        k.abort(x);
      } else {
        k.resume(x);
      }
    }
  }
  let x = giveInt(0);
  let y = useGiveInt(1, 2);
  x + y
}
```

## State

```typescript
effect State<T: Type> {
  get(): T;
  set(x: T): ();
}

function sumdown(sum: i32 = 0): {State<i32>, Divergent} i32 {
  const x = get();
  if i <= 0 {
    sum
  } else {
    set(i - 1);
    sumdown(sum + i);
  }
}

function state<T: Free>(init: T, action: ()=> {State<T>, Divergent} T): {Divergent} T
{
  let st = init;
  with handler State<T> {
    get(k) {
      k.resume(st);
    }
    set(x, k) {
      const o = (st = x);
      k.resume(());
    }
  }
  action()
}
```

## Exception

```typescript
function safeDivide(x: i32, y: i32): {Exception} i32 {
  if (y == 0) {
    raise("divide by zero");
    y = 1; // This is allowed
    x / y
  } else {
    x / y
  }
}
```

## Crawler

```typescript
effect FileSystem {
  open(String, String): File;
  close(File): ();
  read(&<File>): String;
  write(&<File>, String): ();
}

function writeNewContentToFile(filePath: String, content: String): {Exception, FileSystem} () {
  defer drop(content);

  const file: File = open(filePath, "w");
  defer close(file);

  const fileContent = read(file);
  defer drop(fileContent);

  write(file, content + fileContent);
}

function anotherProblem(): {Exception} {
  const file: File = open("file.txt", "w");

  raise("something wrong") ~ {
    close(file);
  }; // Might abort the program before `consume(file)`

  consume(file);
}
```

```typescript
function crawlWebsite(url: String): {Exception, Async} String {
  defer drop(url);
  const html = fetch(url);
  html
}

function crawlWebsites(urls: Array<String>): {Exception, Async} Array<String> {
  defer drop(urls);
  const results = urls.map((url)=> {
    crawlWebsite(url)
  });
  results
}
```

## Parallel

```typescript
function crawlWebsites(urls: Array<String>): {Exception, Async} Array<String> {
  defer drop(urls);
  const continuations: Array<K<String>> = urls.map((url)=> {
    crawlWebsite(url):K<String>
  });
  const results = continuations.map((k)=> {
    k:String
  });
}
```
