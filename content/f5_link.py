#!/usr/bin/env python3
"""F5：教科書→用語集のリンク設定

02_リンク設定F5.md に埋め込まれていたスクリプトを外出ししたもの。
2026-08-08、00_引き継ぎ.md 冒頭ブリーフィングに列挙された過去の罠対策を追加した：
  1. 行内バッククォート（`...`）で囲まれた範囲も除外（罠#23）
  2. ASCII略語は前後が英数字でないことを確認してから置換（罠#20）
  3. カタカナ語も前後がカタカナ・長音符でないことを確認（罠#34）
  4. 表内でaliasリンクを生成するときは最初から `\|` でエスケープして出力（罠#9）
  5. 挿入後に隣接する `**` を検出し、密着していたら自動で太字を外す（罠#21）
リンクの粒度・除外ルール（段落ごと初出・見出し/コードブロック/付録は対象外）は変えていない。

使い方：
    python3 f5_link.py 11_セキュリティ --dry   # 付与件数だけ見る（ファイルは変更しない）
    python3 f5_link.py 11_セキュリティ         # 実行（教科書を書き換える。前にバックアップを取る）

実行後は 02_リンク設定F5.md の「検証（必須）」を必ず行うこと。
このスクリプトの自己検査は入れ子の破損と生`**`の残存しか見ておらず、
リンク切れ・alias実体の突合は検出できない。
"""
import glob
import os
import re
import shutil
import sys
import datetime

BASE = os.path.dirname(os.path.abspath(__file__))


def build_term_map(field):
    """term_to_slug: 表記(title自身 or alias) -> 実ファイル名(=正しいリンクターゲット)"""
    term_to_slug = {}
    for f in glob.glob(os.path.join(BASE, f"用語集/{field}/*.md")):
        base = os.path.splitext(os.path.basename(f))[0]   # ★ 実ファイル名を主キーにする
        if base.startswith("00_"):
            continue
        fm = open(f, encoding="utf-8").read().split("---")[1]
        title = None
        aliases = []
        in_aliases = False
        for line in fm.split("\n"):
            if line.startswith("title:"):
                title = line[6:].strip()
            elif line.startswith("aliases:"):
                in_aliases = True
            elif line.startswith("  - ") and in_aliases:
                aliases.append(line[4:].strip())
            elif line and not line.startswith(" "):
                in_aliases = False
        if title:
            term_to_slug[title] = base
            for a in aliases:
                term_to_slug[a] = base
    return term_to_slug


ASCII_RE = re.compile(r"^[A-Za-z0-9]+$")
KATAKANA_RE = re.compile(r"^[ァ-ヶー]+$")


def make_pattern(term):
    """罠#20・#34：ASCII略語・カタカナ語は単語境界チェックを入れる"""
    esc = re.escape(term)
    if ASCII_RE.match(term):
        return re.compile(r"(?<![A-Za-z0-9])" + esc + r"(?![A-Za-z0-9])")
    if KATAKANA_RE.match(term):
        return re.compile(r"(?<![ァ-ヶー])" + esc + r"(?![ァ-ヶー])")
    return re.compile(esc)


def _strip_if_has_link(m):
    inner = m.group(1)
    return inner if "[[" in inner else m.group(0)


def defuse_bold(line):
    """罠#21：**...** の中にリンクが含まれていたら太字マーカーごと外す。
    部分密着（**16 [[語]]** 等）を「**16 **[[語]]」のように変形すると、
    閉じ`**`の直前が空白になりCommonMarkの右フランキング条件を満たさず
    literalな`**`として残る事故を2026-08-08に実測したため、
    太字ペア単位で丸ごと除去する方式に変更した（装飾は失うが確実に壊れない）。
    複数リンクを含む太字・末尾に空白を含む太字も同じ処理で解消する。
    """
    return re.sub(r"\*\*([^*]*?)\*\*", _strip_if_has_link, line)


