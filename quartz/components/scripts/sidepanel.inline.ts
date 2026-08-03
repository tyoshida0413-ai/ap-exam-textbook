// 用語サイドパネル
//
// 本文中の内部リンクをクリックしたとき、ページ遷移せずに右側のパネルへ
// リンク先ページの中身を表示する。教科書を読みながら用語を引くための機能。
//
// 【設計の要点】
// - 教科書とパネルは独立して生きている。本文のスクロール位置・URLは一切変えない
// - 閉じるのは × と Esc のみ。画面外クリックでは閉じない（本文を触るたびに閉じては用をなさないため）
// - パネルはオーバーレイではなくグリッドの1列。右サイドバーの枠を引き継ぐので本文を覆わない
//   （幅の計算は custom.scss セクション1 のCSS変数に集約。ここは --right-col-width を変えるだけ）
// - ホバープレビュー(popover.inline.ts)と同じ方法でページを取得する。
//   fetchCanonical は alias の空リダイレクトページを自動追跡するため、
//   `[[デジタル署名]]` のような alias リンクでも実体ページが表示される（引き継ぎ 罠#8 が起きない）

import { normalizeRelativeURLs } from "../../util/path"
import { fetchCanonical } from "./util"

const parser = new DOMParser()

const PANEL_ID = "term-panel"
const OPEN_CLASS = "term-panel-open"
const MOBILE_BREAKPOINT = 800

// 連打時に古いfetchの結果が後から届いて上書きするのを防ぐ
let requestToken = 0

function isEnabled(): boolean {
  return window.innerWidth >= MOBILE_BREAKPOINT
}

function isOpen(): boolean {
  return document.body.classList.contains(OPEN_CLASS)
}

function closePanel() {
  document.body.classList.remove(OPEN_CLASS)
  requestToken++ // 進行中のfetchの結果を捨てる
}

/** パネルのDOMを用意する。SPA遷移でbodyごと差し替わるため、無ければ作り直す */
function ensurePanel(): HTMLElement | null {
  const existing = document.getElementById(PANEL_ID)
  if (existing) return existing

  const quartzBody = document.getElementById("quartz-body")
  if (!quartzBody) return null

  const panel = document.createElement("aside")
  panel.id = PANEL_ID
  panel.setAttribute("aria-label", "用語パネル")

  const header = document.createElement("div")
  header.className = "term-panel-header"

  // タイトルは実ページへのリンクにしておく（パネルではなく全画面で読みたいとき用）。
  // data-no-panel を付けて、このリンクだけは横取りせず通常遷移させる
  const title = document.createElement("a")
  title.className = "term-panel-title"
  title.dataset.noPanel = "true"

  const close = document.createElement("button")
  close.className = "term-panel-close"
  close.type = "button"
  close.setAttribute("aria-label", "パネルを閉じる")
  close.title = "閉じる（Esc）"
  close.textContent = "×"
  close.addEventListener("click", closePanel)

  header.appendChild(title)
  header.appendChild(close)

  const body = document.createElement("div")
  body.className = "term-panel-body"

  panel.appendChild(header)
  panel.appendChild(body)
  quartzBody.appendChild(panel)
  return panel
}

function setPanelMessage(panel: HTMLElement, message: string) {
  const body = panel.querySelector(".term-panel-body")
  if (body) body.innerHTML = `<p class="term-panel-message">${message}</p>`
}

