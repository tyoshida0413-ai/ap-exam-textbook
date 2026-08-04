#!/usr/bin/env node
/**
 * 用語集Markdown → 暗記カード（自己完結HTML）を生成する。
 *
 * 入力: content/用語集/{09_データベース,10_ネットワーク,11_セキュリティ}/*.md
 * 出力: quartz/static/flashcards/index.html
 *
 * 各Markdownの「H1見出しの直後にあるblockquote」を問題文、frontmatterの title を答えとする。
 * 定義文に答え（title / aliases）がそのまま書かれている場合は MASK に置換する。
 *
 * 設計書: docs/superpowers/specs/2026-08-04-flashcards-design.md
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, "..", "..")
const SRC_DIR = join(REPO, "content", "用語集")
const OUT_FILE = join(REPO, "quartz", "static", "flashcards", "index.html")
const TEMPLATE = join(__dirname, "flashcards-template.html")

const MASK = "〇〇〇"

/** フォルダ名 → カテゴリ識別子 */
const CATEGORIES = {
  "09_データベース": "database",
  "10_ネットワーク": "network",
  "11_セキュリティ": "security",
}

/**
 * 自動の伏字化では不自然になるカードの問題文を手書きで差し替える。
 * キーは frontmatter の title。
 */
const OVERRIDES = {
  // 自動処理だと「複数拠点から行うものをD〇〇〇という」と断片が残るため
  "DoS攻撃": "大量の要求を送りサービスを停止させる攻撃。複数拠点から分散して行うものは別名で呼ばれる。",
  // 日本語名は伏せられるが英語の正式名称が残り答えが判明するため、その一文を除く
  "CSMA/CD":
    "有線LAN（イーサネット）のアクセス制御方式。送信前に回線が空いているか調べ、衝突が起きたら検出してランダムな時間だけ待ち、再送する。",
}

/** frontmatter と本文に分割する */
function splitFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw)
  if (!m) return { fm: "", body: raw }
  return { fm: m[1], body: raw.slice(m[0].length) }
}

function readTitle(fm) {
  const m = /^title:\s*(.+)$/m.exec(fm)
  return m ? m[1].trim() : ""
}

function readAliases(fm) {
  const block = /^aliases:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m.exec(fm)
  if (!block) return []
  return [...block[1].matchAll(/^[ \t]*-[ \t]*(.+)$/gm)]
    .map((x) => x[1].trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

/** H1直後のblockquoteを1文にまとめて取り出す */
function readDefinition(body) {
  const h1 = /^#[ \t]+.+$/m.exec(body)
  if (!h1) return ""
  const after = body.slice(h1.index + h1[0].length)

  const lines = []
  let started = false
  for (const line of after.split("\n")) {
    if (!started) {
      if (line.trim() === "") continue
      started = true
    }
    if (line.trimStart().startsWith(">")) {
      lines.push(line.trimStart().slice(1).trim())
    } else {
      break
    }
  }
  return lines.filter(Boolean).join(" ")
}

/** Markdown記法を落としてプレーンテキストにする */
function toPlainText(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[target|表示]]
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[target]]
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** 定義文に含まれる答え（title / aliases）を伏字にする */
function maskAnswer(text, answers) {
  let out = text
  // 長い語から順に置換して、部分一致による断片化を抑える
  for (const a of [...new Set(answers)].filter(Boolean).sort((x, y) => y.length - x.length)) {
    out = out.split(a).join(MASK)
  }
  return out.replace(new RegExp(`(?:${MASK})+`, "g"), MASK).replace(/\s+/g, " ").trim()
}

/** 頭字語の展開形を探すときに、頭文字として数えない連結語 */
const CONNECTORS = new Set([
  "and", "or", "of", "the", "for", "in", "on", "to", "with", "a", "an", "by", "at", "from",
])

/** 答えを英字だけに正規化する（CSMA/CD → CSMACD） */
const acronymKey = (s) => s.replace(/[^A-Za-z]/g, "").toUpperCase()

/**
 * 頭字語の展開形（例 CRL に対する "Certificate Revocation List"）が問題文にあれば伏字にする。
 * title / aliases の完全一致による伏字化では捕まえられないため、別途必要になる。
 */
function maskAcronymExpansion(text, answer) {
  const key = acronymKey(answer)
  // 英字主体で2文字以上の答えだけを対象にする
  if (key.length < 2 || !/^[A-Za-z0-9/\-. ]+$/.test(answer)) return text

  const words = [...text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)]
  for (let i = 0; i < words.length; i++) {
    if (CONNECTORS.has(words[i][0].toLowerCase())) continue
    let acro = ""
    for (let j = i; j < words.length; j++) {
      const w = words[j][0]
      // 連結語は頭文字に数えないが、範囲には含める
      if (!(acro && CONNECTORS.has(w.toLowerCase()))) acro += w[0].toUpperCase()
      if (acro.length > key.length) break
      if (acro === key && j > i) {
        const start = words[i].index
        const end = words[j].index + w.length
        return text.slice(0, start) + MASK + text.slice(end)
      }
    }
  }
  return text
}

