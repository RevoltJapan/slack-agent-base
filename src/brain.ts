import * as ai from "ai";
import { stepCountIs, type ModelMessage } from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";
import { tools } from "./tools";

// 指示書．ここを書き換えるとエージェントの振る舞いが変わる
export const INSTRUCTIONS = `あなたは Slack で働くアシスタントです．日本語で簡潔に答えてください．
- 今日の日付や曜日が関わる質問は，推測せず now を呼ぶ
- 計算は暗算せず calc を使う
- 曖昧な依頼は先に 1 つだけ聞き返す
- 分からないことは推測で埋めず「分かりません」と言う`;

const tracedAI = wrapAISDK(ai, { storeMessages: true, storeTools: true });

export async function think(env: Env, messages: ModelMessage[], agentId: string, conversationId: string) {
  const workersai = createWorkersAI({ binding: env.AI });
  const result = await tracedAI.generateText({
    model: workersai(env.MODEL as Parameters<typeof workersai>[0]),
    system: INSTRUCTIONS,
    messages,
    tools,
    stopWhen: stepCountIs(5),
    runtimeContext: { agentId, conversationId },
    telemetry: { functionId: "slack-agent-base", includeRuntimeContext: { agentId: true, conversationId: true } }
  });
  return result.text.trim() || "うまく答えられませんでした．もう一度お願いします．";
}
