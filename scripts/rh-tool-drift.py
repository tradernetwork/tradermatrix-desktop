#!/usr/bin/env python3
"""Robinhood MCP contract drift check (read-only, offline).

Compare a fresh tool-list capture (the app's "Save tool list" button writes robinhood-tools-<date>.json under the app data
`captures/` folder) against a baseline capture, and flag changes to the tools this app actually calls.

  python3 -I scripts/rh-tool-drift.py BASELINE.json NEW.json [--src apps/desktop/src-tauri/src/rh]

Reports: tools added, tools removed, input-property changes (added/removed/required changes) and, separately, which of those
touch a tool the Rust core calls (found as string literals in the rh/ sources). Exit code 1 if a USED tool was removed or its
required inputs changed, so it can gate a release check. It never contacts any server and never reads credentials.
"""
import json, re, sys, pathlib

def load(path):
    d = json.load(open(path))
    tools = d if isinstance(d, list) else d.get("tools", d)
    out = {}
    for t in tools:
        schema = t.get("inputSchema") or t.get("input_schema") or {}
        out[t["name"]] = {"props": set((schema.get("properties") or {}).keys()), "required": set(schema.get("required") or [])}
    return out

def used_names(src_dir, names):
    used = set()
    for f in pathlib.Path(src_dir).rglob("*.rs"):
        text = f.read_text(errors="ignore")
        for n in names:
            if f'"{n}"' in text:
                used.add(n)
    return used

def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    src = "apps/desktop/src-tauri/src/rh"
    if "--src" in argv:
        src = argv[argv.index("--src") + 1]
        args = [a for a in args if a != src]
    if len(args) != 2:
        print(__doc__); return 2
    base, new = load(args[0]), load(args[1])
    used = used_names(src, set(base) | set(new)) if pathlib.Path(src).is_dir() else set()
    added, removed = sorted(set(new) - set(base)), sorted(set(base) - set(new))
    changed = []
    for n in sorted(set(base) & set(new)):
        b, c = base[n], new[n]
        if b["props"] != c["props"] or b["required"] != c["required"]:
            changed.append((n, sorted(c["props"] - b["props"]), sorted(b["props"] - c["props"]), sorted(c["required"] - b["required"]), sorted(b["required"] - c["required"])))
    print(f"baseline {len(base)} tools, new {len(new)} tools, app calls {len(used)} of them")
    print(f"\nADDED ({len(added)}):", ", ".join(added) or "none")
    print(f"\nREMOVED ({len(removed)}):", ", ".join(f"{n}{' [USED]' if n in used else ''}" for n in removed) or "none")
    print(f"\nCHANGED INPUTS ({len(changed)}):")
    bad = [n for n in removed if n in used]
    for n, add_p, rem_p, add_r, rem_r in changed:
        mark = " [USED]" if n in used else ""
        print(f"  {n}{mark}: +props {add_p} -props {rem_p} +required {add_r} -required {rem_r}")
        if n in used and (add_r or rem_p):
            bad.append(n)
    if bad:
        print("\nBREAKING for a tool the app calls:", ", ".join(sorted(set(bad)))); return 1
    print("\nno breaking change to a used tool"); return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
