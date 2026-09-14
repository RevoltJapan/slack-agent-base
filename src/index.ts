import { Agent, getAgentByName } from "agents";
import type { ModelMessage } from "ai";
import { think } from "./brain";

type SlackMessage = {
  type: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
};

// エージェント本体（Durable Object．Slack のワークスペースごとに 1 体）
export class MyAgent extends Agent<Env> {
  async onSlackEvent(e: SlackMessage) {
    if (e.bot_id || e.subtype) return;
    const isDM = e.type === "message" && e.channel.startsWith("D");
    if (!isDM && e.type !== "app_mention") return;

    const thread = e.thread_ts ?? e.ts;
    await this.slack("agents.sessions.setStatus", { channel_id: e.channel, thread_ts: thread, status: "processing" });
    try {
      const { messages = [] } = await this.slack<{ messages: SlackMessage[] }>("conversations.replies", {
        channel: e.channel,
        ts: thread,
        limit: 30
      });
      const history: ModelMessage[] = messages
        .filter((m) => m.text)
        .map((m) => ({ role: m.bot_id ? "assistant" : "user", content: m.text!.replace(/<@[A-Z0-9]+>/g, "") }));
      const text = await think(this.env, history, this.name, `${e.channel}:${thread}`);
      await this.slack("chat.postMessage", { channel: e.channel, thread_ts: thread, text });
    } finally {
      await this.slack("agents.sessions.setStatus", { channel_id: e.channel, thread_ts: thread, status: "active" });
    }
  }

  private async slack<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = (await res.json()) as T & { ok: boolean; error?: string };
    if (!data.ok) console.error(`[slack] ${method}: ${data.error}`);
    return data;
  }
}

// Slack からの署名を検証する
async function verify(secret: string, req: Request, raw: string) {
  const ts = req.headers.get("X-Slack-Request-Timestamp") ?? "";
  const sig = req.headers.get("X-Slack-Signature") ?? "";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === `v0=${hex}`;
}

// 窓口（Worker）．Slack の Events API はここに届く
export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response("slack-agent-base");
    const raw = await req.text();
    if (!(await verify(env.SLACK_SIGNING_SECRET, req, raw))) return new Response("bad signature", { status: 401 });

    const body = JSON.parse(raw);
    if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
    if (req.headers.get("X-Slack-Retry-Num")) return new Response("ok");

    const agent = await getAgentByName(env.MyAgent, body.team_id);
    ctx.waitUntil(agent.onSlackEvent(body.event));
    return new Response("ok");
  }
} satisfies ExportedHandler<Env>;
