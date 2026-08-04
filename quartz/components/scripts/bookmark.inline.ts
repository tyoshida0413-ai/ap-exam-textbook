// 付箋（しおり）機能
//
// 教科書1ページが13万字を超えるため、途中で中断すると「どこまで読んだか」を見失い、
// 最初から読み直すことになる。読んでいる位置に付箋を貼り、
// 別のページからでも・後日でも、一覧からワンクリックで続きへ戻れるようにする。
//
// 【設計の要点】
// - 保存先は localStorage。既定ではこのブラウザの中だけに残る。
//   iPad と Mac で共有したい場合は「同期の設定」から Cloudflare Worker を登録する
//   （iCloudはlocalStorageを同期しないため、ブラウザ任せでは端末をまたげない）
// - 1ページにつき付箋は1つ。貼り直すと位置が更新される。
//   「読書を再開する」のが目的なので、1ページに複数貼れると一覧がすぐ埋もれるため
// - 位置は【スクロール量(px)ではなく直近の見出しのid】で覚える。
//   本文を1文字加筆しただけでpxの位置は狂うが、見出しidなら教科書を書き足してもズレない
// - 一覧からの移動は <a href="/パス#見出しid"> で行う。QuartzのSPAルータが
//   hash を見て scrollIntoView してくれるので、こちら側にスクロール処理を持たない
//   （spa.inline.ts 115-119行 / 163-165行）
// - リンクに `internal` クラスを付けない。付けると用語サイドパネル
//   （sidepanel.inline.ts）がクリックを横取りし、パネルに開いてしまう

// ⚠️ 定数名を BOOKMARK_ で始めているのは短縮し忘れではない。
// import を持たない *.inline.ts は tsc からグローバルスクリプト扱いされ、
// 変数名が他の inline スクリプトと同じだと TS2451（再宣言）で `npm run check` が落ちる。
// 実際 sidebar-toggle.inline.ts が STORAGE_KEY を使っており衝突した。
// 実行時は componentResources.ts が各スクリプトを IIFE で包むため衝突しないが、型検査は通らない
const BOOKMARK_STORAGE_KEY = "ap-bookmarks-v1"
const BOOKMARK_SYNC_CONFIG_KEY = "ap-bookmarks-sync-v1"

const FAB_ID = "bookmark-fab"
const LIST_ID = "bookmark-list"
const OVERLAY_ID = "bookmark-overlay"
const BANNER_ID = "bookmark-banner"
const TOAST_ID = "bookmark-toast"
const LIST_OPEN_CLASS = "bookmark-list-open"

// 見出しを「今読んでいる位置」とみなす上端からの余白。
// 画面最上部ちょうどだと、見出しが1px上に外れた瞬間に次の見出し扱いになって落ち着かない
const HEADING_THRESHOLD_PX = 120

/** 墓標（削除済みの記録）をどれだけ残すか。これを過ぎたら本当に消す */
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000 // 60日

type Bookmark = {
  /** location.pathname（GitHub Pages のベースパス /ap-exam-textbook/ を含む） */
  path: string
  /** ページ名（例: 10_ネットワーク） */
  title: string
  /** 直近の見出しの id。ページ先頭に貼った場合は空文字 */
  headingId: string
  /** 見出しの文言。一覧に「どのあたりか」を出すために持つ */
  headingText: string
  updatedAt: number
  /**
   * 剥がした付箋の墓標。
   * ⚠️ 剥がすときにレコードごと消してはいけない。消すと「Macで剥がした付箋が、
   * まだ持っているiPadから次の同期で復活する」ため。削除も更新として同期する必要がある
   */
  deleted?: boolean
}

type SyncConfig = {
  /** Cloudflare Worker の URL。空なら同期しない（端末内だけで完結する） */
  url: string
  /** 合言葉。これが一致する端末どうしで付箋を共有する */
  key: string
}

/* ------------------------------------------------------------------ *
 * 保存・読み込み
 * ------------------------------------------------------------------ */

function isBookmark(value: unknown): value is Bookmark {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.path === "string" && typeof v.headingId === "string"
}

/**
 * 付箋を識別するパスを1つの表記に揃える。
 *
 * ⚠️ これが無いと端末間の同期が壊れる。このサイトのURLは日本語（/教科書/10_ネットワーク）で、
 * `location.pathname` は環境によって
 *   "/教科書/10_ネットワーク" と "/%E6%95%99%E7%A7%91%E6%9B%B8/10_..."
 * のどちらの表記でも返りうる。生のまま鍵に使うと、MacとiPadで同じページが
 * 別ページと判定され、同じ付箋が2件に増える（2026-08-04 実測で判明）。
 * 常にデコード形へ寄せて突き合わせる
 */
function canonicalizePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    // 不正なエスケープが混じっていてもそのまま扱う（落とさない）
    return path
  }
}

function load(): Bookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARK_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 古い記録や他端末由来のエンコード形も、読み込んだ時点で表記を揃える
    return parsed
      .filter(isBookmark)
      .map((b) => ({ ...b, path: canonicalizePath(b.path) }))
  } catch {
    // localStorage が使えない／壊れたJSONが入っていても、機能ごと落とさない
    return []
  }
}

function save(list: Bookmark[]) {
  try {
    // 古くなった墓標はここで捨てる。放っておくと剥がした付箋の記録が延々と溜まる
    const cutoff = Date.now() - TOMBSTONE_TTL_MS
    const kept = list.filter((b) => !b.deleted || b.updatedAt >= cutoff)
    localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // プライベートブラウジング等で書けないことがある。貼れないだけで閲覧は続行させる
  }
}

/** 画面に出す付箋。墓標（剥がした記録）は含めない */
function activeBookmarks(list: Bookmark[] = load()): Bookmark[] {
  return list.filter((b) => !b.deleted)
}

function currentPath(): string {
  return canonicalizePath(window.location.pathname)
}

function findCurrent(list: Bookmark[] = load()): Bookmark | undefined {
  const path = currentPath()
  return list.find((b) => b.path === path && !b.deleted)
}

/**
 * 2つの付箋リストを突き合わせる。同じページのものは updatedAt が新しい方を採る。
 * 削除も「deleted付きの更新」として扱うので、剥がした事実が新しければ剥がれたまま残る
 */
function mergeBookmarks(a: Bookmark[], b: Bookmark[]): Bookmark[] {
  const byPath = new Map<string, Bookmark>()
  for (const item of [...a, ...b]) {
    const existing = byPath.get(item.path)
    if (!existing || item.updatedAt > existing.updatedAt) byPath.set(item.path, item)
  }
  return [...byPath.values()]
}

/* ------------------------------------------------------------------ *
 * 端末間の同期（Cloudflare Worker）
 *
 * 設定していなければ何も起きず、従来どおり端末内だけで完結する。
 * 同期は「相手の分と突き合わせて（pull）、結果を送り返す（push）」の一往復で行う
 * ------------------------------------------------------------------ */

function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(BOOKMARK_SYNC_CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SyncConfig>
    if (typeof parsed.url !== "string" || typeof parsed.key !== "string") return null
    if (parsed.url === "" || parsed.key === "") return null
    return { url: parsed.url, key: parsed.key }
  } catch {
    return null
  }
}

function saveSyncConfig(config: SyncConfig | null) {
  try {
    if (config) localStorage.setItem(BOOKMARK_SYNC_CONFIG_KEY, JSON.stringify(config))
    else localStorage.removeItem(BOOKMARK_SYNC_CONFIG_KEY)
  } catch {
    // 書けなくても同期以外の機能は動かし続ける
  }
}

type SyncState = "idle" | "syncing" | "ok" | "error" | "off"
let syncState: SyncState = "off"
let syncMessage = ""
let syncTimer: number | undefined
let syncInFlight = false

function setSyncState(state: SyncState, message = "") {
  syncState = state
  syncMessage = message
  renderSyncStatus()
}

/**
 * 同期の本体。ローカルとリモートを突き合わせ、結果を双方に書き戻す。
 * 失敗しても例外は投げない（オフラインでも付箋を貼れること自体は保証する）
 */
