typedef struct { void* data; void* vtable; } dyn_t;      /* 16B: REGISTER */
typedef struct { long a, b, c, d; } Big;                 /* 32B: MEMORY  */
typedef Big (*big_fn)(dyn_t);
/* the real callee, as codegen emits it */
void handler(dyn_t err);
/* the call site, as codegen emits it: cast the void* slot to a
   value-returning fn type */
void call_site(void* slot, dyn_t err) { Big r = ((big_fn)slot)(err); (void)r; }
