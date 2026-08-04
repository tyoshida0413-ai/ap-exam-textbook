/**
 * 応用情報サイトの「付箋（しおり）」を端末間で同期するための Cloudflare Worker。
 *
 * iPad と Mac で同じ付箋を見るための最小のAPI。付箋のJSONを KV に置くだけで、
 * ログインもアカウントも持たない。持ち主の判別は「合言葉（同期キー）」だけで行う。
 *
 * 【設計の要点】
 * - 合言葉そのものは保存しない。SHA-256 でハッシュ化した値を KV のキーにする。
 *   KV の中身が漏れても、そこから合言葉は復元できない
 * - 認証情報を公開HTMLに埋め込まない。合言葉は利用者が各端末で1回入力し、
 *   その端末の localStorage にだけ残る
 * - CORS は許可オリジンを明示（誰のサイトからでも叩ける状態にしない）
 *
 * 【エンドポイント】
 *   GET  /   ヘッダ X-Sync-Key: <合言葉>            → 保存されている付箋を返す
 *   PUT  /   ヘッダ X-Sync-Key: <合言葉> + JSON本文 → 付箋を保存する
 */

// このサイト以外から叩かれないようにする。ローカル確認用のポートも許可しておく
const ALLOWED_ORIGINS = [
  "https://tyoshida0413-ai.github.io",
  "http://localhost:8099",
  "http://localhost:8080",
]

// 合言葉が短すぎると総当たりで開けてしまうため下限を設ける
const MIN_KEY_LENGTH = 12

// 1件あたりの上限。壊れたデータや悪意のある巨大POSTでKVを圧迫させない
const MAX_BODY_BYTES = 512 * 1024
const MAX_BOOKMARKS = 2000

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  })
}

/** 合言葉 → KVキー。生の合言葉は保存も記録もしない */
async function keyToId(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ap-bookmarks:${key}`))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** 受け取ったデータが付箋の形をしているかを検査する */
function sanitize(payload) {
  if (typeof payload !== "object" || payload === null) return null
  const list = payload.bookmarks
  if (!Array.isArray(list) || list.length > MAX_BOOKMARKS) return null

  const cleaned = []
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue
    if (typeof item.path !== "string" || item.path.length > 512) continue
    cleaned.push({
      path: item.path,
      title: String(item.title ?? "").slice(0, 300),
      headingId: String(item.headingId ?? "").slice(0, 300),
      headingText: String(item.headingText ?? "").slice(0, 300),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      // 削除は「消す」のではなく墓標を残す。そうしないと、片方で消した付箋が
      // もう片方の端末に残っていて、次の同期で復活してしまう
      deleted: item.deleted === true,
    })
  }
  return { bookmarks: cleaned, updatedAt: Date.now() }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? ""
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) })
    }

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "このオリジンからは利用できません" }, 403, allowed)
    }

    // 合言葉はURLエンコードされて届く。
    // HTTPヘッダーはASCIIしか運べないため、日本語の合言葉を使えるようにクライアント側で
    // encodeURIComponent してある（そのまま送るとブラウザのfetchが例外を投げる）
    let syncKey = ""
    try {
      syncKey = decodeURIComponent(request.headers.get("X-Sync-Key") ?? "")
    } catch {
      return json({ error: "同期キーの形式が不正です" }, 400, allowed)
    }

    if (syncKey.length < MIN_KEY_LENGTH) {
      return json({ error: `同期キーは${MIN_KEY_LENGTH}文字以上にしてください` }, 401, allowed)
    }

    const id = await keyToId(syncKey)

    if (request.method === "GET") {
      const stored = await env.BOOKMARKS.get(`b:${id}`)
      return json(stored ? JSON.parse(stored) : { bookmarks: [], updatedAt: 0 }, 200, allowed)
    }

    if (request.method === "PUT") {
      const raw = await request.text()
      if (raw.length > MAX_BODY_BYTES) {
        return json({ error: "データが大きすぎます" }, 413, allowed)
      }

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return json({ error: "JSONとして読めません" }, 400, allowed)
      }

      const clean = sanitize(parsed)
      if (!clean) return json({ error: "付箋データの形式が不正です" }, 400, allowed)

      await env.BOOKMARKS.put(`b:${id}`, JSON.stringify(clean))
      return json({ ok: true, count: clean.bookmarks.length, updatedAt: clean.updatedAt }, 200, allowed)
    }

    return json({ error: "対応していないメソッドです" }, 405, allowed)
  },
}