/**
 * 文頭に残った伏字を整える。
 * 「〇〇〇（証明書失効リスト）。…」→「証明書失効リスト。…」
 * 「〇〇〇。…」→「…」
 */
function tidyLeadingMask(text) {
  const paren = new RegExp(`^${MASK}\\s*[（(]([^）)]+)[）)]\\s*[。.]?\\s*`)
  const m = paren.exec(text)
  if (m) return (m[1].trim() + "。" + text.slice(m[0].length)).trim()
  return text.replace(new RegExp(`^${MASK}\\s*[。.]\\s*`), "").trim()
}

/** 伏字化後も答えが残っていないか */
function leaks(text, answers) {
  const found = answers.filter((a) => a && text.includes(a))
  // 頭字語の展開形が残っていないかも確認する
  for (const a of answers) {
    if (a && maskAcronymExpansion(text, a) !== text) found.push(`${a}の展開形`)
  }
  return found
}

async function main() {
  const cards = []
  const warnings = []

  for (const [folder, cat] of Object.entries(CATEGORIES)) {
    const dir = join(SRC_DIR, folder)
    let files
    try {
      files = (await readdir(dir))
        .filter((f) => f.endsWith(".md"))
        // 「00_混同しやすい語の一覧」などの索引ページは用語ではないため除外する
        .filter((f) => !f.startsWith("00_"))
        .sort()
    } catch {
      warnings.push(`フォルダが見つかりません: ${dir}`)
      continue
    }

    for (const file of files) {
      const path = join(dir, file)
      const raw = await readFile(path, "utf8")
      const { fm, body } = splitFrontmatter(raw)

      const title = readTitle(fm) || basename(file, ".md")
      const aliases = readAliases(fm)
      const answers = [title, ...aliases]

      const rawDef = readDefinition(body)
      if (!rawDef) {
        warnings.push(`定義（H1直後のblockquote）が無いため除外: ${folder}/${file}`)
        continue
      }

      let question = OVERRIDES[title]
      if (question === undefined) {
        question = maskAnswer(toPlainText(rawDef), answers)
        // 頭字語の展開形（例 WAF に対する "Web Application Firewall"）も伏せる
        for (const a of answers) question = maskAcronymExpansion(question, a)
        question = question.replace(new RegExp(`(?:${MASK})+`, "g"), MASK).replace(/\s+/g, " ").trim()
        question = tidyLeadingMask(question)
      }

      if (question.length < 10) {
        warnings.push(`問題文が短すぎます（${question.length}字）: ${folder}/${file} → "${question}"`)
      }
      const leaked = leaks(question, answers)
      if (leaked.length) {
        warnings.push(`問題文に答えが残っています: ${folder}/${file} → ${leaked.join(", ")}`)
      }

      cards.push({ q: question, a: title, aliases, cat })
    }
  }

  const template = await readFile(TEMPLATE, "utf8")
  if (!template.includes("__CARDS__")) {
    throw new Error("テンプレートに __CARDS__ プレースホルダがありません")
  }
  // </script> がJSON中に現れてもHTMLが壊れないようエスケープする
  const json = JSON.stringify(cards).replace(/</g, "\\u003c")
  const html = template.replace("__CARDS__", json)

  await mkdir(dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, html, "utf8")

  const counts = Object.values(CATEGORIES).reduce((acc, c) => {
    acc[c] = cards.filter((x) => x.cat === c).length
    return acc
  }, {})

  console.log(`[flashcards] ${cards.length} 枚を生成しました`)
  for (const [cat, n] of Object.entries(counts)) console.log(`[flashcards]   ${cat}: ${n}`)
  console.log(`[flashcards] 出力: ${OUT_FILE}`)

  if (warnings.length) {
    console.warn(`[flashcards] 警告 ${warnings.length} 件:`)
    for (const w of warnings) console.warn(`[flashcards]   - ${w}`)
  }
}

main().catch((err) => {
  console.error("[flashcards] 生成に失敗しました:", err)
  process.exit(1)
})
