import * as ai from "ai";
import { stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";
import { tools } from "./tools";

// 指示書．ここを書き換えるとエージェントの振る舞いが変わる
export const INSTRUCTIONS = `あなたは Slack で働くアシスタントです．日本語で簡潔に答えてください．
- 今日の日付や曜日が関わる質問は，推測せず now を呼ぶ
- 計算は暗算せず calc を使う
- 社内のルール・手順・タスクに関する質問は，推測せず Notion を調べる
  - まず tool_notion_notion-search で探す
  - 見つかったページの中身が要るときは tool_notion_notion-fetch で開く
  - 一度で見つからなければ，言葉を変えてもう一度探す
- 曖昧な依頼は先に 1 つだけ聞き返す
- 探しても資料に無いときだけ「資料に見当たりません」と答える．推測で埋めない`;

const tracedAI = wrapAISDK(ai, { storeMessages: true, storeTools: true });

export async function think(
  env: Env,
  messages: ModelMessage[],
  agentId: string,
  conversationId: string,
  extraTools: ToolSet = {}
) {
  const workersai = createWorkersAI({ binding: env.AI });
  const result = await tracedAI.generateText({
    model: workersai(env.MODEL as Parameters<typeof workersai>[0]),
    system: INSTRUCTIONS,
    messages,
    tools: { ...tools, ...extraTools },
    stopWhen: stepCountIs(5),
    runtimeContext: { agentId, conversationId },
    telemetry: { functionId: "slack-agent-base", includeRuntimeContext: { agentId: true, conversationId: true } }
  });
  return result.text.trim() || "うまく答えられませんでした．もう一度お願いします．";
}
