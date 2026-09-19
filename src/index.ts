import { Agent, getAgentByName, routeAgentRequest } from "agents";
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
  // MCP をつなぐときの OAuth の戻り先．Slack のイベントから受け取って覚えておく
  callbackHost = "";

  async onSlackEvent(e: SlackMessage, callbackHost: string) {
    this.callbackHost = callbackHost;
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
      if (history.length === 0) history.push({ role: "user", content: (e.text ?? "").replace(/<@[A-Z0-9]+>/g, "") });
      const text = await think(this.env, history, this.name, `${e.channel}:${thread}`);
      await this.slack("chat.postMessage", { channel: e.channel, thread_ts: thread, text });
    } finally {
      await this.slack("agents.sessions.setStatus", { channel_id: e.channel, thread_ts: thread, status: "active" });
    }
  }

  // Slack API 呼び出し（読み取り系は JSON を受け付けないので，全てフォーム形式で送る）
  private async slack<T = unknown>(method: string, params: Record<string, string | number>): Promise<T> {
    const body = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}` },
      body
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
    // MCP をつないだときの OAuth の戻り先．エージェント本体へ渡す
    if (new URL(req.url).pathname.endsWith("/callback")) {
      return (await routeAgentRequest(req, env)) ?? new Response("not found", { status: 404 });
    }

    if (req.method !== "POST") return new Response("slack-agent-base");
    const raw = await req.text();
    if (!(await verify(env.SLACK_SIGNING_SECRET, req, raw))) return new Response("bad signature", { status: 401 });

    const body = JSON.parse(raw);
    if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
    if (req.headers.get("X-Slack-Retry-Num")) return new Response("ok");

    const agent = await getAgentByName(env.MyAgent, body.team_id);
    ctx.waitUntil(agent.onSlackEvent(body.event, new URL(req.url).origin));
    return new Response("ok");
  }
} satisfies ExportedHandler<Env>;