async function syncNow(): Promise<void> {
  const config = loadSyncConfig()
  if (!config) {
    setSyncState("off")
    return
  }
  if (syncInFlight) return
  syncInFlight = true
  setSyncState("syncing")

  try {
    const endpoint = config.url.replace(/\/+$/, "")
    // ⚠️ 合言葉はURLエンコードしてから載せること。
    // HTTPヘッダーの値はByteString（0-255）しか許されず、日本語の合言葉をそのまま入れると
    // fetch が TypeError を投げて同期が丸ごと動かなくなる（2026-08-04 実測で判明）
    const headers = {
      "X-Sync-Key": encodeURIComponent(config.key),
      "Content-Type": "application/json",
    }

    const pulled = await fetch(endpoint, { method: "GET", headers })
    if (!pulled.ok) {
      const body = (await pulled.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `取得に失敗しました (${pulled.status})`)
    }
    const remote = (await pulled.json()) as { bookmarks?: unknown }
    const remoteList = Array.isArray(remote.bookmarks) ? remote.bookmarks.filter(isBookmark) : []

    const merged = mergeBookmarks(load(), remoteList)
    save(merged)

    const pushed = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ bookmarks: load() }),
    })
    if (!pushed.ok) {
      const body = (await pushed.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `送信に失敗しました (${pushed.status})`)
    }

    setSyncState("ok", `${activeBookmarks().length}件を同期`)
    refreshFabState()
    renderList()
  } catch (error) {
    const message = error instanceof Error ? error.message : "同期に失敗しました"
    setSyncState("error", message)
  } finally {
    syncInFlight = false
  }
}

/** 連続で付箋を操作したときに毎回通信しないよう、少し待ってからまとめて送る */
function scheduleSync(delayMs = 1200) {
  if (!loadSyncConfig()) return
  window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => void syncNow(), delayMs)
}

/* ------------------------------------------------------------------ *
 * いま読んでいる位置の判定
 * ------------------------------------------------------------------ */

/** 本文の見出しだけを拾う。用語サイドパネル内の見出しは `.center` の外なので混ざらない */
function articleHeadings(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".center > article :is(h1,h2,h3,h4)[id]")]
}

/** 見出しの文言。末尾のアンカー（🔗アイコン）を除いた純粋なテキストを返す */
function headingLabel(heading: HTMLElement): string {
  const clone = heading.cloneNode(true) as HTMLElement
  clone.querySelectorAll("a[role='anchor']").forEach((a) => a.remove())
  return clone.textContent?.trim() ?? ""
}

/** 画面上端より上にある最後の見出し ＝ 今読んでいる節 */
function headingAtViewport(): HTMLElement | null {
  let found: HTMLElement | null = null
  for (const heading of articleHeadings()) {
    if (heading.getBoundingClientRect().top <= HEADING_THRESHOLD_PX) {
      found = heading
    } else {
      break // 見出しは文書順に並んでいるので、1つ超えたら以降も全部下にある
    }
  }
  return found
}

function pageTitle(): string {
  const articleTitle = document.querySelector(".page-header h1")
  const text = articleTitle?.textContent?.trim()
  return text && text.length > 0 ? text : document.title
}

/* ------------------------------------------------------------------ *
 * 付箋を貼る／剥がす
 * ------------------------------------------------------------------ */

function toggleBookmark() {
  const list = load()
  const path = currentPath()
  const heading = headingAtViewport()
  const headingId = heading?.id ?? ""

  const existing = list.find((b) => b.path === path && !b.deleted)

  if (existing && existing.headingId === headingId) {
    // 同じ位置でもう一度押した ＝ 剥がす操作。
    // レコードは消さず墓標を残す（消すと他端末から次の同期で復活するため）
    save([...list.filter((b) => b.path !== path), { ...existing, deleted: true, updatedAt: Date.now() }])
    showToast("付箋を剥がしました")
  } else {
    const entry: Bookmark = {
      path,
      title: pageTitle(),
      headingId,
      headingText: heading ? headingLabel(heading) : "ページの先頭",
      updatedAt: Date.now(),
    }
    const next = list.filter((b) => b.path !== path)
    next.push(entry)
    save(next)
    showToast(existing ? "付箋の位置を更新しました" : "付箋を貼りました")
  }

  refreshFabState()
  renderList()
  removeBanner() // 貼った直後に「続きから読む」が出ていると噛み合わないため消す
  scheduleSync()
}

function removeBookmark(path: string) {
  const list = load()
  const existing = list.find((b) => b.path === path)
  if (!existing) return
  // ここも消さずに墓標を残す（toggleBookmark と同じ理由）
  save([...list.filter((b) => b.path !== path), { ...existing, deleted: true, updatedAt: Date.now() }])
  refreshFabState()
  renderList()
  scheduleSync()
}

/* ------------------------------------------------------------------ *
 * トースト（操作結果の一言表示）
 * ------------------------------------------------------------------ */

let toastTimer: number | undefined

function showToast(message: string) {
  let toast = document.getElementById(TOAST_ID)
  if (!toast) {
    toast = document.createElement("div")
    toast.id = TOAST_ID
    toast.setAttribute("role", "status")
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.classList.add("visible")

  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast?.classList.remove("visible"), 1800)
}

