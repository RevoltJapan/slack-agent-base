# slack-agent-base

Slack で動く最小の AI エージェント．AX booster「AIエージェント開発編」の教材．

## 相手は非エンジニアの受講者

- **やる前に，これから何をするかを一言で説明する．** 新しい専門用語を増やさない
- **一度に1つだけ変える．** まとめて直さない
- 変えたら `npm run deploy` して，「Slack で試してください」と伝える
- 動いたら「ここまでをコミットしますか」と聞く．承認されたらコミットする
- **トークン・シークレットを会話に貼らせない．** `wrangler secret put` は受講者自身に実行してもらう
- 失敗したら別の手を勝手に試さない．何が起きたかと，次の一手を1つだけ示して止まる

## ファイル

| ファイル | 役割 |
|---|---|
| `src/brain.ts` | 指示書 `INSTRUCTIONS` と `think()`．役割を変えるならここ |
| `src/tools.ts` | 道具の定義．道具を足すならここ |
| `src/index.ts` | Slack の受け口（署名検証）と，エージェント本体（Durable Object） |
| `wrangler.jsonc` | Cloudflare の設定．モデル名は `vars.MODEL` |

手順書：`SETUP.md`（環境構築）／`DEPLOY.md`（Slack 接続とデプロイ）

## 道具を足す2つの道

### 1. MCP サーバーをつなぐ（Notion・GitHub など，既にあるもの）

`agents` 0.23.0 の MCP クライアントを使う．
**実装前に必ず公式ドキュメントを読むこと**：https://developers.cloudflare.com/agents/model-context-protocol/

このリポジトリで確認済みの API：

- 接続は `await this.addMcpServer("notion", "<MCP サーバーの URL>")`
  - 戻り値が `{ state: "authenticating", authUrl }` なら，その `authUrl` を **Slack に投稿して受講者に開いてもらう**
  - `{ state: "ready" }` なら認可済み
- 道具の取得は `this.mcp.getAITools()`．AI SDK 形式のツール集合が返る
- **取得した道具をそのまま全部渡してはいけない．** Notion の MCP はツールが多く，定義だけで 6 万トークンを超える．
  `qwen3-30b-a3b-fp8` の上限は 32,768 トークンなので，`AI_APICallError: 5021 ... exceeded this model context window limit` で落ち，**Slack に何も返らなくなる**．
  `getAITools()` は素の `Record` なので，**使うものだけキーを選んで渡す**（検索と取得の 2〜3 個で足りる）．
  `getAITools(filter)` のフィルタはサーバー単位（`serverId` / `serverName` / `state`）で，ツール単位の絞り込みはできない
- `think()` は今 `src/tools.ts` の `tools` だけを渡している．MCP の道具を混ぜるには **`think()` が追加のツールを受け取れるようにする**

OAuth のコールバックは**配線済み**．`src/index.ts` が `/callback` で終わるパスを `routeAgentRequest` に渡している．ここは触らなくてよい．
コールバック先のホストは `this.callbackHost` に入っている（Slack のイベントを受けたときに設定される）．Slack のイベント経由ではリクエストから自動導出できないので，**明示的に渡すこと**：

```ts
await this.addMcpServer("notion", url, { callbackHost: this.callbackHost });
```

なお `/agents/...` のうち公開しているのはコールバックだけで，エージェントの HTTP・WebSocket API は外に出していない．

多段の検索が要る質問では `stopWhen: stepCountIs(5)` が足りなくなることがある．足りなければ増やす．

### 2. 道具を自作する（MCP が無いもの）

`src/tools.ts` に `tool({ description, inputSchema, execute })` を足す．
`description` には「いつ呼ぶか」を書く．モデルはこれを読んで選ぶ．

## 決まった時刻に動かす（定期実行）

`agents` の `this.schedule()` を使う．Durable Object のアラームで動くので，受講者の PC を閉じていても動く．