async function openPanel(href: string) {
  const panel = ensurePanel()
  if (!panel) return

  const targetUrl = new URL(href, window.location.origin)
  const hash = decodeURIComponent(targetUrl.hash)
  targetUrl.hash = ""
  targetUrl.search = ""

  const token = ++requestToken
  document.body.classList.add(OPEN_CLASS)

  const titleEl = panel.querySelector(".term-panel-title") as HTMLAnchorElement | null
  const bodyEl = panel.querySelector(".term-panel-body") as HTMLElement | null
  if (!bodyEl) return

  if (titleEl) {
    titleEl.href = targetUrl.toString()
    titleEl.textContent = "読み込み中…"
  }
  setPanelMessage(panel, "読み込み中…")

  const response = await fetchCanonical(targetUrl).catch((err) => {
    console.error(err)
    return null
  })

  // 連打で新しいリクエストが始まっていたら、この結果は捨てる
  if (token !== requestToken) return

  if (!response || !response.ok) {
    if (titleEl) titleEl.textContent = "読み込めませんでした"
    setPanelMessage(panel, "ページを読み込めませんでした。")
    return
  }

  const contentType = response.headers.get("Content-Type")?.split(";")[0] ?? ""
  if (!contentType.startsWith("text/html")) {
    if (titleEl) titleEl.textContent = targetUrl.pathname
    setPanelMessage(panel, "このリンクはパネルで表示できません。")
    return
  }

  const html = parser.parseFromString(await response.text(), "text/html")
  if (token !== requestToken) return

  normalizeRelativeURLs(html, targetUrl)

  // 本文側のidと衝突するとアンカーや目次の追従が壊れるため、パネル内のidは退避させる
  html.querySelectorAll("[id]").forEach((el) => {
    el.id = `term-panel-internal-${el.id}`
  })

  // 取得先ページの .popover-hint は「タイトル部のdiv」と「本文のarticle」の2つある。
  // タイトル部はパンくず・タイトル・日付・文字数で、パネルではヘッダーと重複するため取らない。
  // 本文の article だけを使う（見つからない場合のみ従来どおり全部を使う）
  const mainArticle = html.querySelector("article.popover-hint")
  const parts = mainArticle ? [mainArticle] : [...html.getElementsByClassName("popover-hint")]
  if (parts.length === 0) {
    if (titleEl) titleEl.textContent = targetUrl.pathname
    setPanelMessage(panel, "表示できる内容がありませんでした。")
    return
  }

  if (titleEl) {
    titleEl.textContent = html.querySelector("h1")?.textContent?.trim() || targetUrl.pathname
  }

  bodyEl.replaceChildren(...parts)

  // 見出し指定のリンク（#...）なら、その位置までパネル内をスクロールする
  if (hash !== "") {
    const heading = bodyEl.querySelector(`#term-panel-internal-${hash.slice(1)}`) as HTMLElement | null
    bodyEl.scrollTop = heading ? heading.offsetTop - 12 : 0
  } else {
    bodyEl.scrollTop = 0
  }
}

/**
 * クリックを一括で受ける（イベント委譲）。
 * パネル内に後から挿入されたリンクにも自動で効くのでリスナーの張り直しが要らない。
 */
function onDocumentClick(event: MouseEvent) {
  if (!isEnabled()) return
  // 修飾キー・中クリックはブラウザ本来の挙動（新しいタブ等）を尊重する
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  if (event.defaultPrevented) return

  const target = event.target as HTMLElement | null
  const link = target?.closest?.("a") as HTMLAnchorElement | null
  if (!link) return
  if (!link.classList.contains("internal")) return
  if (link.dataset.noPanel === "true") return

  const insidePanel = link.closest(`#${PANEL_ID}`) !== null
  // 本文（.center > article）内のリンクだけを対象にする。
  // パンくず・エクスプローラー・目次・バックリンクは従来どおり遷移させたいため
  const insideMainArticle = !insidePanel && link.closest(".center > article") !== null
  if (!insidePanel && !insideMainArticle) return

  event.preventDefault()
  // ⚠️ preventDefault だけでは止まらない。
  // QuartzのSPAルータは window 上の click リスナーで、defaultPrevented を見ずに
  // 自前で preventDefault して遷移する（spa.inline.ts）。
  // バブリングは document → window の順なので、ここで伝播を止めれば SPA 側に届かない。
  event.stopPropagation()
  openPanel(link.href)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && isOpen()) {
    event.preventDefault()
    closePanel()
  }
}

function setupSidePanel() {
  // SPA遷移では body ごと差し替わる。パネルは作り直し、状態は閉じた状態に戻す
  document.body.classList.remove(OPEN_CLASS)
  ensurePanel()
}

// リスナーは document に一度だけ張る（nav のたびに増やさない）
if (!(window as unknown as { __termPanelBound?: boolean }).__termPanelBound) {
  ;(window as unknown as { __termPanelBound?: boolean }).__termPanelBound = true
  document.addEventListener("click", onDocumentClick)
  document.addEventListener("keydown", onKeydown)
  window.addEventListener("resize", () => {
    if (!isEnabled() && isOpen()) closePanel()
  })
}

document.addEventListener("nav", setupSidePanel)
document.addEventListener("render", setupSidePanel)
