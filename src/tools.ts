// 道具（ツール）の定義．エージェントに渡す道具はここに並べる．
// 最初の 2 つは「LLM に元々できないこと」を補う道具:
//   now  … 今がいつか分からない
//   calc … 計算を間違える（日付の足し引きも含む）
import { tool } from "ai";
import { z } from "zod";

export function makeTools(timezone: string) {
  return {
    now: tool({
      description:
        "現在の日時を返す．今日の日付・曜日・時刻が必要なときは，推測せず必ずこれを呼ぶ．",
      inputSchema: z.object({}),
      execute: async () => {
        const d = new Date();
        const fmt = (opts: Intl.DateTimeFormatOptions) =>
          new Intl.DateTimeFormat("ja-JP", { timeZone: timezone, ...opts }).format(d);
        return {
          date: fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-"),
          time: fmt({ hour: "2-digit", minute: "2-digit", hour12: false }),
          weekday: fmt({ weekday: "long" }),
          timezone
        };
      }
    }),

    calc: tool({
      description: [
        "計算をする．四則演算（+ - * / % ^ と括弧）と日付の計算ができる．",
        "日付関数: days_between(from, to) は from から to までの日数（to が未来なら正の数．引数は \"YYYY-MM-DD\"），",
        "add_days(\"YYYY-MM-DD\", n) は n 日後の日付を返す．",
        "例: (1200 + 800) * 1.1 / days_between(\"2026-09-14\", \"2026-09-30\") / add_days(\"2026-09-14\", 11)"
      ].join(" "),
      inputSchema: z.object({
        expression: z.string().describe("計算式（数式または日付関数）")
      }),
      execute: async ({ expression }) => {
        try {
          return { expression, result: evaluate(expression) };
        } catch (e) {
          return { expression, error: (e as Error).message };
        }
      }
    })
  };
}

// ---- 以下は calc の中身（安全な電卓）．eval は使わない ----

type Value = number | string; // string は "YYYY-MM-DD" の日付

export function evaluate(src: string): Value {
  const p = new Parser(src.replace(/[×]/g, "*").replace(/[÷]/g, "/").replace(/[，、]/g, ","));
  const v = p.parseExpr();
  p.expectEnd();
  return v;
}

class Parser {
  private i = 0;
  private s: string;
  constructor(s: string) {
    this.s = s;
  }

  private peek() {
    while (this.s[this.i] === " ") this.i++;
    return this.s[this.i];
  }
  private next() {
    const c = this.peek();
    this.i++;
    return c;
  }
  expectEnd() {
    if (this.peek() !== undefined) throw new Error(`読めない文字があります: "${this.s.slice(this.i)}"`);
  }

  parseExpr(): Value {
    let v = this.parseTerm();
    for (;;) {
      const c = this.peek();
      if (c === "+" || c === "-") {
        this.next();
        const r = this.parseTerm();
        v = c === "+" ? num(v) + num(r) : num(v) - num(r);
      } else return v;
    }
  }
  private parseTerm(): Value {
    let v = this.parsePower();
    for (;;) {
      const c = this.peek();
      if (c === "*" || c === "/" || c === "%") {
        this.next();
        const r = num(this.parsePower());
        if (c === "*") v = num(v) * r;
        else if (c === "/") {
          if (r === 0) throw new Error("0 では割れません");
          v = num(v) / r;
        } else v = num(v) % r;
      } else return v;
    }
  }
  private parsePower(): Value {
    const base = this.parseUnary();
    if (this.peek() === "^") {
      this.next();
      return Math.pow(num(base), num(this.parsePower()));
    }
    return base;
  }
  private parseUnary(): Value {
    if (this.peek() === "-") {
      this.next();
      return -num(this.parseUnary());
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Value {
    const c = this.peek();
    if (c === "(") {
      this.next();
      const v = this.parseExpr();
      if (this.next() !== ")") throw new Error("閉じ括弧がありません");
      return v;
    }
    if (c === '"' || c === "'") return this.parseString();
    if (c !== undefined && /[0-9.]/.test(c)) return this.parseNumber();
    if (c !== undefined && /[a-zA-Z_]/.test(c)) return this.parseCall();
    throw new Error(`読めない文字があります: "${c ?? "(末尾)"}"`);
  }
  private parseNumber(): number {
    const m = /^[0-9][0-9_,]*(\.[0-9]+)?/.exec(this.s.slice(this.i));
    if (!m) throw new Error("数値が読めません");
    this.i += m[0].length;
    return Number(m[0].replace(/[_,]/g, ""));
  }
  private parseString(): string {
    const q = this.next();
    let out = "";
    while (this.peek() !== q) {
      if (this.peek() === undefined) throw new Error("引用符が閉じていません");
      out += this.next();
    }
    this.next();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) throw new Error(`日付は "YYYY-MM-DD" 形式で: ${out}`);
    return out;
  }
  private parseCall(): Value {
    const m = /^[a-zA-Z_]+/.exec(this.s.slice(this.i))!;
    this.i += m[0].length;
    const name = m[0];
    if (!["days_between", "add_days", "sqrt", "round"].includes(name)) {
      throw new Error(`知らない関数です: ${name}`);
    }
    if (this.next() !== "(") throw new Error(`${name} の後に括弧が必要です`);
    const args: Value[] = [];
    if (this.peek() !== ")") {
      args.push(this.parseExpr());
      while (this.peek() === ",") {
        this.next();
        args.push(this.parseExpr());
      }
    }
    if (this.next() !== ")") throw new Error(`${name} の閉じ括弧がありません`);
    return callFn(name, args);
  }
}

function num(v: Value): number {
  if (typeof v !== "number") throw new Error(`数値が必要な場所に日付があります: ${v}`);
  return v;
}
function date(v: Value): Date {
  if (typeof v !== "string") throw new Error(`日付が必要な場所に数値があります: ${v}`);
  return new Date(v + "T00:00:00Z");
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function callFn(name: string, args: Value[]): Value {
  switch (name) {
    case "days_between": {
      if (args.length !== 2) throw new Error("days_between は引数が 2 つ必要です");
      const ms = date(args[1]).getTime() - date(args[0]).getTime();
      return Math.round(ms / 86_400_000);
    }
    case "add_days": {
      if (args.length !== 2) throw new Error("add_days は引数が 2 つ必要です");
      const d = date(args[0]);
      d.setUTCDate(d.getUTCDate() + Math.round(num(args[1])));
      return ymd(d);
    }
    case "sqrt":
      return Math.sqrt(num(args[0]));
    case "round":
      return Math.round(num(args[0]));
    default:
      throw new Error(`知らない関数です: ${name}`);
  }
}
