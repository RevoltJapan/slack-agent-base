// エージェントの「頭」．入口（Slack / テスト用 HTTP）に依存しない．
import * as ai from "ai";
import { stepCountIs, type ModelMessage } from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";
import { makeTools } from "./tools";

// AI SDK を Agents SDK の計測ラッパーで包む．これで Cloudflare ダッシュボードの Agents タブに
// 「1 ターン＝invoke_agent → chat（モデル）→ execute_tool（道具）」のトレースが出る．
// storeMessages / storeTools を true にすると，やり取りの本文と道具の引数・結果まで記録される（研修用．個人情報を扱うなら false に）
const tracedAI = wrapAISDK(ai, { storeMessages: true, storeTools: true });

// 指示書．受講者が最初に書き換える場所．
export const INSTRUCTIONS = `あなたは Slack の中で働くアシスタントです．日本語で，簡潔に答えてください．

## 守ること
- 今日の日付や曜日が関係する質問では，推測せず必ず now を呼んでから答える
- 数の計算や日付の足し引きは，自分で計算せず必ず calc を使う
- 週は月曜から日曜まで．「来週」は次の月曜から始まる週を指す（今日が月曜なら「来週の金曜」は 11 日後）
- 道具の結果を見て足りなければ，もう一度道具を使ってよい
- 依頼が曖昧で答えが変わるときは，先に 1 つだけ聞き返す
- 分からないことは推測で埋めず「分かりません」と言い，何があれば答えられるかを添える`;

export type StepTrace = { tool: string; input: unknown; output: unknown }[];

/** 小さいモデルは，まれに道具呼び出しの生テキストをそのまま答えに混ぜる．その検知 */
function looksLikeLeakedToolCall(text: string): boolean {
  return /<tool_call>|<\/tool_call>|<arg_key>|<arg_value>|<\|tool_call/.test(text);
}

export type ThinkContext = {
  /** エージェントの個体を表す安定した ID（例: Slack のワークスペース ID） */
  agentId: string;
  /** 会話（スレッド）を表す ID */
  conversationId: string;
};

export async function think(
  env: Env,
  messages: ModelMessage[],
  ctx: ThinkContext,
  modelOverride?: string
): Promise<{ text: string; steps: StepTrace; retried: boolean }> {
  const workersai = createWorkersAI({ binding: env.AI });
  // wrangler.jsonc の vars.MODEL で差し替え可能（テスト用に /ask?model= でも上書きできる）
  const model = workersai((modelOverride ?? env.MODEL) as Parameters<typeof workersai>[0]);

  const run = () =>
    tracedAI.generateText({
      model,
      system: INSTRUCTIONS,
      messages,
      tools: makeTools(env.TIMEZONE),
      stopWhen: stepCountIs(6), // 道具を使う往復の上限
      // トレースの見出し（Agents タブでの識別子）
      runtimeContext: { agentId: ctx.agentId, conversationId: ctx.conversationId },
      telemetry: {
        functionId: "slack-agent-base",
        includeRuntimeContext: { agentId: true, conversationId: true }
      }
    });

  let result = await run();
  let retried = false;
  // 小さいモデルは，道具を呼んだあと最後の文を書かずに終わる／道具呼び出しの生テキストを混ぜる，
  // ということがまれに起きる．その場合は 1 回だけやり直す（次はたいてい正しく答える）
  if (result.text.trim() === "" || looksLikeLeakedToolCall(result.text)) {
    result = await run();
    retried = true;
  }

  // 各ステップで何の道具を何の引数で呼び，何が返ったかを集める（「判断の絵」用）
  const steps: StepTrace = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      const r = step.toolResults.find((x) => x.toolCallId === call.toolCallId);
      steps.push({ tool: call.toolName, input: call.input, output: r?.output });
    }
  }

  const text = looksLikeLeakedToolCall(result.text)
    ? "すみません，うまく答えられませんでした．もう一度お願いします．"
    : result.text.trim() || "（返答を作れませんでした）";
  return { text, steps, retried };
}

/** 手順を Slack 向けの短い文字列にする */
export function formatSteps(steps: StepTrace): string {
  if (steps.length === 0) return "";
  const lines = steps.map((s, i) => {
    const input = JSON.stringify(s.input);
    const output = JSON.stringify(s.output);
    return `> ${i + 1}. \`${s.tool}\` ${input === "{}" ? "" : input} → ${output}`;
  });
  return ["> 🔧 手順", ...lines].join("\n");
}
