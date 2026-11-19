#!/usr/bin/env python3
"""Follow std module renames in the frozen audit corpus (scripts/test7.sh, leg (b)).

Usage: python3 -I respell_imports.py <corpus dir> <std dir>

Every `import("std/<p>")` whose <p> resolves in the candidate's std (as <p>.yo or <p>/index.yo) is left
alone. One that does not is rewritten to its kebab-case spelling (`_` -> `-` in every segment) when THAT
resolves; otherwise it is left alone and the program is rejected as a stale probe, which the classifier
reports. Prints one line per rewritten path and a total. Python standard library only.
"""

import os
import re
import sys

IMPORT = re.compile(r'import\("std/([^"]+)"\)')


def resolves(std, p):
    return os.path.isfile(os.path.join(std, p + ".yo")) or os.path.isfile(os.path.join(std, p, "index.yo"))


def main():
    corpus, std = sys.argv[1], sys.argv[2]
    renamed = {}
    files = 0
    for d, _, names in os.walk(corpus):
        for n in names:
            if not n.endswith(".yo"):
                continue
            path = os.path.join(d, n)
            with open(path, encoding="utf-8", errors="surrogateescape") as f:
                text = f.read()

            def sub(m):
                p = m.group(1)
                if resolves(std, p):
                    return m.group(0)
                k = p.replace("_", "-")
                if k != p and resolves(std, k):
                    renamed[p] = k
                    return 'import("std/%s")' % k
                renamed.setdefault(p, None)
                return m.group(0)

            new = IMPORT.sub(sub, text)
            if new != text:
                files += 1
                with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                    f.write(new)
    for p in sorted(renamed):
        k = renamed[p]
        print("respell: std/%s -> %s" % (p, ("std/" + k) if k else "UNRESOLVED (left as written)"))
    print("respell: %d file(s) rewritten" % files)


if __name__ == "__main__":
    main()
