"""Extract the type-definition prefix of the emitted C and print sizeof for
the compiler's hot types."""
import re
import subprocess

src = open('/tmp/re/s1in.c').read()
# cut at the first function implementation marker
for marker in ("// Function implementations", "// Function declarations"):
    i = src.find(marker)
    if i > 0:
        break
prefix = src[:i]
# drop global variable definitions that call functions (keep pure typedefs/enums)
lines = prefix.split('\n')
kept = []
for L in lines:
    if re.match(r'^(static|extern)?\s*[A-Za-z_][\w \*]*\s+\w+\s*=\s*.*fn_yo', L):
        continue
    kept.append(L)
prefix = '\n'.join(kept)

targets = {
    'ExprInfo': '__yo_struct_yoe8350aff_id_136',
    'Variable': '__yo_struct_yoc10a5ffb_id_9',
    'Frame': '__yo_struct_yoc10a5ffb_id_61',
    'Environment': '__yo_struct_yoc10a5ffb_id_116',
    'Token': '__yo_struct_yoceebd0e9_id_35',
    'TypeValue(enum)': '__yo_enum_yob87149e5_id_28',
    'EvalValue(enum)': '__yo_enum_yo52b1f8e3_id_28',
    'AstExpr(enum)': '__yo_enum_yoe4f8607a_id_3',
    'SynthesizeResult': '__yo_struct_yo67b324e0_id_29',
}
main = ['\n#include <stdio.h>\nint main(void){']
for name, ty in targets.items():
    main.append('  printf("%%-18s %%zu\\n", "%s", sizeof(%s));' % (name, ty))
main.append('  return 0;\n}\n')

open('/tmp/re/sizeof_probe.c', 'w').write(prefix + '\n'.join(main))
r = subprocess.run(['clang', '-std=c11', '-w', '-O0', '/tmp/re/sizeof_probe.c',
                    '-o', '/tmp/re/sizeof_probe'], capture_output=True, text=True)
if r.returncode != 0:
    print('BUILD FAILED')
    print(r.stderr[-3000:])
else:
    print(subprocess.run(['/tmp/re/sizeof_probe'], capture_output=True, text=True).stdout)
