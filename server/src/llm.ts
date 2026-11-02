import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Item } from "./db";

/**
 * All LLM work lives here so every client (desktop capture, phone voice note, web text note)
 * goes through the same prompts. Without credentials we fall back to heuristics so the app
 * still works end to end (lower accuracy).
 */
/** High-volume screen-capture extraction: cheapest model. */
export const MODEL_FAST = process.env.DOGGY_MODEL_FAST ?? "claude-haiku-5-5";
/** Low-volume, user-facing work (voice/text notes, ask). */
export const MODEL = process.env.DOGGY_MODEL ?? "claude-sonnet-5-5";

/** Server-side refusal fallback. Haiku 5.5 has no server-side fallback, so send nothing for it. */
const fallbackParams = (model: string) =>
  model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
export const hasLLM = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasLLM ? new Anthropic() : null;

export const ITEM_TYPES = ["task", "commitment", "memory", "decision", "event"] as const;

const Extracted = z.object({
  items: z.array(z.object({
    type: z.enum(ITEM_TYPES),
    title: z.string(),
    details: z.string().nullable(),
    owner: z.string().nullable(),
    counterparty: z.string().nullable(),
    due_at: z.string().nullable(),
    evidence: z.string(),
    confidence: z.number(),
    source: z.number().int(),
  })),
  closes: z.array(z.object({ item_id: z.string(), evidence: z.string() })),
});
export type Extraction = z.infer<typeof Extracted>;

const nullable = (t: string) => ({ anyOf: [{ type: t }, { type: "null" }] });
const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "closes"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "details", "owner", "counterparty", "due_at", "evidence", "confidence", "source"],
        properties: {
          type: { type: "string", enum: [...ITEM_TYPES] },
          title: { type: "string" },
          details: nullable("string"),
          owner: nullable("string"),
          counterparty: nullable("string"),
          due_at: nullable("string"),
          evidence: { type: "string" },
          confidence: { type: "number" },
          source: { type: "integer" },
        },
      },
    },
    closes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item_id", "evidence"],
        properties: { item_id: { type: "string" }, evidence: { type: "string" } },
      },
    },
  },
};

const EXTRACT_SYSTEM = `You maintain a personal memory for one person ("the user") so they never forget what they committed to or were asked to do.

You receive one or more sources, each wrapped in <source id="N">. A source is either a note the user spoke or typed to you directly (always sent alone), or text read from their screen (a chat, email, doc, calendar, etc.) by an accessibility reader. Screen text is noisy: it contains UI labels, menus, timestamps, and content from other people. Several screen sources in one request are unrelated episodes from different apps or windows. Judge each on its own and do not merge facts across them. Extract only what is worth remembering:

- task: something the user must do (assigned to them, or they noted it for themselves).
- commitment: something the user promised someone else ("I'll send it tomorrow"), or someone promised the user (owner = that person, counterparty = "me").
- event: a meeting/deadline/appointment with a time.
- decision: a decision that was made and may be asked about later.
- memory: a durable fact worth recalling later (preferences, numbers, names, context). Skip trivia.

Rules:
- Precision over recall for screen text: ignore UI chrome, ads, notifications about unrelated content, and old history that is clearly not new. When the user speaks to you directly, keep everything they asked you to remember.
- owner is "me" when the user is responsible; otherwise the person's name. counterparty is the other person involved, or null.
- due_at: resolve relative dates ("by Friday", "tomorrow 5pm") to ISO 8601 using the provided current time and timezone; null if none.
- title: short imperative or factual line (<= 90 chars), self-contained without the source.
- evidence: a short verbatim quote from the source that supports the item. Never invent evidence.
- confidence: 0-1, how sure you are this is a real, current item for this user.
- source: the id of the source the evidence is quoted from.
- Do not repeat anything already in the existing open items list. If the source shows an existing open item is now done (sent, completed, cancelled), add it to closes with a quote.
- Return empty arrays when there is nothing worth keeping (that is the common case for screen text).`;

export type ExtractSource = { app: string | null; window: string | null; url: string | null; text: string };

export type ExtractInput = {
  kind: "capture" | "voice" | "text";
  sources: ExtractSource[];
  userName?: string | null;
  userEmail: string;
  tz: string;
  existing: Item[];
};

