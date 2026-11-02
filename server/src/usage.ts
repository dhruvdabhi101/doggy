import { db } from "./db";
import type { Usage } from "./llm";

export type UsageKind = "capture" | "voice" | "text" | "ask";

/** Daily input-token caps on screen-capture extraction. Notes and ask are never capped. */
export const USER_DAILY_INPUT_TOKENS = Number(process.env.DOGGY_USER_DAILY_INPUT_TOKENS ?? 300_000);
export const GLOBAL_DAILY_INPUT_TOKENS = Number(process.env.DOGGY_GLOBAL_DAILY_INPUT_TOKENS ?? 3_000_000);

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function recordUsage(userId: string, kind: UsageKind, u: Usage) {
  db.query(
    `INSERT INTO llm_usage (day, user_id, kind, calls, input_tokens, output_tokens) VALUES (?,?,?,1,?,?)
     ON CONFLICT (day, user_id, kind) DO UPDATE SET calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
  ).run(utcDay(), userId, kind, u.inputTokens, u.outputTokens);
}

/** Which capture cap is spent today, if any. Checked before a call, so one call can overshoot by its own size. */
export function captureCapHit(userId: string): "user" | "global" | null {
  const sum = (where: string, ...args: string[]) =>
    (db.query(`SELECT COALESCE(SUM(input_tokens), 0) AS n FROM llm_usage WHERE day = ? AND kind = 'capture' ${where}`)
      .get(utcDay(), ...args) as { n: number }).n;
  if (sum("AND user_id = ?", userId) >= USER_DAILY_INPUT_TOKENS) return "user";
  if (sum("") >= GLOBAL_DAILY_INPUT_TOKENS) return "global";
  return null;
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
    today: { day: today, captureInputTokens: captureToday, capped: captureCapHit(userId) },
    caps: { userDailyInputTokens: USER_DAILY_INPUT_TOKENS, globalDailyInputTokens: GLOBAL_DAILY_INPUT_TOKENS },
    days,
  };
}
