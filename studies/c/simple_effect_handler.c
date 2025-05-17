#include <stdio.h>
#include <setjmp.h>

/*
// Translate the following Yo code to C:
interface Exception {
    control throw: (msg: symbol)=> [Exception] i32;
}

let safeDivide = (a: i32, b: i32)=> [Exception] i32 {
    if (b == 0) {
        abortdefer {
            println("abort throw")
        }
        let c = throw("Division by zero");
        println("resume throw");
        a / c
    } else {
        a / b
    }
}

let main = ()=> {
    let result: f64 =
        try {
            abortdefer {
                println("abort");
            }
            let x = safeDivide(10, 0);
            println("Done safeDivide: " + x);
            x * 2.0
        } with Exception {
            control throw: (msg: symbol)=> {
                resume(1);
                println("after longjmp\n"); // This line will not be executed.

                // abort(6.6);
            }
        }
    println("Result: " + result);
}
*/

#define INIT_EFFECT_OPERATION 0
#define RESUME_EFFECT_OPERATION 1
#define ABORT_EFFECT_OPERATION 2

typedef struct effect_jmp_buf
{
    jmp_buf *env;
    void *resume_value;
    void *abort_value;
    struct effect_jmp_buf *root
} effect_jmp_buf_t;

int safeDivide(int a,
               int b,
               effect_jmp_buf_t *parent, // parent buffer
               void (*throw)(char *msg, effect_jmp_buf_t *buffer))
{
    if (b == 0)
    {
        // calling "control" effect operation "throw":
        jmp_buf throw_env;
        int throw_resume_result;
        double throw_abort_result;
        effect_jmp_buf_t throw_buffer = (effect_jmp_buf_t){
            .env = &throw_env,
            .resume_value = &throw_resume_result,
            .abort_value = &throw_abort_result,
            .root = parent->root == NULL ? parent : parent->root,
        };
        int c;
        switch (setjmp(*throw_buffer.env))
        {
        case INIT_EFFECT_OPERATION:
        {
            throw("Division by zero", &throw_buffer);
            break;
        }
        case RESUME_EFFECT_OPERATION:
        {
            // resume
            c = *((int *)throw_buffer.resume_value);
            printf("resume throw\n");
            break;
        }
        case ABORT_EFFECT_OPERATION:
        {
            // abort
            printf("abort throw\n");
            longjmp(*(parent->env), ABORT_EFFECT_OPERATION);
            break;
        }
        }
        return a / c;
    }
    else
    {
        return a / b;
    }
}

// Effect handler
void throw(char *msg, effect_jmp_buf_t *buffer)
{

    // resume(1);
    *((int *)(buffer->resume_value)) = 1;
    longjmp(*(buffer->env), RESUME_EFFECT_OPERATION);
    printf("after longjmp\n");

    /*
    // abort(6.6);
    *((double *)(buffer->root->abort_value)) = 6.6;
    longjmp(*(buffer->env), ABORT_EFFECT_OPERATION);
    */
}

int main()
{
    jmp_buf env;
    int try_resume_result;
    double try_abort_result;
    effect_jmp_buf_t try_buffer = (effect_jmp_buf_t){
        .env = &env,
        .resume_value = &try_resume_result,
        .abort_value = &try_abort_result,
        .root = NULL, // Because itself is root.
    };
    double result;
    switch (setjmp(*try_buffer.env))
    {
    case INIT_EFFECT_OPERATION:
    {
        int x = safeDivide(10, 0, &try_buffer, throw);
        printf("Done safeDivide: %d\n", x);
        result = x * 2.0;
        break;
    }
    case ABORT_EFFECT_OPERATION:
    {
        // abort
        printf("abort\n");
        result = *((double *)try_buffer.abort_value);
        break;
    }
    default:
    {
        // Shouldn't enter here
        printf("Shouldn't enter here");
    }
    }

    printf("Result: %f\n", result);
    return 0;
}