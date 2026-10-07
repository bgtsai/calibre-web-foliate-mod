#!/usr/bin/env python3
"""把未壓縮的原始碼打包回 calibre-web-foliate-mod.user.js。

  src/app-ui.js         -> const APP_SCRIPT_TEMPLATE = "...";
  foliate-src/bundle.js -> const BUNDLE_SOURCE = "...";

原始碼內容「原封不動」轉成 JSON 字串，整行覆蓋，不加任何包裝
（src/app-ui.js 本身已經含有 ;(async () => { ... })(); 外殼）。

用法（在 repo 根目錄執行）：
  python3 tools/pack.py            # 兩個都打包
  python3 tools/pack.py app        # 只打包 APP_SCRIPT_TEMPLATE
  python3 tools/pack.py bundle     # 只打包 BUNDLE_SOURCE
  python3 tools/pack.py --check    # 只檢查是否同步，不寫入（不同步時 exit 1）

@version 不在這裡處理，請另外手動修改 user.js 標頭。
"""
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
USER_JS = ROOT / "calibre-web-foliate-mod.user.js"
TARGETS = {
    "app": ("    const APP_SCRIPT_TEMPLATE = ", ROOT / "src" / "app-ui.js"),
    "bundle": ("    const BUNDLE_SOURCE = ", ROOT / "foliate-src" / "bundle.js"),
}


def find_line(lines, prefix):
    hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    if len(hits) != 1:
        sys.exit(f"錯誤：user.js 裡找到 {len(hits)} 行以 {prefix.strip()!r} 開頭（應該剛好 1 行）")
    return hits[0]


def decode(line, prefix):
    return json.loads(line[len(prefix):].rstrip().rstrip(";"))


def main(argv):
    check_only = "--check" in argv
    names = [a for a in argv if not a.startswith("--")] or list(TARGETS)
    for n in names:
        if n not in TARGETS:
            sys.exit(f"錯誤：未知目標 {n!r}，可用：{', '.join(TARGETS)}")

    text = USER_JS.read_text(encoding="utf-8")
    lines = text.split("\n")
    out_of_sync = []

    for n in names:
        prefix, src_path = TARGETS[n]
        src = src_path.read_text(encoding="utf-8")
        idx = find_line(lines, prefix)
        same = decode(lines[idx], prefix) == src
        rel = src_path.relative_to(ROOT)
        if check_only:
            print(f"{n}: {'同步' if same else '不同步'}（{rel} ↔ user.js 第 {idx + 1} 行）")
            if not same:
                out_of_sync.append(n)
            continue
        lines[idx] = prefix + json.dumps(src) + ";"
        print(f"{n}: {rel} {len(src):,} 字元 -> user.js 第 {idx + 1} 行"
              + ("（內容未變）" if same else ""))

    if check_only:
        return 1 if out_of_sync else 0

    USER_JS.write_text("\n".join(lines), encoding="utf-8")

    # 寫入後驗證：重新讀檔、解碼，必須與原始碼完全一致
    lines2 = USER_JS.read_text(encoding="utf-8").split("\n")
    for n in names:
        prefix, src_path = TARGETS[n]
        if decode(lines2[find_line(lines2, prefix)], prefix) != src_path.read_text(encoding="utf-8"):
            sys.exit(f"錯誤：{n} 寫入後讀回不一致")
    if len(lines2) != len(lines):
        sys.exit("錯誤：user.js 行數改變")

    # 語法檢查（有 node 才跑）
    if shutil.which("node"):
        r = subprocess.run(["node", "--check", str(USER_JS)], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("錯誤：user.js 語法檢查失敗\n" + r.stderr[:2000])
        print("驗證通過：讀回一致、node --check 通過")
    else:
        print("驗證通過：讀回一致（找不到 node，略過語法檢查）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