/* ------------------------------------------------------------------ *
 * 右下のボタン（付箋を貼る／一覧を開く）
 * ------------------------------------------------------------------ */

const ICON_BOOKMARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`
const ICON_LIST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>`

function ensureFab(): HTMLElement {
  const existing = document.getElementById(FAB_ID)
  if (existing) return existing

  const fab = document.createElement("div")
  fab.id = FAB_ID

  const listButton = document.createElement("button")
  listButton.type = "button"
  listButton.className = "bookmark-fab-button bookmark-fab-list"
  listButton.innerHTML = `${ICON_LIST}<span class="bookmark-count" aria-hidden="true"></span>`
  listButton.title = "付箋の一覧"
  listButton.setAttribute("aria-label", "付箋の一覧を開く")
  listButton.addEventListener("click", toggleList)

  const addButton = document.createElement("button")
  addButton.type = "button"
  addButton.className = "bookmark-fab-button bookmark-fab-add"
  addButton.innerHTML = ICON_BOOKMARK
  addButton.addEventListener("click", toggleBookmark)

  fab.appendChild(listButton)
  fab.appendChild(addButton)
  document.body.appendChild(fab)
  return fab
}

/** 現在ページに付箋があるか／総数をボタンに反映する */
function refreshFabState() {
  const fab = document.getElementById(FAB_ID)
  if (!fab) return

  const list = activeBookmarks()
  const current = findCurrent()

  const addButton = fab.querySelector(".bookmark-fab-add")
  if (addButton) {
    addButton.classList.toggle("active", current !== undefined)
    const label = current ? "付箋を剥がす／位置を更新する" : "ここに付箋を貼る"
    addButton.setAttribute("aria-label", label)
    ;(addButton as HTMLElement).title = label
  }

  const count = fab.querySelector(".bookmark-count")
  if (count) {
    count.textContent = list.length > 0 ? String(list.length) : ""
    count.classList.toggle("visible", list.length > 0)
  }
}

/* ------------------------------------------------------------------ *
 * 付箋一覧のパネル
 * ------------------------------------------------------------------ */