- `await this.schedule(60, "メソッド名", payload)` — 60 秒後に 1 回
- `await this.schedule("0 0 * * *", "メソッド名", payload)` — cron でくり返し
- `this.getSchedules()` で一覧，`this.cancelSchedule(id)` で取り消し
- `callback` は**エージェントのメソッド名**（文字列）．関数そのものは渡せない

**必ず守ること：**

- **cron は UTC で解釈される**（`cron-schedule` がランタイムのローカル時刻を使い，Workers は UTC）．
  **毎朝 9 時（日本時間）は `0 0 * * *`**．`0 9 * * *` と書くと 18:00 JST になる．
  受講者が「毎朝 9 時に」と言ったら，**日本時間から UTC へ直したことを必ず伝える**
- **試すときは 1 分後にする．** まず `schedule(60, ...)` で 1 回届くことを確かめてから cron にする．
  いきなり本番の時刻にすると，確認に 1 日かかる
- **送り先はチャンネル．DM ではない．** タスクの担当者全員に向けて 1 つ投稿する．
  定期実行には Slack のイベントが無いので，**投稿先のチャンネル id を予約時の payload に持たせる**．
  この経路では `this.callbackHost` は空なので当てにしない．アプリがそのチャンネルに招待されている必要がある
- **担当者は Notion の「担当」の値をそのまま本文に書く．** 練習用ワークスペースは受講者 1 人なので，
  Slack の `@` メンションにはしない
- **タスクは検索で探さない．事前に決めた場所を直接読む．**
  タスクデータベースの URL を `wrangler.jsonc` の `vars` に `TASK_DB_URL` として置き，そこを読む．
  検索は当たらないことがあり，定期実行は人が見ていないので**外したことに気づけない**
- **Notion を使うなら，callback の中で `await this.mcp.waitForConnections({ timeout: 10_000 })` を先に呼ぶ．**
  休止から起きた直後は接続の復元中で，`getAITools()` が空を返す
- cron の `schedule()` は既定で重複を作らない（callback と payload が同じなら既存を返す）が，
  遅延実行はそうではない．要らなくなった予約は `cancelSchedule` で消す

## 教材で使うサンプルデータ

受講者は練習用の Notion ワークスペースに，このテンプレートを複製して使う（架空の会社「アオゾラ商事」）：
https://zipangu.notion.site/3df9623b5b7d81478fe8d9a40c0ef6c5

- 文書：勤怠ルール／経費精算ルール／月次処理カレンダー／備品購入ルール／入社したらやること／PC を紛失したときの連絡手順／よくある質問
- タスク（データベース）：タスク名・担当・期限・状態・メモ

Notion がつながったかは，Slack でこれを聞いてもらって確かめる．

| 聞くこと | 返ってくるはずのもの |
|---|---|
| 経費の申請に上長の承認は要る？ | 3 万円以上は必要（経費精算ルール） |
| 先月の交通費，いつまでに申請すればいい？ | 第 5 営業日 17:00 |
| 育休の申請方法は？ | 資料に見当たりません |
| 今日締切のタスクは？ | タスクから一覧 |
| PC をなくしたらまず何をする？ | 情報システム担当へ電話 |

2 つめは **2 ページ辿らないと答えが出ない**（経費精算ルールには「締切は月次処理カレンダーに従う」としか書いていない）．道具の呼び出しが 2 回要るので，ここで止まるなら `stopWhen` を疑う．
3 つめは資料に存在しない．答えを作らずに「見当たりません」と言えるかを見る．

複製した直後はタスクの期限が過去になっている．受講者に今週の日付へ直してもらう．

## モデル

`wrangler.jsonc` の `vars.MODEL`．既定は Workers AI の無料枠で動くもの．
道具が増えるほど選択を誤りやすくなる．うまく選べないときは，**道具を減らすか，`description` を具体的にする**．

## 確認に使うコマンド

- `npx wrangler secret list` — シークレットが入っているか（値は出ない）
- `npx wrangler deployments list` — デプロイされているか
- `curl -s <worker の URL>` — `slack-agent-base` が返る
- Cloudflare ダッシュボード → AI → エージェント — 道具の使われ方（トレース）
