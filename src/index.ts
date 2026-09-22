import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
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

// Notion が公開している MCP サーバー
const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

// モデルに渡す Notion の道具（名前の末尾で判定）．増やしすぎるとコンテキスト長を超える．
// query-data-sources は定義が巨大（数万文字）なので，コンテキストの広いモデルでだけ渡す
const KEEP_TOOLS = [
  "notion-search",
  "notion-fetch",
  "notion-query-data-sources",
  // 書き込み．タスク DB への新規追加と既存の更新に使う
  "notion-create-pages",
  "notion-update-page"
];

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

      // Notion の道具を用意する．まだ許可されていなければ，ここで止めて許可 URL を出す
      const notionTools = await this.connectNotion(e.channel, thread);
      if (!notionTools) return;

      const text = await think(this.env, history, this.name, `${e.channel}:${thread}`, {
        ...notionTools,
        ...this.scheduleTool(e.channel)
      });
      await this.slack("chat.postMessage", { channel: e.channel, thread_ts: thread, text });
    } finally {
      await this.slack("agents.sessions.setStatus", { channel_id: e.channel, thread_ts: thread, status: "active" });
    }
  }

  // Notion の MCP サーバーにつなぐ．初回だけ Notion の許可（OAuth）が要る
  // 許可がまだなら，許可用の URL を Slack に出して null を返す
  private async connectNotion(channel: string, thread: string) {
    // 眠りから覚めた直後は接続の復元中なので，終わるまで待つ
    await this.mcp.waitForConnections({ timeout: 10_000 });

    const notion = Object.values(this.getMcpServers().servers).find((s) => s.name === "notion");
    if (notion?.state !== "ready") {
      const result = await this.addMcpServer("notion", NOTION_MCP_URL, {
        id: "notion",
        callbackHost: this.callbackHost
      });
      if (result.state !== "ready") {
        await this.slack("chat.postMessage", {
          channel,
          thread_ts: thread,
          text: `Notion を使うには，最初に一度だけ許可が要ります．\n${result.authUrl}\nを開いて許可したら，もう一度話しかけてください．`
        });
        return null;
      }
      await this.mcp.waitForConnections({ timeout: 10_000 });
    }

    // Notion の道具は数が多く，全部渡すとモデルのコンテキスト長を超えて落ちる．使うものだけに絞る
    const all = this.mcp.getAITools();
    const picked = Object.fromEntries(Object.entries(all).filter(([name]) => KEEP_TOOLS.some((t) => name.endsWith(t))));

    console.log(`[mcp] ${Object.keys(all).length} 個中 ${Object.keys(picked).length} 個を使う`);
    console.log(`[mcp] 使える道具: ${Object.keys(all).join(", ")}`);

    if (Object.keys(picked).length === 0) {
      console.error("[mcp] 絞り込みの結果が空．KEEP_TOOLS を上のログの名前に合わせること");
    }
    return picked;
  }

  // 「1分後に1回」「毎朝9時に」のような予約を，Slack の会話から作るための道具
  private scheduleTool(channel: string) {
    return {
      schedule_daily_tasks: tool({
        description:
          "「今日やること」を Notion のタスク DB から読んで，このチャンネルに届ける予約を作る．" +
          "「1分後に1回テストして」のような動作確認の依頼では delaySeconds に秒数を入れて呼ぶ．" +
          "「毎朝9時に」のような毎日くり返す依頼では，日本時間から UTC へ直した cron（例: 毎朝9時JST→\"0 0 * * *\"）を入れて呼ぶ．" +
          "delaySeconds と cron は同時に指定しない．呼んだら，実際に何時（日本時間）に届くかを必ず伝える",
        inputSchema: z.object({
          delaySeconds: z.number().optional(),
          cron: z.string().optional()
        }),
        execute: async ({ delaySeconds, cron }) => {
          if (!delaySeconds && !cron) return { error: "delaySeconds か cron のどちらかが必要です" };
          const schedule = await this.schedule(cron ?? delaySeconds!, "postDailyTasks", { channel });
          return { scheduled: true, id: schedule.id };
        }
      })
    };
  }

  // 予約から呼ばれる本体．モデルに Notion のタスク DB を読ませ，まとめをチャンネルに投稿する
  async postDailyTasks(payload: { channel: string }) {
    await this.mcp.waitForConnections({ timeout: 10_000 });
    const notion = Object.values(this.getMcpServers().servers).find((s) => s.name === "notion");
    if (notion?.state !== "ready") {
      await this.slack("chat.postMessage", {
        channel: payload.channel,
        text: "Notion にまだつながっていません．Slack でアシスタントに一度話しかけて，Notion の認可を済ませてください．"
      });
      return;
    }

    // チャットと同じ道具をモデルに渡し，タスク DB の読み取りもモデルに任せる
    const all = this.mcp.getAITools();
    const notionTools = Object.fromEntries(Object.entries(all).filter(([name]) => KEEP_TOOLS.some((t) => name.endsWith(t))));

    const todayIso = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    const today = new Date().toLocaleDateString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long"
    });
    const messages: ModelMessage[] = [
      {
        role: "user",
        content:
          `今日は ${today}（${todayIso}）です．タスク DB を読んで「今日やること」をまとめてください．\n` +
          `手順：タスク DB の URL を tool_notion_notion-fetch で読み，結果にある collection:// の URL を tool_notion_notion-query-data-sources に渡し，` +
          `SQL（SELECT * FROM "collection://..." WHERE "状態" != '完了'）で 1 回で全行を取ってください．search は使わないでください．\n\n` +
          `取れた行のうち，期限（"date:期限:start"）が今日のものと，今日より前のものを対象にしてください．\n` +
          `担当者ごとにグループ化して 1 つのメッセージにまとめ，担当者の書き方は「担当」の値をそのまま使ってください．担当者ごとに次の形で書いてください：\n` +
          `- 期限超過：「タスク名（期限，N日超過）」を 1 行ずつ，期限が古い順\n` +
          `- 今日締切：「タスク名（期限）」を 1 行ずつ\n` +
          `- おすすめの順番：その人が今日どの順に何から手をつけるべきかを，番号付きで 1 行ずつ．期限超過が古いものを先に，同じ期限なら「メモ」の内容を手がかりにし，理由を一言添える\n` +
          `期限とメモに書かれていない事情を推測して書かないでください．対象タスクが誰にも無ければ「今日やることはありません」とだけ書いてください．`
      }
    ];
    const text = await think(this.env, messages, this.name, `schedule:${payload.channel}`, notionTools);
    await this.slack("chat.postMessage", { channel: payload.channel, text });
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