export async function extract(input: ExtractInput): Promise<Extraction> {
  if (!client) return heuristicExtract(input);
  const nowLocal = new Date().toLocaleString("en-US", { timeZone: input.tz, dateStyle: "full", timeStyle: "short" });
  const header = [
    `User: ${input.userName ?? "(unknown name)"} <${input.userEmail}>`,
    `Current time: ${nowLocal} (${input.tz}); ISO now ${new Date().toISOString()}`,
    input.kind === "capture"
      ? `Sources: ${input.sources.length} screen text episode(s), each tagged with its app, window and url`
      : `Source: the user ${input.kind === "voice" ? "spoke" : "typed"} this note directly to you`,
  ].join("\n");
  const attr = (v: string | null) => (v ?? "").replace(/["<>\n]/g, " ").slice(0, 300);
  const body = input.sources.map((s, i) =>
    input.kind === "capture"
      ? `<source id="${i}" app="${attr(s.app)}" window="${attr(s.window)}" url="${attr(s.url)}">\n${s.text}\n</source>`
      : `<source id="${i}">\n${s.text}\n</source>`,
  ).join("\n\n");
  const existing = input.existing.length
    ? input.existing.map((i) => `- [${i.id}] (${i.type}) ${i.title}${i.dueAt ? ` due ${i.dueAt}` : ""}`).join("\n")
    : "(none)";

  const model = input.kind === "capture" ? MODEL_FAST : MODEL;
  const res = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    ...fallbackParams(model),
    // Screen text is high volume; direct notes are few and matter more.
    output_config: {
      effort: input.kind === "capture" ? "low" : "medium",
      format: { type: "json_schema", schema: EXTRACT_SCHEMA },
    },
    system: EXTRACT_SYSTEM,
    messages: [{
      role: "user",
      content: `${header}\n\nExisting open items:\n${existing}\n\n${body}`,
    }],
  } as any);

  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
    console.warn(`[llm] extract stopped: ${res.stop_reason}`);
    return input.kind === "capture" ? { items: [], closes: [] } : heuristicExtract(input);
  }
  const text = res.content.flatMap((b: any) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = Extracted.safeParse(JSON.parse(text));
  if (!parsed.success) {
    console.warn("[llm] extract schema mismatch", parsed.error.message);
    return { items: [], closes: [] };
  }
  const known = new Set(input.existing.map((i) => i.id));
  return {
    items: parsed.data.items.filter((it) => it.source >= 0 && it.source < input.sources.length),
    closes: parsed.data.closes.filter((c) => known.has(c.item_id)),
  };
}

export async function answer(question: string, tz: string, sources: { label: string; text: string }[]) {
  if (!client) {
    if (!sources.length) return "I couldn't find anything about that yet.";
    return "Here's what I found (no AI key configured, showing raw matches):\n" +
      sources.slice(0, 6).map((s, i) => `[${i + 1}] ${s.text}`).join("\n");
  }
  const nowLocal = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  const ctx = sources.map((s, i) => `[${i + 1}] ${s.label}\n${s.text}`).join("\n\n");
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    ...fallbackParams(MODEL),
    output_config: { effort: "low" },
    system:
      "You answer questions about the user's own memories, tasks and commitments using only the numbered sources. " +
      "Be brief and concrete (dates, people, what is owed). Cite sources inline like [2]. " +
      "If the sources don't contain the answer, say so plainly. Current time: " + nowLocal + ` (${tz}).`,
    messages: [{ role: "user", content: `Sources:\n${ctx || "(none)"}\n\nQuestion: ${question}` }],
  } as any);
  if (res.stop_reason === "refusal") return "I can't answer that one.";
  return res.content.flatMap((b: any) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

// ---------- heuristic fallback (no API key) ----------
const TASK_RE = /\b(i'?ll|i will|i'm going to|remind me|todo|to-do|need to|have to|must|don'?t forget|can you|could you|please|follow up|send|share|review|call|email)\b/i;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function guessDue(s: string): string | null {
  const t = s.toLowerCase();
  const d = new Date();
  if (/\btomorrow\b/.test(t)) { d.setDate(d.getDate() + 1); d.setHours(17, 0, 0, 0); return d.toISOString(); }
  if (/\btoday|tonight|eod\b/.test(t)) { d.setHours(18, 0, 0, 0); return d.toISOString(); }
  const day = DAYS.findIndex((x) => t.includes(x));
  if (day >= 0) {
    const delta = (day - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + delta); d.setHours(17, 0, 0, 0); return d.toISOString();
  }
  return null;
}

function heuristicExtract(input: ExtractInput): Extraction {
  const items: Extraction["items"] = [];
  input.sources.forEach((src, source) => {
    const found: Extraction["items"] = [];
    const sentences = src.text.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter((s) => s.length > 6);
    for (const s of sentences) {
      if (TASK_RE.test(s)) {
        found.push({
          type: /\bi'?ll|i will\b/i.test(s) ? "commitment" : "task",
          title: s.slice(0, 90), details: null, owner: "me", counterparty: null,
          due_at: guessDue(s), evidence: s.slice(0, 200), confidence: input.kind === "capture" ? 0.6 : 0.4, source,
        });
      }
    }
    if (input.kind !== "capture" && !found.length) {
      found.push({
        type: "memory", title: src.text.slice(0, 90), details: src.text.length > 90 ? src.text : null,
        owner: "me", counterparty: null, due_at: guessDue(src.text), evidence: src.text.slice(0, 200), confidence: 0.6, source,
      });
    }
    items.push(...(input.kind === "capture" ? found.slice(0, 3) : found));
  });
  return { items, closes: [] };
}
