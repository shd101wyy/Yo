#include <stdio.h>

/*
effect GiveInt {
    control giveInt: (x: i32)=> i32;
}

let main = ()=> {
    try {
        let a = givetInt(10);
    } with GiveInt {
        control giveInt: (x: i32)=> {
            if (x > 10) {
                println("resume");
                resume(x);
            } else {
                println("abort");
                abort(0);
            }
        }
    }
}
*/

typedef union value value_t;
typedef struct coroutine coroutine_t;
void coroutine_resume(coroutine_t *coro, value_t value);
void coroutine_abort(coroutine_t *coro, value_t value);

union value
{
    int _i32;
    float _f32;
    double _f64;
    void *_voidptr;
};

struct coroutine
{
    // self
    /// * arguments passed to the function
    void *arguments;
    /// * the context that this coroutine has
    void *context;
    /// * the function to call
    void (*function)(coroutine_t *self);
    int step;
    value_t value;

    // parent
    coroutine_t *parent;
};

void coroutine_resume(coroutine_t *coro, value_t value)
{
    coro->value = value;
    coro->step++;
    coro->function(coro);
}

void coroutine_abort(coroutine_t *coro, value_t value)
{
    if (coro != NULL)
    {
        coro->value = value;
        coro->step = -1;
        coro->function(coro);
    }
}

typedef struct GetIntArguments
{
    int x;
} GetIntArguments_t;
typedef struct GetIntContext
{
} GetIntContext_t;

void getInt(coroutine_t *self)
{
    GetIntArguments_t *arguments_ = self->arguments;
    switch (self->step)
    {
    default:
    {
        if (arguments_->x > 10)
        {
            printf("resume %d\n", arguments_->x);
            coroutine_resume(self->parent, (value_t){._i32 = arguments_->x});
        }
        else
        {
            printf("abort %d\n", arguments_->x);
            coroutine_abort(self->parent, (value_t){._i32 = 0});
        }
    }
    }
}

typedef struct MyMainArguments
{
} MyMainArguments_t;

typedef struct MyMainContext
{
} MyMainContext_t;

void myMain(coroutine_t *self)
{
    switch (self->step)
    {
    case 0:
    {
        GetIntArguments_t arguments_ = (GetIntArguments_t){.x = 12};
        GetIntContext_t context = (GetIntContext_t){};
        coroutine_t getInt_coro = (coroutine_t){
            .arguments = &arguments_,
            .context = &context,
            .function = &getInt,
            .step = 0,
            .parent = self,
        };
        getInt(&getInt_coro);
        break;
    }
    case 1:
    {
        printf("Done getInt: %d\n", self->value._i32);
        break;
    }
    case -1:
    {
        printf("Aborted getInt: %d\n", self->value._i32);
        break;
    }
    }
}

int main()
{
    MyMainContext_t context = (MyMainContext_t){};
    MyMainArguments_t arguments = (MyMainArguments_t){};
    coroutine_t myMain_coro = (coroutine_t){
        .arguments = &arguments,
        .context = &context,
        .function = myMain,
        .step = 0,
        .parent = NULL,
    };
    myMain(&myMain_coro);
    return 0;
}