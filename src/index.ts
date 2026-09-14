import { env } from "cloudflare:workers";
import type { ModelMessage } from "ai";
import { SlackAgent } from "./slack";
import { think, formatSteps } from "./brain";

type SlackMsg = {
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
};

/** Slack の履歴をモデル向けの user / assistant 列に直す */
function normalizeForLLM(msgs: SlackMsg[], selfUserId: string): ModelMessage[] {
  return msgs
    .filter((m) => (m.text ?? "").trim() !== "")
    .map((m) => ({
      role: m.user && m.user !== selfUserId ? ("user" as const) : ("assistant" as const),
      content: (m.text ?? "").replace(/<@([A-Z0-9]+)>/g, "@$1")
    }));
}

/** Markdown の太字を Slack の記法に寄せる（最小限） */
function toSlack(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#{1,3}\s+/gm, "");
}

export class MyAgent extends SlackAgent {
  /**
   * Slack の「考え中」表示（Agents 機能を ON にしたアプリで有効）．
   * 新 API agents.sessions.setStatus を使い，使えない場合は旧 API assistant.threads.setStatus に落とす．
   * 失敗しても返事はするので，結果はログに出すだけ．
   */
  async setThinking(channel: string, threadTs: string, on: boolean): Promise<"agents" | "legacy" | "none"> {
    const token = this.token;
    if (!token) return "none";
    const call = async (method: string, body: Record<string, unknown>) => {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return (await res.json()) as { ok: boolean; error?: string };
    };
    // 新 API: processing で読み込み表示，active で解除
    let r = await call("agents.sessions.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status: on ? "processing" : "active"
    });
    if (r.ok) {
      console.log(`[slack] agents.sessions.setStatus(${on ? "processing" : "active"}): ok`);
      return "agents";
    }
    const firstError = r.error;
    // 旧 API: 文字列を入れると表示，空文字で解除（返事を投稿すると自動で消える）
    r = await call("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status: on ? "考えています…" : ""
    });
    console.log(
      `[slack] setStatus(${on ? "processing" : "active"}):`,
      r.ok ? "ok (legacy)" : `error=${firstError} / legacy error=${r.error}`
    );
    return r.ok ? "legacy" : "none";
  }

  async generateAIReply(conversation: SlackMsg[], conversationId: string) {
    const selfId = await this.ensureAppUserId();
    // 直近 30 件だけ渡す（履歴は Slack 側にあるので，ここでは保存しない）
    const messages = normalizeForLLM(conversation.slice(-30), selfId);
    // this.name は Durable Object の名前＝Slack の team_id
    const { text, steps } = await think(env, messages, { agentId: `slack:${this.name}`, conversationId });
    const footer = env.SHOW_STEPS === "true" ? formatSteps(steps) : "";
    return [toSlack(text), footer].filter(Boolean).join("\n\n");
  }

  async onSlackEvent(event: { type: string } & Record<string, unknown>) {
    // ボット自身の発言や編集・参加通知などは無視
    if (event.bot_id || event.subtype) return;

    const e = event as unknown as SlackMsg & { channel: string };
    const isDM = (e.channel || "").startsWith("D");
    const isMention = event.type === "app_mention";
    if (event.type !== "message" && !isMention) return;
    if (event.type === "message" && !isDM) return; // チャンネルの通常メッセージは app_mention 側で受ける

    // 返す場所:
    //  - チャンネルのメンション → そのスレッド
    //  - DM（Agents 機能 ON）→ 会話は 1 メッセージ 1 スレッドなので，届いたメッセージのスレッドに返す
    //    （最初のメッセージは thread_ts を持たない＝そのメッセージ自身がスレッドの根．
    //      Agents 機能が ON かどうかは，状態 API が成功したかで判定する）
    //  - DM（Agents 機能 OFF）→ スレッドではなく普通に返す
    const threadTs = e.thread_ts || e.ts;
    const mode = await this.setThinking(e.channel, threadTs, true);
    const agentsMode = mode !== "none";
    const replyThread = isMention || e.thread_ts || agentsMode ? threadTs : undefined;
    console.log(`[slack] reply: channel=${e.channel} thread=${replyThread ?? "(none)"} mode=${mode} incoming.thread_ts=${e.thread_ts ?? "(none)"}`);

    try {
      const history = isDM && !e.thread_ts
        ? await this.fetchConversation(e.channel)
        : await this.fetchThread(e.channel, threadTs);
      const content = await this.generateAIReply(history, `${e.channel}:${threadTs}`);
      await this.sendMessage(content, { channel: e.channel, thread_ts: replyThread });
    } catch (err) {
      console.error("[MyAgent] failed", err);
      await this.sendMessage("すみません，うまく答えられませんでした．もう一度お願いします．", {
        channel: e.channel,
        thread_ts: replyThread
      });
    } finally {
      await this.setThinking(e.channel, threadTs, false);
    }
  }
}

const slack = MyAgent.listen({
  // Bot User OAuth Token 方式（推奨）なら Client ID/Secret は空でよい．署名シークレットだけ必須
  clientId: env.SLACK_CLIENT_ID ?? "",
  clientSecret: env.SLACK_CLIENT_SECRET ?? "",
  slackSigningSecret: env.SLACK_SIGNING_SECRET,
  scopes: [
    "chat:write",
    "chat:write.public",
    "channels:history",
    "app_mentions:read",
    "im:write",
    "im:history"
  ]
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Slack の Request URL に末尾の /slack を付け忘れて「https://…/」で保存してしまった場合の救済:
    // ルートへの POST は /slack として扱う（署名検証は /slack 側でそのまま行われる）
    if (request.method === "POST" && url.pathname === "/") {
      url.pathname = "/slack";
      return slack.fetch(new Request(url.toString(), request), env, ctx);
    }

    // Slack 無しで「頭」だけを試すための入口: GET /ask?q=質問
    // 本番で閉じるには wrangler.jsonc の vars.ASK_ENABLED を "false" にする
    if (url.pathname === "/ask") {
      if (env.ASK_ENABLED !== "true") return new Response("disabled", { status: 404 });
      const q = url.searchParams.get("q");
      if (!q) return new Response("使い方: /ask?q=質問文", { status: 400 });
      const model = url.searchParams.get("model") ?? undefined;
      const { text, steps, retried } = await think(
        env,
        [{ role: "user", content: q }],
        { agentId: "ask", conversationId: `ask:${Date.now()}` },
        model
      );
      return Response.json({ question: q, model: model ?? env.MODEL, answer: text, steps, retried }, {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    // OAuth（Client ID/Secret）を設定していないときは /install を案内に差し替える
    if (url.pathname === "/install" && !env.SLACK_CLIENT_ID) {
      return new Response(
        "OAuth は未設定です．Slack アプリ設定の「Install to Workspace」でインストールし，\n" +
          "Bot User OAuth Token（xoxb-…）を SLACK_BOT_TOKEN に置いてください（README テスト 2）．",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (url.pathname === "/") {
      return new Response("slack-agent-base is running. Slack: /install, test: /ask?q=...", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return slack.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
