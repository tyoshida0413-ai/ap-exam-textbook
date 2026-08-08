#!/usr/bin/env python3
"""用語集の機械検査（F2量産後・F3レビュー前に必ず実行する）

目的：LLMに全ファイルを読ませずに、仕様違反だけを機械で抽出する。
      これを通してから、弾かれた語だけをOpusが読む。全件をLLMに流し読みさせない。
      （→ 00_引き継ぎ.md 2章「全部Sonnetで作ってから全部Opusでレビューはしない」）

使い方：
    python3 検証.py              # 全分野
    python3 検証.py 10_ネットワーク  # 分野を指定
    python3 検証.py --list       # 違反ファイルのパスだけを改行区切りで出力（加筆作業の入力用）

検査する仕様の出典：00_引き継ぎ.md 4章（テンプレート）・5章（執筆ルール）・6章（難語の選定基準）
"""
import glob
import os
import re
import statistics
import sys

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "用語集")

# 難語の分量仕様（易語には分量仕様がない）
NAN_MIN = 1000
NAN_MAX = 1500

# 全語で必須（4章「セクションの増減ルール」）
REQUIRED_ALWAYS = ["関連"]
# 難語でのみ必須。易語では省略してよい（制度名・組織名などは自然な比喩がないため）
REQUIRED_NAN = ["なぜそうなるのか"]


def parse(path):
    t = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", t, re.S)
    if not m:
        return None, None, t
    return m.group(1), m.group(2), t


def check(path):
    """1ファイルを検査して違反リストを返す"""
    fm, body, t = parse(path)
    v = []
    if fm is None:
        return ["frontmatterが無い"], None, 0

    lv = (re.search(r"難度:\s*(\S+)", fm) or [None, None])[1]
    n = len(body)

    if lv not in ("易", "難"):
        v.append(f"難度が不正（{lv}）")
    if not re.search(r"title:\s*\S", fm):
        v.append("titleが無い")
    if not re.search(r"分野:\s*\S", fm):
        v.append("分野が無い")

    # 一言定義（本文冒頭の引用行）
    if not re.search(r"^>\s*\S", body, re.M):
        v.append("一言定義（>行）が無い")

    for s in REQUIRED_ALWAYS:
        if f"## {s}" not in t:
            v.append(f"必須セクション欠落: {s}")
    if lv == "難":
        for s in REQUIRED_NAN:
            if f"## {s}" not in t:
                v.append(f"難語の必須セクション欠落: {s}")
        if n < NAN_MIN:
            v.append(f"分量不足 {n}字（仕様{NAN_MIN:,}〜{NAN_MAX:,}字）")

    # 教科書への導線（このプロジェクトの要。1本必須）
    if "教科書：[[教科書/" not in t:
        if "教科書：[[" in t:
            v.append("教科書リンクが 教科書/ 配下を指していない（ルート直下＝404になる）")
        else:
            v.append("教科書へのリンクが無い")

    # 表記ルール
    if re.search(r"[①-⑳]", t):
        v.append("丸囲み数字が使われている")
    # 入れ子の壊れ
    if "[[[[" in t or "]]]]" in t:
        v.append("リンクの入れ子が壊れている")

    return v, lv, n


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    list_mode = "--list" in sys.argv
    pat = os.path.join(BASE, args[0] if args else "*", "*.md")

    files = [f for f in sorted(glob.glob(pat)) if not os.path.basename(f).startswith("00_")]
    if not files:
        print(f"対象ファイルが無い: {pat}")
        return 1

    bad = []
    sizes = {"易": [], "難": []}
    for f in files:
        v, lv, n = check(f)
        if lv in sizes:
            sizes[lv].append(n)
        if v:
            bad.append((f, v, n))

    if list_mode:
        for f, v, n in bad:
            print(f)
        return 0

    print(f"=== 用語集 機械検査：{len(files)}本 ===")
    for lv in ("難", "易"):
        a = sorted(sizes[lv])
        if not a:
            continue
        med = int(statistics.median(a))
        note = ""
        if lv == "難":
            note = f"  ／ 仕様{NAN_MIN:,}字未満: {sum(1 for x in a if x < NAN_MIN)}本"
        print(f"  難度={lv}: {len(a)}本  中央値={med:,}字  最小={a[0]:,}  最大={a[-1]:,}{note}")

    if not bad:
        print("\n違反なし。")
        return 0

    print(f"\n=== 違反: {len(bad)}本 ===")
    for f, v, n in sorted(bad, key=lambda x: x[2]):
        rel = os.path.relpath(f, BASE)
        print(f"  {n:6}字  {rel}")
        for x in v:
            print(f"           - {x}")
    print(f"\n合計 {len(bad)}本 が要対応。この語だけをLLMが読むこと（全件は読ませない）。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
