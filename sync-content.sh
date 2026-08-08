#!/bin/bash
# 応用情報フォルダの最新内容をQuartzのcontent/へ同期し、GitHubへpushするスクリプト
# 使い方: ./sync-content.sh

set -euo pipefail

SRC="/Users/yoshidatomohiro/Library/Mobile Documents/iCloud~md~obsidian/Documents/second_brain/002.Notes/002.Privates/勉強/応用情報技術者試験"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rsync -a --delete \
  --exclude='.claude' \
  --exclude='CLAUDE.md' \
  --exclude='*.bak-*' \
  --exclude='*.bak_*' \
  --exclude='.DS_Store' \
  "$SRC/" "$SCRIPT_DIR/content/"

cd "$SCRIPT_DIR"

# 用語集から暗記カード（quartz/static/flashcards/index.html）を再生成する
node quartz/tools/build-flashcards.mjs

npx quartz sync
