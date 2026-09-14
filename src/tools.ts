import { tool } from "ai";
import { z } from "zod";

export const tools = {
  now: tool({
    description: "現在の日時（日本時間）を返す．今日の日付や曜日が要るときは必ず呼ぶ．",
    inputSchema: z.object({}),
    execute: async () => ({
      datetime: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      weekday: new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", weekday: "long" })
    })
  }),

  calc: tool({
    description: "2 つの数の計算をする．暗算せず必ず呼ぶ．複数段の計算は何度か呼ぶ．",
    inputSchema: z.object({
      a: z.number(),
      op: z.enum(["+", "-", "*", "/"]),
      b: z.number()
    }),
    execute: async ({ a, op, b }) => {
      if (op === "/" && b === 0) return { error: "0 では割れません" };
      const r = { "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op];
      return { result: r };
    }
  })
};
