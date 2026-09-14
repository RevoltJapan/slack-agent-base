# slack-agent-base

Slack で話しかけると答える，いちばん小さな AI エージェントのベースです．
道具（ツール）は `now`（今の日時）と `calc`（計算・日付の足し引き）の 2 つだけ．
外部 API・API キー・MCP は使いません．Cloudflare の無料プランだけで動きます．

出典（公式の 2 つの例を組み合わせたもの）
- Slack agent: https://developers.cloudflare.com/agents/examples/slack-agent/
- Chat agent（道具の書き方）: https://developers.cloudflare.com/agents/examples/chat-agent/

## 中身

| ファイル | 役割 | 受講者が編集するか |
|---|---|---|
| `src/tools.ts` | 道具の定義（now / calc） | **する**．道具を足すのはここ |
| `src/brain.ts` | 指示書 `INSTRUCTIONS` と，モデルを呼んで道具を回す `think()` | **する**．指示書を書き換える |
| `src/index.ts` | Slack から来た出来事を `think()` に渡して返す．テスト用 `/ask` もここ | あまりしない |
| `src/slack.ts` | Slack との接続（署名検証・OAuth・イベント振り分け）．公式例の複製 | しない |
| `wrangler.jsonc` | Cloudflare の設定．モデル名・タイムゾーン・手順表示の ON/OFF | 設定を変えるとき |

しくみ：Slack → Worker（窓口，`/slack`）→ Durable Object `MyAgent`（エージェント本体）→ `think()` がモデルに指示書＋履歴＋道具を渡す → モデルが道具を選んで呼ぶ（最大 6 往復）→ 答えを Slack に投稿．
`SHOW_STEPS` が `"true"` のとき，答えの下に「🔧 手順」として使った道具と引数・結果が付きます．

## 準備（1 回だけ）

1. Cloudflare アカウント（無料．カード不要）https://dash.cloudflare.com/sign-up/workers-and-pages
2. Node.js 18 以上
3. このフォルダで

```bash
npm install
npx wrangler login
```

## テスト 1：Slack なしで「頭」だけ動かす（まずこれ）

```bash
npm run dev
```

別のターミナルで（`jq` が無ければ末尾の `| jq` を外す）

```bash
curl -s "http://localhost:8787/ask?q=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("今日は何曜日？"))')" | jq
```

`answer` に答え，`steps` に「どの道具を，どの引数で呼び，何が返ったか」が入ります．
Workers AI はローカル実行でも Cloudflare 側で推論するので，ログイン済みであること・無料枠（1 日 10,000 Neurons）を使うことに注意．

### 試す質問と，見るべきところ

| 質問 | 期待する手順 | 何を確かめるか |
|---|---|---|
| 今日は何曜日？ | `now` → 答え | 推測せず道具を呼ぶこと |
| 1234 × 5678 は？ | `calc` → 答え（7006652） | 暗算せず道具を呼ぶこと |
| 来週の金曜は何日？ | `now` → `calc(add_days(...))` → 答え | **順番を自分で組む**（今日を知らないと計算できない） |
| 9 月 30 日まであと何日？ | `now` → `calc(days_between(...))` → 答え | 同上．年の補完も見る |
| 1 個 1,280 円を 7 個，1 割引きのあと税 10% を足すと？ | `calc` を 1〜3 回 → 答え（8,870.4 円）  | 結果を見て次の式を立てる（多段の計算） |
| 3 人で割り勘，1 人だけ 2,000 円多く出す．合計 15,000 円なら？ | 正解は 7,000 と 4,000×2．**モデルが式を立て間違えることがある** | 道具があっても「式を立てる」のは判断で，そこがモデルの限界だと分かる |
| 締切まであと何日？（締切を言っていない） | 道具を呼ばず聞き返す | **聞き返す判断** |
| 東京の明日の天気は？ | 道具が無いので「分かりません」＋何があれば答えられるか | できないことを正直に言う |

