import { db } from "./db";
import type { Usage } from "./llm";

export type UsageKind = "capture" | "voice" | "text" | "ask";

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function recordUsage(userId: string, kind: UsageKind, u: Usage) {
  db.query(
    `INSERT INTO llm_usage (day, user_id, kind, calls, input_tokens, output_tokens) VALUES (?,?,?,1,?,?)
     ON CONFLICT (day, user_id, kind) DO UPDATE SET calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
  ).run(utcDay(), userId, kind, u.inputTokens, u.outputTokens);
}

export function usageReport(userId: string) {
  const since = utcDay(new Date(Date.now() - 6 * 86_400_000));
  const days = db.query(
    `SELECT day, kind, calls, input_tokens AS inputTokens, output_tokens AS outputTokens
     FROM llm_usage WHERE user_id = ? AND day >= ? ORDER BY day DESC, kind`,
  ).all(userId, since) as { day: string; kind: UsageKind; calls: number; inputTokens: number; outputTokens: number }[];
  const today = utcDay();
  const captureToday = days.find((d) => d.day === today && d.kind === "capture")?.inputTokens ?? 0;
  return {
    today: { day: today, captureInputTokens: captureToday },
    days,
  };
}
