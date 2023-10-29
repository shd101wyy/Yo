> https://overreacted.io/algebraic-effects-for-the-rest-of-us/

Minimal set of syntax

Algebraic Effects + Perceus

```typescript
function test() {
  if (true) {
    return 1;
  }
}

function map(xs: List<a>, f: (a) => e b): e List<b> {
  match xs {
    case Nil => Nil;
    case Cons(x, xs) => Cons(f(x), map(xs, f));
  }
}


function main(): IO () {
  console.log("gg");

  for(1, 10) (i)=> {
    console.log(i);
  }
}
```

```typescript
effect Emit {
  emit: (msg: string) => ()
}

// emits a standard greering
function hello() {
  emit("hello");
}

// Emits a standard greeting to the console.
function helloConsole(hello) {
  with handler {
    function emit(msg) {
      console.log(msg);
    }
  }
  hello();
}


```

```typescript
function getName(user) {
  let name = user.name;
  if (name === null) {
  	name = perform 'ask_name';
  }
  return name;
}

function makeFriends(user1, user2) {
  user1.friendNames.push(getName(user2));
  user2.friendNames.push(getName(user1));
}

const arya = { name: null, friendNames: [] };
const gendry = { name: 'Gendry', friendNames: [] };
try {
  makeFriends(arya, gendry);
} handle (effect) {
  if (effect === 'ask_name') {
  	resume with 'Arya Stark';
  }
}
```