function formatWhen(timestamp: number): string {
  const diffMin = Math.floor((Date.now() - timestamp) / 60000)
  if (diffMin < 1) return "たった今"
  if (diffMin < 60) return `${diffMin}分前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}時間前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay === 1) return "昨日"
  if (diffDay < 7) return `${diffDay}日前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function ensureList(): HTMLElement {
  const existing = document.getElementById(LIST_ID)
  if (existing) return existing

  const overlay = document.createElement("div")
  overlay.id = OVERLAY_ID
  overlay.addEventListener("click", closeList)
  document.body.appendChild(overlay)

  const panel = document.createElement("aside")
  panel.id = LIST_ID
  panel.setAttribute("aria-label", "付箋の一覧")
  panel.innerHTML = `
    <div class="bookmark-list-header">
      <h2>付箋</h2>
      <button type="button" class="bookmark-list-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
    </div>
    <div class="bookmark-list-body"></div>
    <div class="bookmark-sync">
      <button type="button" class="bookmark-sync-toggle" aria-expanded="false">
        <span class="bookmark-sync-label">同期の設定</span>
        <span class="bookmark-sync-status"></span>
      </button>
      <div class="bookmark-sync-form" hidden>
        <p class="bookmark-sync-help">
          iPadとMacで同じ付箋を見るための設定です。両方の端末に同じURLと合言葉を入れてください。
          空のままなら、この端末の中だけで付箋を保存します。
        </p>
        <label class="bookmark-sync-field">
          <span>WorkerのURL</span>
          <input type="url" class="bookmark-sync-url" placeholder="https://ap-bookmarks-sync.xxx.workers.dev" autocomplete="off" spellcheck="false">
        </label>
        <label class="bookmark-sync-field">
          <span>同期キー（合言葉・12文字以上）</span>
          <input type="password" class="bookmark-sync-key" autocomplete="off" spellcheck="false">
        </label>
        <div class="bookmark-sync-actions">
          <button type="button" class="bookmark-sync-save">保存して同期</button>
          <button type="button" class="bookmark-sync-clear">解除</button>
        </div>
      </div>
    </div>
  `
  panel.querySelector(".bookmark-list-close")?.addEventListener("click", closeList)

  const syncToggle = panel.querySelector(".bookmark-sync-toggle") as HTMLButtonElement | null
  const syncForm = panel.querySelector(".bookmark-sync-form") as HTMLElement | null
  syncToggle?.addEventListener("click", () => {
    if (!syncForm) return
    const open = syncForm.hidden
    syncForm.hidden = !open
    syncToggle.setAttribute("aria-expanded", String(open))
  })

  const urlInput = panel.querySelector(".bookmark-sync-url") as HTMLInputElement | null
  const keyInput = panel.querySelector(".bookmark-sync-key") as HTMLInputElement | null
  fillSyncForm()

  panel.querySelector(".bookmark-sync-save")?.addEventListener("click", () => {
    const url = urlInput?.value.trim() ?? ""
    const key = keyInput?.value.trim() ?? ""
    if (url === "" || key === "") {
      setSyncState("error", "URLと合言葉の両方を入れてください")
      return
    }
    if (key.length < 12) {
      setSyncState("error", "合言葉は12文字以上にしてください")
      return
    }
    saveSyncConfig({ url, key })
    void syncNow()
  })

  panel.querySelector(".bookmark-sync-clear")?.addEventListener("click", () => {
    saveSyncConfig(null)
    if (urlInput) urlInput.value = ""
    if (keyInput) keyInput.value = ""
    setSyncState("off")
    showToast("同期を解除しました")
  })

  document.body.appendChild(panel)
  renderSyncStatus()
  return panel
}

/**
 * 保存済みの設定を入力欄へ書き戻す。
 * これが無いと、設定済みなのに欄が空に見えて「設定されていない」と誤解し、
 * 入れ直す事故につながる（合言葉を入れ直すと別の付箋置き場になってしまう）
 */
function fillSyncForm() {
  const config = loadSyncConfig()
  const urlInput = document.querySelector(".bookmark-sync-url") as HTMLInputElement | null
  const keyInput = document.querySelector(".bookmark-sync-key") as HTMLInputElement | null
  // 入力中の値を横から消さないよう、フォーカスされている欄には触らない
  if (urlInput && document.activeElement !== urlInput) urlInput.value = config?.url ?? ""
  if (keyInput && document.activeElement !== keyInput) keyInput.value = config?.key ?? ""
}

/** 同期の状態を一覧パネルの下部に表示する */
function renderSyncStatus() {
  const status = document.querySelector(".bookmark-sync-status")
  if (!status) return

  const labels: Record<SyncState, string> = {
    off: "この端末のみ",
    idle: "待機中",
    syncing: "同期中…",
    ok: syncMessage || "同期済み",
    error: `エラー: ${syncMessage}`,
  }
  status.textContent = labels[syncState]
  status.className = `bookmark-sync-status is-${syncState}`
}

function renderList() {
  const panel = document.getElementById(LIST_ID)
  const body = panel?.querySelector(".bookmark-list-body")
  if (!body) return

  const list = activeBookmarks().sort((a, b) => b.updatedAt - a.updatedAt)

  if (list.length === 0) {
    body.innerHTML = `<p class="bookmark-empty">まだ付箋がありません。<br>読んでいる位置で右下の 🔖 を押すと、ここに追加されます。</p>`
    return
  }

  body.replaceChildren(
    ...list.map((bookmark) => {
      const item = document.createElement("div")
      item.className = "bookmark-item"
      if (bookmark.path === currentPath()) item.classList.add("current")

      // ⚠️ class="internal" を付けないこと。付けると用語サイドパネルに横取りされる
      const link = document.createElement("a")
      link.className = "bookmark-item-link"
      link.href = bookmark.headingId ? `${bookmark.path}#${bookmark.headingId}` : bookmark.path
      link.innerHTML = `
        <span class="bookmark-item-title"></span>
        <span class="bookmark-item-heading"></span>
        <span class="bookmark-item-when"></span>
      `
      // 見出し名にMarkdown由来の記号が入りうるので、テキストは textContent で入れる
      const titleEl = link.querySelector(".bookmark-item-title")
      const headingEl = link.querySelector(".bookmark-item-heading")
      const whenEl = link.querySelector(".bookmark-item-when")
      if (titleEl) titleEl.textContent = bookmark.title
      if (headingEl) headingEl.textContent = bookmark.headingText
      if (whenEl) whenEl.textContent = formatWhen(bookmark.updatedAt)

      // 同じページ内の付箋はSPA遷移が起きず nav も飛ばないので、自前で閉じてスクロールする
      link.addEventListener("click", () => {
        closeList()
      })

      const remove = document.createElement("button")
      remove.type = "button"
      remove.className = "bookmark-item-remove"
      remove.textContent = "×"
      remove.title = "この付箋を剥がす"
      remove.setAttribute("aria-label", `${bookmark.title} の付箋を剥がす`)
      remove.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeBookmark(bookmark.path)
      })

      item.appendChild(link)
      item.appendChild(remove)
      return item
    }),
  )
}