同じ質問を 2〜3 回投げると，道具の呼び方（引数や回数）が毎回少し変わります．それが「手順が固定されていない＝モデルが分岐を決めている」ことの目に見える証拠です．

## テスト 2：Slack につなぐ

### Slack アプリを作る
1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. **OAuth & Permissions** → Bot Token Scopes に `chat:write` `chat:write.public` `channels:history` `app_mentions:read` `im:write` `im:history`
3. **Basic Information** → App Credentials の **Client ID / Client Secret / Signing Secret** を控える
4. **App Home** → Show Tabs → **Messages Tab** を ON，「Allow users to send Slash commands and messages from the messages tab」に✓（DM を受けるため）

### 秘密を置く
```bash
cp .dev.vars.example .dev.vars
```
`.dev.vars` に 3 つの値を書く．

### ローカルを外から見えるようにする
```bash
npm run dev
```
別ターミナルで
```bash
npx cloudflared tunnel --url http://localhost:8787
```
出てきた `https://xxxx.trycloudflare.com` を控える．

### Slack にイベントの届け先を教える
1. Slack アプリ設定 → **Event Subscriptions** → Enable Events を ON
2. Request URL に `https://xxxx.trycloudflare.com/slack` → **Verified** と出れば OK
3. Subscribe to bot events に `app_mention` と `message.im` → Save
4. ブラウザで `https://xxxx.trycloudflare.com/install` を開き，ワークスペースに **Allow** →「Successfully registered!」

### 話しかける
- アプリに DM：「来週の金曜は何日？」
- チャンネルで `@アプリ名 9月30日まであと何日？` → スレッドに返る

答えの下に「🔧 手順」が付きます．消すときは `wrangler.jsonc` の `SHOW_STEPS` を `"false"`．

トンネルの URL は起動ごとに変わるので，`cloudflared` を再起動したら Request URL も直す．

## テスト 3：本番に置く

```bash
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SLACK_SIGNING_SECRET
npm run deploy
```
出てきた `https://slack-agent-base.<自分のサブドメイン>.workers.dev` で，Request URL を `.../slack` に直し，`.../install` をもう一度開く．
公開後は `/ask` を閉じたければ `ASK_ENABLED` を `"false"` にして再デプロイ．

## つまずいたとき

- **Verified にならない**：`.dev.vars` の Signing Secret が違う／`npm run dev` が落ちている／URL の末尾が `/slack` でない
- **返事が来ない**：`npm run dev` のターミナルにエラーが出ていないか見る．`/ask` で頭だけ試して切り分ける
- **返事が 2 回来る**：Slack の再送．`src/slack.ts` が再送ヘッダを無視するので通常は起きない．起きたらモデルの応答が極端に遅い
- **Durable Object のデプロイに失敗**：`migrations` が `new_sqlite_classes` になっているか（Free プランは SQLite 必須）
- **モデルを変えたい**：`wrangler.jsonc` の `MODEL`．無料枠で関数呼び出しできる候補は `@cf/qwen/qwen3-30b-a3b-fp8`（既定）`@cf/zai-org/glm-4.7-flash` `@cf/openai/gpt-oss-20b`．
  2026-09-14 の手元比較（3 問×3 回，日本語）では qwen3-30b が 9/9，glm-4.7-flash が 5/9，gpt-oss-20b が 4/9 だった．小さいモデルは「道具を呼んだあと最後の文を書かない」ことがあり，`src/brain.ts` が 1 回だけ自動でやり直す

## 次の一歩（このベースを育てる）

1. `src/brain.ts` の指示書を，自分の会社の言葉に書き換える
2. `src/tools.ts` に道具を 1 つ足す（例：会社の休日表を返す `holidays`）
3. 別のチャンネルで聞くと前の話を知らないことを確かめてから，記憶の道具（覚える／思い出す）を足す