def link(field, dry=False):
    book = os.path.join(BASE, f"教科書/{field}.md")
    if not os.path.isfile(book):
        print(f"教科書が無い: {book}")
        return 1

    term_to_slug = build_term_map(field)
    if not term_to_slug:
        print(f"用語集が空: 用語集/{field}/")
        return 1
    terms = sorted(term_to_slug.keys(), key=len, reverse=True)   # 長い語から（誤爆防止）

    src = open(book, encoding="utf-8").read().split("\n")
    appendix = next((i for i, l in enumerate(src) if l.startswith("## 付録")), len(src))

    out = []
    infence = False
    para = 0
    prev_blank = True
    seen = set()
    for i, l in enumerate(src):
        if l.strip().startswith("```"):
            infence = not infence
            out.append(l)
            continue
        if l.strip() == "":
            prev_blank = True
            out.append(l)
            continue
        if prev_blank:
            para += 1
        prev_blank = False
        if i >= appendix or infence or l.startswith("#"):
            out.append(l)
            continue            # 付録・コード・見出しは除外（表は対象）
        # 罠#9：表内はalias区切りの`|`をエスケープする（`>`で始まるblockquote内の表も対象）
        is_table_row = bool(re.match(r"^\s*>?\s*\|", l))
        for t in terms:
            slug = term_to_slug[t]
            k = (slug, para)    # ★ 実ファイル名単位で重複判定（表記違いでも同一ページなら1回）
            if k in seen:
                continue
            # 罠#23：[[...]] だけでなく `...`（行内コード）も置換対象から除外する
            parts = re.split(r"(\[\[[^\]]*\]\]|`[^`]*`)", l)
            done = False
            pat = make_pattern(t)
            for j, p in enumerate(parts):
                if p.startswith("[[") or p.startswith("`"):
                    continue
                m = pat.search(p)
                if m:
                    # ★ 表示は元の表記のまま
                    if t == slug:
                        repl = f"[[{slug}]]"
                    else:
                        sep = r"\|" if is_table_row else "|"
                        repl = f"[[{slug}{sep}{t}]]"
                    parts[j] = p[: m.start()] + repl + p[m.end() :]
                    done = True
                    break
            if done:
                l = "".join(parts)
                seen.add(k)
        out.append(defuse_bold(l))

    result = "\n".join(out)

    # --- 自己検査：入れ子の破損（罠：[[[[ や ]]]] が残ると描画が壊れる） ---
    if "[[[[" in result or "]]]]" in result:
        print("⛔ 中止：リンクの入れ子が壊れている（[[[[ または ]]]]）。ファイルは変更していない。")
        return 1

    # --- 参考カウント：** と [[ の隣接（罠#21の対処「リンクを太字の外に出す」の副産物も同じ文字列
    #     パターンになるため、未解決か解決済みかは正規表現では区別できない。02_リンク設定F5.mdの
    #     記載どおり、判定はローカルビルド後のHTML生`**`カウント【必須】で行う） ---
    glued = len(re.findall(r"\*\*\[\[[^\]]*\]\]|\[\[[^\]]*\]\]\*\*", result))
    if glued:
        print(f"（参考）** と [[ が隣接する箇所：{glued}件。多くは罠#21の対処の正常な副産物。")
        print("   → 判定はビルド後のHTML生`**`カウントで行うこと（02_リンク設定F5.md の(6)、必須）。")

    if dry:
        print(f"[dry-run] {field}: {len(seen)} 箇所に付与される（ファイルは変更していない）")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    bak = f"{book}.bak_{stamp}"
    shutil.copy2(book, bak)
    open(book, "w", encoding="utf-8").write(result)
    print(f"リンク設定完了: {len(seen)} 箇所")
    print(f"バックアップ: {os.path.basename(bak)}")
    print("→ 02_リンク設定F5.md の「検証（必須）」を実行すること（(1)〜(6)全部）")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(1)
    sys.exit(link(args[0], dry="--dry" in sys.argv))
