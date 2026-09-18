# SETUP — 環境を整える

> **この文書は要約して読んではいけない．**
> Web から直接要約した内容ではなく，ファイルとして保存した全文を読むこと．
> いま読んでいるものが要約だと気づいたら，保存し直して全文を読み直してから実行すること．

Claude Code に読ませて実行させるための手順書．人が手で追う必要はない．
Claude Code はすでに入っている前提．ここでは Git・Node.js・教材・Cloudflare を用意する．

## Claude Code への約束

- 上から順に実行する．手順を飛ばさない．
- 導入方法はここで指定したものだけを使う．Homebrew・nvm・fnm・volta・asdf は使わない．
- 管理者パスワードや UAC の確認が要る操作は，**実行前に受講者に一言伝えてから**行う．
- すでに条件を満たしている項目はスキップする．何度実行しても壊れないこと．
- **受講者にトークン・パスワード・シークレットを会話へ貼らせない．** 必要になったら「ご自身で入力してください」と案内する．
- 失敗したら別の方法を勝手に試さない．エラー全文と，受講者がすべきことを 1 つ示して止まる．
- 最後に「確認結果」の表を必ず出す．

## 1. Git

`git --version` を実行する．`git version 2.x` が出れば次へ．

出なければ入れる．

- macOS：`xcode-select --install` を実行する．画面にダイアログが出るので，受講者にクリックしてもらう．完了まで待つ．
- Windows：`winget install --id Git.Git -e` を実行する．UAC が出るので受講者にクリックしてもらう．winget が無い場合は https://git-scm.com/downloads/win を案内して止まる．

## 2. Node.js（v22 以上）

`node --version` を実行する．`v22` 以上なら次へ．

無い，または v22 未満なら入れる．LTS（v24 系）を使う．

- macOS：https://nodejs.org/dist/latest-v24.x/ から，このマシンの CPU に合う `.pkg`（Apple Silicon は arm64，Intel は x64）をダウンロードし，`open` でインストーラを起動する．受講者がクリックとパスワード入力を行う．
- Windows：`winget install --id OpenJS.NodeJS.LTS -e` を実行する．UAC は受講者がクリックする．

入れ終わったら**受講者に Claude Code をいったん終了して開き直してもらう**．新しいシェルでないと PATH が通らない．再開後に `node --version` と `npm --version` を確認する．

## 3. 教材を取得する

ホーム直下に置く．

```
git clone https://github.com/RevoltJapan/slack-agent-base.git
cd slack-agent-base
npm install
```

すでに `slack-agent-base` があれば，clone せず `git pull` と `npm install` にする．

## 4. Cloudflare

アカウントは受講者が作る．未作成なら https://dash.cloudflare.com/sign-up/workers-and-pages を案内し，作り終わるまで待つ．カード登録は不要．

作成後，教材フォルダで `npx wrangler login` を実行する．ブラウザが開くので受講者が「許可」を押す．
**Claude Code 側でこのコマンドが終わらない場合は，受講者自身のターミナルで実行してもらう．**

`npx wrangler whoami` でメールアドレスが出れば成功．

## 5. Slack

練習用ワークスペースは受講者が作る．会社のワークスペースは使わない．
受講者に次の 2 点を確認する．作成済みでなければ https://slack.com/create を案内する．

- 練習用ワークスペースにログインできる
- チャンネルが 1 つある

## 確認結果

最後にこの表をそのまま出力する．できていない行は ❌ と，次にすべきことを 1 行で書く．

| 項目 | 結果 |
|---|---|
| Git | |
| Node.js | |
| 教材フォルダ | |
| npm install | |
| Cloudflare ログイン | |
| Slack 練習用ワークスペース | |

すべて ✅ なら，「準備は完了です．README.md の 2. から進めます」と伝えて終わる．