function isListOpen(): boolean {
  return document.body.classList.contains(LIST_OPEN_CLASS)
}

function openList() {
  ensureList()
  renderList()
  fillSyncForm() // 開くたびに保存済みの設定を出し直す
  document.body.classList.add(LIST_OPEN_CLASS)
}

function closeList() {
  document.body.classList.remove(LIST_OPEN_CLASS)
}

function toggleList() {
  if (isListOpen()) closeList()
  else openList()
}

/* ------------------------------------------------------------------ *
 * 「前回の続きから読む」バナー
 * ------------------------------------------------------------------ */

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove()
}

/** そのページを今回のセッションで既に閉じたかどうか（閉じたバナーを出し直さない） */
const dismissedPaths = new Set<string>()

function renderBanner() {
  removeBanner()

  // 一覧から #見出しid 付きで飛んできた直後は、すでに続きの位置にいるので出さない
  if (window.location.hash !== "") return

  const bookmark = findCurrent()
  if (!bookmark) return
  if (dismissedPaths.has(bookmark.path)) return

  const center = document.querySelector(".center")
  if (!center) return

  const banner = document.createElement("div")
  banner.id = BANNER_ID

  const jump = document.createElement("button")
  jump.type = "button"
  jump.className = "bookmark-banner-jump"
  jump.innerHTML = `<span class="bookmark-banner-icon">${ICON_BOOKMARK}</span><span class="bookmark-banner-text"></span>`
  const textEl = jump.querySelector(".bookmark-banner-text")
  if (textEl) textEl.textContent = `前回の続き（${bookmark.headingText}）から読む`

  jump.addEventListener("click", () => {
    // ⚠️ 順番が重要。先にスクロールしてからバナーを消すと、
    // 見出しより上にあるバナーの高さ(約74px)ぶん本文が繰り上がり、
    // 目的の見出しが画面上端より上へ行き過ぎる（2026-08-04 CDP実測で確認）。
    // 消してレイアウトを確定させてから飛ぶ
    removeBanner()
    const target = bookmark.headingId ? document.getElementById(bookmark.headingId) : null
    if (target) target.scrollIntoView()
    else window.scrollTo({ top: 0 })
  })

  const dismiss = document.createElement("button")
  dismiss.type = "button"
  dismiss.className = "bookmark-banner-dismiss"
  dismiss.textContent = "×"
  dismiss.title = "閉じる"
  dismiss.setAttribute("aria-label", "続きから読む案内を閉じる")
  dismiss.addEventListener("click", () => {
    dismissedPaths.add(bookmark.path)
    removeBanner()
  })

  banner.appendChild(jump)
  banner.appendChild(dismiss)

  // パンくず・タイトル（.page-header）の下、本文の真上に出す。
  // .center の先頭に入れると画面最上端に貼り付き、下のパンくずと離れて浮いて見える
  const pageHeader = center.querySelector(".page-header")
  if (pageHeader) pageHeader.after(banner)
  else center.prepend(banner)
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && isListOpen()) {
    event.preventDefault()
    closeList()
  }
}

function setupBookmarks() {
  // SPA遷移では body ごと差し替わる。無ければ作り直し、一覧は閉じた状態から始める
  document.body.classList.remove(LIST_OPEN_CLASS)
  ensureFab()
  ensureList()
  refreshFabState()
  renderList()
  renderBanner()
  if (loadSyncConfig() && syncState === "off") setSyncState("idle")
}

// リスナーは document に一度だけ張る（nav のたびに増やさない）
if (!(window as unknown as { __bookmarkBound?: boolean }).__bookmarkBound) {
  ;(window as unknown as { __bookmarkBound?: boolean }).__bookmarkBound = true
  document.addEventListener("keydown", onKeydown)

  // 起動時に一度だけ相手側を取りに行く。以後はSPA遷移のたびには通信しない
  // （教科書内を行き来するだけで毎回リクエストすると無駄が大きいため）
  if (loadSyncConfig()) scheduleSync(600)

  // 別端末で貼った付箋を拾えるよう、タブに戻ってきたときにも同期する
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleSync(300)
  })
}

document.addEventListener("nav", setupBookmarks)
document.addEventListener("render", setupBookmarks)
