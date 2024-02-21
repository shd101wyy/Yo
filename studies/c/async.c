// Stackless Coroutine

#include <stdio.h>
#include <stdlib.h>

typedef struct coroutine
{
    int step;
    void *context;
    struct coroutine *parent;
    void (*function)(struct coroutine *self);

    int value; // TODO: Use union of value types
               // For this demo, we only use int
} coroutine_t;

void coroutine_resume(coroutine_t *coro, int value)
{
    if (coro != NULL)
    {
        // Resume
        coro->step += 1;
        coro->value = value;
        coro->function(coro);
    }
    else
    {
        printf("Coroutine to resume is NULL. Value: %d\n", value);
    }
}

void coroutine_abort(coroutine_t *coro, int value)
{
    if (coro != NULL) {
        coroutine_t *parent = coro->parent;
        while (coro->parent != NULL) {
            // TODO: Free coro->context
            coro = coro->parent;
            parent = coro->parent;
        }
        // Abort
        coro->step = -1;
        coro->value = value;
        coro->function(parent);
    } else {
        printf("Coroutine to abort is NULL. Value: %d\n", value);
    }
}

/*
// Translate the following pseudo-code to C:
let x: number = 0;
let test = ()-> Promise<()> {
  let a = await getInt();
  let b = await getInt();
  resume(a + b);
}

let getInt = ()-> Promise<i32> {
    x = x + 1;
    resume(x);
}
*/

typedef struct getInt_context
{
} getInt_context_t;

typedef struct test_context
{
    int a;
    int b;
} test_context_t;

static int x = 0;

void getInt(coroutine_t *self)
{
    switch (self->step)
    {
    default:
        x = x + 1;
        coroutine_resume(self->parent, x);
    }
}

void test(coroutine_t *self)
{
    test_context_t *context = (test_context_t *)self->context;
    switch (self->step)
    {
    case 0:
    {
        getInt_context_t getIntContext;
        coroutine_t getIntCoroutine = {
            .context = &getIntContext,
            .parent = self,
            .step = 0,
            .function = getInt,
            .value = 0,

        };
        getInt(&getIntCoroutine);

        break;
    }
    case 1:
    {
        context->a = self->value;
        printf("a = %d\n", context->a);

        getInt_context_t getIntContext;
        coroutine_t getIntCoroutine = {
            .context = &getIntContext,
            .parent = self,
            .step = 0,
            .function = getInt,
            .value = 0,
        };
        getInt(&getIntCoroutine);

        break;
    }
    case 2:
        context->b = self->value;
        printf("b = %d\n", context->b);
        coroutine_resume(self->parent, context->a + context->b);
        break;
    }
}

int main()
{
    test_context_t context = {
        .a = 1,
        .b = 2,
    };
    coroutine_t testCoroutine = {
        .context = &context,
        .step = 0,
        .parent = NULL,
        .function = test,
        .value = 0,
    };
    test(&testCoroutine);
}