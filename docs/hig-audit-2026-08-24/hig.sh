#!/usr/bin/env bash
#
# Eine Seite der Apple Human Interface Guidelines als Klartext ausgeben.
#
#   ./hig.sh sidebars
#   ./hig.sh designing-for-ios
#
# Warum es dieses Skript gibt: developer.apple.com/design/human-interface-guidelines
# ist eine JavaScript-Anwendung. Ein gewoehnlicher Abruf der HTML-Seite liefert nur
# den Titel — der Text steht ausschliesslich im DocC-JSON dahinter. Ohne diesen Umweg
# laesst sich die HIG nicht zitierfaehig lesen, nur aus dem Gedaechtnis behaupten.
#
# Die Slugs stehen in README.md.
set -euo pipefail

curl -sS -m 30 "https://developer.apple.com/tutorials/data/design/human-interface-guidelines/${1}.json" \
  | python3 -c '
import json, sys

d = json.load(sys.stdin)

def inline(xs):
    out = []
    for x in xs or []:
        t = x.get("type")
        if t == "text":
            out.append(x.get("text", ""))
        elif t == "codeVoice":
            out.append(x.get("code", ""))
        elif t in ("emphasis", "strong"):
            out.append(inline(x.get("inlineContent")))
        elif t == "reference":
            out.append(x.get("title", "") or "")
        elif "inlineContent" in x:
            out.append(inline(x["inlineContent"]))
    return "".join(out)

def block(bs, ind=""):
    for b in bs or []:
        t = b.get("type")
        if t == "heading":
            print("\n" + "#" * max(1, b.get("level", 2)) + " " + b.get("text", ""))
        elif t == "paragraph":
            print(ind + inline(b.get("inlineContent")))
        elif t in ("unorderedList", "orderedList"):
            for i, it in enumerate(b.get("items", []), 1):
                print(ind + ("- " if t == "unorderedList" else str(i) + ". "), end="")
                block(it.get("content"), "")
        elif t == "aside":
            print("[" + str(b.get("style", "note")).upper() + "]", end=" ")
            block(b.get("content"), ind)
        elif t == "codeListing":
            print(ind + "\n".join(b.get("code", [])))
        elif t == "table":
            for row in b.get("rows", []):
                print(ind + " | ".join(
                    inline(c[0].get("inlineContent")) if c and isinstance(c[0], dict) else ""
                    for c in row))
        elif "content" in b:
            block(b["content"], ind)

print("# " + d.get("metadata", {}).get("title", ""))
print(inline(d.get("abstract")))
for s in d.get("primaryContentSections", []):
    block(s.get("content"))
for ts in d.get("topicSections", []) or []:
    print("\n## [Unterseiten] " + ts.get("title", ""))
    for ident in ts.get("identifiers", []):
        ref = d.get("references", {}).get(ident, {})
        if ref.get("url"):
            print("- " + ref.get("title", "") + " :: " + ref["url"].rsplit("/", 1)[-1])
'
