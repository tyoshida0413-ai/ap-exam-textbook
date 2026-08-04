# 付箋同期Worker（手動デプロイ手順）

iPad と Mac で付箋を共有するための、このサイト専用の小さなAPI。

**既存のCloudflareプロジェクトには一切触らない。** 新しいWorkerを1つと、新しいKV namespaceを1つ作るだけで、
他のアプリのデプロイ運用・設定は変更しない。

デプロイしなくても付箋機能自体は動く（その場合は端末ごとに別々の付箋になる）。

---

## A. ダッシュボードで作る場合（ターミナル不要・iPadからでも可）

1. **KVを作る**
   Cloudflareダッシュボード → **Storage & Databases → KV** → *Create a namespace*
   名前：`ap-bookmarks`

2. **Workerを作る**
   **Compute (Workers) → Create → Start from Hello World** → 名前を `ap-bookmarks-sync` にして *Deploy*

3. **コードを貼る**
   作成したWorkerの *Edit code* を開き、中身を全部消して `worker.js` の内容をそのまま貼り付け → *Deploy*

4. **KVを紐づける**
   Worker の **Settings → Bindings → Add → KV namespace**
   - Variable name: `BOOKMARKS`（この名前でないと動かない）
   - KV namespace: 手順1で作った `ap-bookmarks`
   → *Deploy*

5. **URLを控える**
   `https://ap-bookmarks-sync.<あなたのサブドメイン>.workers.dev` が払い出される。これをサイト側で使う。

---

## B. wrangler を使う場合

このディレクトリで実行する（他プロジェクトのwrangler設定とは独立している）。

```bash
npx wrangler kv namespace create BOOKMARKS   # 出力された id を wrangler.toml に貼る
npx wrangler deploy
```

---

## サイト側の設定（各端末で1回だけ）

1. サイトを開き、右下の一覧ボタン（≡）→ パネル下部の **「同期の設定」** を開く
2. **WorkerのURL** … 上で払い出されたURL
3. **同期キー（合言葉）** … 自分で決めた12文字以上の文字列
4. 保存すると、以後は付箋を貼った時点で自動的に反映される

**iPadにも同じURLと同じ合言葉を入れる。** これで2台が同じ付箋を共有する。

---

## 設計上の注意

- 合言葉は**サーバーに保存されない**。SHA-256でハッシュ化した値をKVのキーに使っている
- 合言葉を知っている人は誰でもその付箋を読み書きできる。**推測されにくい文字列にすること**
- 公開HTMLには認証情報を埋め込まない。合言葉は各端末のlocalStorageにだけ残る
- `ALLOWED_ORIGINS`（worker.js 冒頭）で、このサイト以外のオリジンからの利用を拒否している。
  サイトのURLを変えたらここも直す
- 片方の端末で剥がした付箋は「墓標（`deleted: true`）」として同期される。
  こうしないと、もう片方に残っていた付箋が次の同期で復活してしまう
