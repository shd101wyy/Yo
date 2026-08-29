import unicodedata, sys
# simple (single-codepoint) mappings; multi-codepoint expansions listed separately
simple={}  # cp -> (dU, dL)
multi_up=[]; multi_lo=[]
for cp in range(0x110000):
    if 0xD800<=cp<=0xDFFF: continue
    c=chr(cp); u=c.upper(); l=c.lower()
    dU=dL=0
    if u!=c:
        if len(u)==1: dU=ord(u)-cp
        else: multi_up.append((cp,[ord(x) for x in u]))
    if l!=c:
        if len(l)==1: dL=ord(l)-cp
        else: multi_lo.append((cp,[ord(x) for x in l]))
    if dU or dL: simple[cp]=(dU,dL)
# Build ranges. Kinds: plain (same dU,dL across range) or alternating "UL":
# even offset from lo is upper (dU=0,dL=+1), odd is lower (dU=-1,dL=0).
cps=sorted(simple)
ranges=[]
i=0
UL=('UL',)
while i<len(cps):
    cp=cps[i]; d=simple[cp]
    # try alternating run starting at an upper with (0,+1)
    if d==(0,1) and simple.get(cp+1)==(-1,0):
        j=cp
        while simple.get(j)==(0,1) and simple.get(j+1)==(-1,0): j+=2
        ranges.append((cp,j-1,'UL'))
        while i<len(cps) and cps[i]<=j-1: i+=1
        continue
    j=cp
    while simple.get(j+1)==d: j+=1
    ranges.append((cp,j,d))
    while i<len(cps) and cps[i]<=j: i+=1
print(len(ranges), len(multi_up), len(multi_lo), file=sys.stderr)
def emit_arr(name, vals):
    s=f"{name} :: Array(i32, usize({len(vals)}))(\n"
    s+=",\n".join(f"  i32({v})" for v in vals)+"\n);\n"
    return s
lo=[r[0] for r in ranges]; hi=[r[1] for r in ranges]
du=[ (1 if r[2]=='UL' else r[2][0]) for r in ranges]   # sentinel handled by flag arr
dl=[ (1 if r[2]=='UL' else r[2][1]) for r in ranges]
ul=[ (1 if r[2]=='UL' else 0) for r in ranges]
out=""
out+="// Generated from Unicode %s (Python unicodedata) by scratch gen_case.py.\n" % unicodedata.unidata_version
out+="// Each entry i covers code points _LO(i)..=_HI(i). When _UL(i) is 1 the\n// range alternates Upper, Lower, Upper, Lower… from _LO(i) (upper→lower is\n// +1, lower→upper is −1); otherwise upper(cp) = cp + _DU(i) and\n// lower(cp) = cp + _DL(i) (0 = no mapping).\n"
out+=emit_arr("_LO",lo)+emit_arr("_HI",hi)+emit_arr("_DU",du)+emit_arr("_DL",dl)+emit_arr("_UL",ul)
open("case_table.yo","w").write(out)
open("multi.txt","w").write("UP\n"+"\n".join(f"{cp:04X} -> {' '.join('%04X'%x for x in m)} {unicodedata.name(chr(cp),'?')}" for cp,m in multi_up)+"\nLO\n"+"\n".join(f"{cp:04X} -> {' '.join('%04X'%x for x in m)}" for cp,m in multi_lo))
# sanity: verify table reproduces simple map
def lookup(cp):
    import bisect
    k=bisect.bisect_right(lo,cp)-1
    if k<0 or cp>hi[k]: return (0,0)
    if ul[k]: return ((0,1) if (cp-lo[k])%2==0 else (-1,0))
    return (du[k],dl[k])
bad=sum(1 for cp in range(0x110000) if not (0xD800<=cp<=0xDFFF) and lookup(cp)!=simple.get(cp,(0,0)))
print("mismatches",bad,file=sys.stderr)
