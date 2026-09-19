# DEPLOY — Slack につないで動かす

Claude Code に読ませて進めるための手順書．`SETUP.md` が終わっている前提．
ブラウザの操作は受講者が行い，コマンドは Claude Code が実行する．

## Claude Code への約束

- 上から順に進める．受講者の作業が終わったことを確かめてから次へ進む．
- **トークンとシークレットを会話に貼らせない．** `wrangler secret put` は受講者自身に実行してもらう．
- 受講者に貼らせるものは，**そのまま貼れる完成形**を画面に出す．URL を組み立てさせない．
- 失敗したら別の方法を勝手に試さない．エラー全文と，受講者がすべきことを1つ示して止まる．
- 最後に「確認結果」の表を必ず出す．

## 1. Slack アプリを作る（受講者）

`slack-app-manifest.json` の中身をそのまま画面に出してから，次を案内する．

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. 練習用ワークスペースを選ぶ
3. **JSON** タブに切り替えて貼り付ける → Next → Create

アプリ名を変えたい場合は `display_information.name` と `features.bot_user.display_name` を書き換えてよいと伝える．

## 2. Agents を ON にする（受講者）

左メニューの **Agents** を ON にする．マニフェストでは設定できないので，ここだけ手作業．

## 3. インストールしてトークンを控える（受講者）

1. **OAuth & Permissions** → **Install to Workspace** → Allow
2. **Bot User OAuth Token**（`xoxb-` で始まる）を控える
3. **Basic Information** → **Signing Secret** を控える

## 4. シークレットを預ける（受講者が自分で実行）

次の2つは受講者自身にターミナルで実行してもらう．Claude Code が代わりに実行しない．

```
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
```

終わったら `npx wrangler secret list` を実行し，2つとも登録されていることを確認する（値は表示されない）．

## 5. デプロイする

`npm run deploy` を実行し，出力の `https://….workers.dev` を控える．

## 6. Slack とつなぐ（受講者）

控えた URL の末尾に `/slack` を付けたものを，**そのまま貼れる形で**画面に出してから案内する．

1. **Event Subscriptions** → Enable Events を ON
2. **Request URL** に貼る → **Verified** と出る
3. **Subscribe to bot events** に `app_mention` と `message.im` を追加 → **Save Changes**
4. 再インストールを求められたら従う

## 7. 確かめる

- `npx wrangler deployments list` に直近のデプロイがあること
- `curl -s <控えた URL>` が `slack-agent-base` を返すこと
- 受講者にアプリへ DM で「1234 × 5678 は？」と送ってもらい，スレッドに返事が来ること

## 確認結果

最後にこの表をそのまま出力する．できていない行は ❌ と，次にすべきことを1行で書く．

| 項目 | 結果 |
|---|---|
| Slack アプリ | |
| Agents | |
| シークレット2つ | |
| デプロイ | |
| Request URL | |
| DM の返事 | |

すべて ✅ なら，次の URL を**そのまま貼れる形で**画面に出し，「Cloudflare のダッシュボードの エージェント でトレースを見てみましょう」と案内して終わる．

```
https://dash.cloudflare.com/?to=/:account/agents
```

`:account` は書き換えない．ダッシュボードがログイン中のアカウントに自動で読み替える．
