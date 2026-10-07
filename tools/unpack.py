#!/usr/bin/env python3
"""從 calibre-web-foliate-mod.user.js 解出未壓縮的原始碼。

  const APP_SCRIPT_TEMPLATE = "..."; -> src/app-ui.js
  const BUNDLE_SOURCE = "...";       -> foliate-src/bundle.js

用法（在 repo 根目錄執行）：
  python3 tools/unpack.py                  # 兩個都解出，覆蓋原始碼檔
  python3 tools/unpack.py app              # 只解 APP_SCRIPT_TEMPLATE
  python3 tools/unpack.py bundle           # 只解 BUNDLE_SOURCE
  python3 tools/unpack.py --from <commit>  # 從指定 commit 的 user.js 解出（例如還原舊版）

正常流程是「改原始碼 -> pack.py」，unpack 只用在原始碼與 user.js
脫節、需要以 user.js 為準重建原始碼的時候。
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
USER_JS_NAME = "calibre-web-foliate-mod.user.js"
TARGETS = {
    "app": ("    const APP_SCRIPT_TEMPLATE = ", ROOT / "src" / "app-ui.js"),
    "bundle": ("    const BUNDLE_SOURCE = ", ROOT / "foliate-src" / "bundle.js"),
}


def main(argv):
    commit = None
    if "--from" in argv:
        i = argv.index("--from")
        if i + 1 >= len(argv):
            sys.exit("錯誤：--from 後面要接 commit")
        commit = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    names = [a for a in argv if not a.startswith("--")] or list(TARGETS)
    for n in names:
        if n not in TARGETS:
            sys.exit(f"錯誤：未知目標 {n!r}，可用：{', '.join(TARGETS)}")

    if commit:
        r = subprocess.run(["git", "-C", str(ROOT), "show", f"{commit}:{USER_JS_NAME}"],
                           capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            sys.exit("錯誤：git show 失敗\n" + r.stderr)
        text = r.stdout
    else:
        text = (ROOT / USER_JS_NAME).read_text(encoding="utf-8")
    lines = text.split("\n")

    for n in names:
        prefix, out_path = TARGETS[n]
        hits = [l for l in lines if l.startswith(prefix)]
        if len(hits) != 1:
            sys.exit(f"錯誤：找到 {len(hits)} 行以 {prefix.strip()!r} 開頭（應該剛好 1 行）")
        content = json.loads(hits[0][len(prefix):].rstrip().rstrip(";"))
        old = out_path.read_text(encoding="utf-8") if out_path.exists() else None
        out_path.parent.mkdir(exist_ok=True)
        out_path.write_text(content, encoding="utf-8")
        status = "新建" if old is None else ("內容未變" if old == content else "已覆蓋（內容有變）")
        print(f"{n}: {len(content):,} 字元 -> {out_path.relative_to(ROOT)}（{status}）"
              + (f" 來源 {commit}" if commit else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
