# slack-agent-base

Slack で話しかけると答える，いちばん小さな AI エージェント．
道具は `now`（今の日時）と `calc`（計算）の 2 つ．Cloudflare の無料プランだけで動く（カード登録不要）．

| ファイル | 役割 |
|---|---|
| `src/brain.ts` | 指示書と，モデルに道具を渡して考えさせる部分．**まずここを書き換える** |
| `src/tools.ts` | 道具の定義．**道具を足すのはここ** |
| `src/index.ts` | Slack からの受け口とエージェント本体 |
| `wrangler.jsonc` | Cloudflare の設定（モデル名はここ） |

## 1. 準備

- Git
- Node.js 18 以上
- Cloudflare アカウント（無料）: https://dash.cloudflare.com/sign-up/workers-and-pages
- 練習用の Slack ワークスペース

```bash
git clone https://github.com/RevoltJapan/slack-agent-base.git
cd slack-agent-base
npm install
npx wrangler login
```

## 2. Slack アプリを作る

1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. **OAuth & Permissions** → Bot Token Scopes に `chat:write` `app_mentions:read` `im:history` `channels:history`
3. 同じページの **Install to Workspace** → Allow → **Bot User OAuth Token**（`xoxb-…`）を控える
4. **Basic Information** → **Signing Secret** を控える
5. **App Home** → Show Tabs → **Messages Tab** を ON，「Allow users to send … messages from the messages tab」に✓
6. **Agents** → ON
7. **Settings → Socket Mode** が ON になっていたら **OFF**

## 3. デプロイ

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npm run deploy
```

出てきた URL（`https://slack-agent-base.<自分の名前>.workers.dev`）を控える．

## 4. Slack とつなぐ

1. Slack アプリ設定 → **Event Subscriptions** → Enable Events を ON
2. Request URL に `https://slack-agent-base.<自分の名前>.workers.dev/slack` → **Verified**
3. Subscribe to bot events に `app_mention` と `message.im` → **Save Changes**
4. 再インストールを求められたら従う

## 5. 話す

- アプリに DM：「来週の金曜は何日？」「1234 × 5678 は？」「締切まであと何日？」
- チャンネルに招待して `@アプリ名 …`