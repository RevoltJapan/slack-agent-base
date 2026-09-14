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
  async generateAIReply(conversation: SlackMsg[]) {
    const selfId = await this.ensureAppUserId();
    // 直近 30 件だけ渡す（履歴は Slack 側にあるので，ここでは保存しない）
    const messages = normalizeForLLM(conversation.slice(-30), selfId);
    const { text, steps } = await think(env, messages);
    const footer = env.SHOW_STEPS === "true" ? formatSteps(steps) : "";
    return [toSlack(text), footer].filter(Boolean).join("\n\n");
  }

  async onSlackEvent(event: { type: string } & Record<string, unknown>) {
    // ボット自身の発言や編集・参加通知などは無視
    if (event.bot_id || event.subtype) return;

    try {
      // DM
      if (event.type === "message") {
        const e = event as unknown as SlackMsg & { channel: string };
        const isDM = (e.channel || "").startsWith("D");
        const mentioned = (e.text || "").includes(`<@${await this.ensureAppUserId()}>`);
        if (!isDM && !mentioned) return;

        const conversation = await this.fetchConversation(e.channel);
        const content = await this.generateAIReply(conversation);
        await this.sendMessage(content, { channel: e.channel });
        return;
      }

      // チャンネルでの @メンション → スレッドで返す
      if (event.type === "app_mention") {
        const e = event as unknown as SlackMsg & { channel: string };
        const threadTs = e.thread_ts || e.ts;
        const thread = await this.fetchThread(e.channel, threadTs);
        const content = await this.generateAIReply(thread);
        await this.sendMessage(content, { channel: e.channel, thread_ts: threadTs });
      }
    } catch (err) {
      console.error("[MyAgent] failed", err);
    }
  }
}

const slack = MyAgent.listen({
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
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

    // Slack 無しで「頭」だけを試すための入口: GET /ask?q=質問
    // 本番で閉じるには wrangler.jsonc の vars.ASK_ENABLED を "false" にする
    if (url.pathname === "/ask") {
      if (env.ASK_ENABLED !== "true") return new Response("disabled", { status: 404 });
      const q = url.searchParams.get("q");
      if (!q) return new Response("使い方: /ask?q=質問文", { status: 400 });
      const model = url.searchParams.get("model") ?? undefined;
      const { text, steps, retried } = await think(env, [{ role: "user", content: q }], model);
      return Response.json({ question: q, model: model ?? env.MODEL, answer: text, steps, retried }, {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    if (url.pathname === "/") {
      return new Response("slack-agent-base is running. Slack: /install, test: /ask?q=...", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return slack.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
