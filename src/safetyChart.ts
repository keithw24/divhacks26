import { Resvg } from "@resvg/resvg-js";
import { config } from "./config.js";
import { getGeminiClient } from "./gemini/client.js";
import type { BlockSafetyReport } from "./safety.js";
import { buildSafetyContext, hourRangeLabel, type SafetyContext } from "./safetyContext.js";

export interface ChartImage {
  data: Buffer;
  mimeType: string;
}

/** Everything drawn on the chart. Only these words and numbers may appear in the final image. */
export interface ChartFacts {
  hourEt: number;
  hourLabel: string;
  counts: number[];
  localBaseline: number;
  headline: string;
  subtitle: string;
  legendHour: string;
  legendLine: string;
  axisLabels: Array<{ hour: number; text: string }>;
  footnote: string;
  /** Is the highlighted bar shorter or taller than the dashed "usual hour" line? */
  highlightedVsLine: "shorter" | "taller" | "about equal";
}

/** Gemini's read-back of a restyled chart. */
export interface ChartReadback {
  headline: string;
  allText: string;
  highlightedBarVsDashedLine: "shorter" | "taller" | "about equal" | "unclear";
  sameBarShapeAsOriginal: boolean;
  hasAlarmingImagery: boolean;
}

const BANNED = /\b(safe|safer|safest|unsafe|danger|dangerous|avoid|crime-ridden|sketchy|risky|warning)\b/i;

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function headlineFor(ctx: SafetyContext, hours: string): string {
  if (ctx.vsLocal === "below") return `Fewer reports than usual here at ${hours}`;
  if (ctx.vsLocal === "above") return `More reports than usual here at ${hours}`;
  return `About the usual number of reports here at ${hours}`;
}

/** Null when there is nothing honest to draw (high uncertainty or no data). */
export function buildChartFacts(report: BlockSafetyReport, now = new Date()): ChartFacts | null {
  const ctx = buildSafetyContext(report, now);
  const start = report.observation?.start;
  const end = report.observation?.end;
  if (ctx.uncertainty === "high" || ctx.sampleSize <= 0 || !start || !end || ctx.localBaseline <= 0) return null;
  const counts = Array.from({ length: 24 }, () => 0);
  for (const bucket of report.neighborhoodByHour ?? []) {
    if (bucket.hourEt >= 0 && bucket.hourEt < 24) counts[bucket.hourEt] = Number(bucket.complaints) || 0;
  }
  const hours = hourRangeLabel(ctx.hourEt);
  const here = counts[ctx.hourEt] ?? 0;
  const gap = (here - ctx.localBaseline) / ctx.localBaseline;
  return {
    hourEt: ctx.hourEt,
    hourLabel: hours,
    counts,
    localBaseline: ctx.localBaseline,
    headline: headlineFor(ctx, hours),
    subtitle: "Past reported complaints within ½ mile, by time of day",
    legendHour: `Your time (${hours})`,
    legendLine: "Usual hour here",
    axisLabels: [
      { hour: 0, text: "Midnight" },
      { hour: 6, text: "6 AM" },
      { hour: 12, text: "Noon" },
      { hour: 18, text: "6 PM" },
    ],
    footnote: `${ctx.sampleSize} reports, ${shortDate(start)} to ${shortDate(end)}. Past reports, not live conditions.`,
    highlightedVsLine: Math.abs(gap) < 0.1 ? "about equal" : gap < 0 ? "shorter" : "taller",
  };
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const W = 1200;
const H = 900;
const PLOT = { left: 60, right: 1140, top: 270, bottom: 740 };
const FONT = "Helvetica, Arial, 'DejaVu Sans', sans-serif";

/** Exact, deterministic chart. This is the ground truth Gemini restyles. */
export function renderChartSvg(facts: ChartFacts): string {
  const slot = (PLOT.right - PLOT.left) / 24;
  const barWidth = slot * 0.7;
  const maxY = Math.max(...facts.counts, facts.localBaseline) * 1.15 || 1;
  const y = (value: number) => PLOT.bottom - (value / maxY) * (PLOT.bottom - PLOT.top);
  const bars = facts.counts
    .map((count, hour) => {
      const x = PLOT.left + hour * slot + (slot - barWidth) / 2;
      const top = y(count);
      const fill = hour === facts.hourEt ? "#2563EB" : "#CBD5E1";
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(PLOT.bottom - top).toFixed(1)}" rx="6" fill="${fill}"/>`;
    })
    .join("");
  const hx = PLOT.left + facts.hourEt * slot + slot / 2;
  const hTop = y(facts.counts[facts.hourEt] ?? 0);
  const lineY = y(facts.localBaseline).toFixed(1);
  const axis = facts.axisLabels
    .map(
      (label) =>
        `<text x="${(PLOT.left + label.hour * slot + slot / 2).toFixed(1)}" y="785" font-size="24" fill="#6B7280" text-anchor="middle">${escapeXml(label.text)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<rect width="${W}" height="${H}" fill="#FFFFFF"/>
<text x="60" y="95" font-size="44" font-weight="bold" fill="#111827">${escapeXml(facts.headline)}</text>
<text x="60" y="145" font-size="26" fill="#6B7280">${escapeXml(facts.subtitle)}</text>
<rect x="60" y="188" width="26" height="26" rx="5" fill="#2563EB"/>
<text x="98" y="210" font-size="24" fill="#374151">${escapeXml(facts.legendHour)}</text>
<line x1="470" y1="201" x2="530" y2="201" stroke="#EA580C" stroke-width="4" stroke-dasharray="12 8"/>
<text x="545" y="210" font-size="24" fill="#374151">${escapeXml(facts.legendLine)}</text>
${bars}
<line x1="${PLOT.left}" y1="${PLOT.bottom}" x2="${PLOT.right}" y2="${PLOT.bottom}" stroke="#9CA3AF" stroke-width="2"/>
<line x1="${PLOT.left}" y1="${lineY}" x2="${PLOT.right}" y2="${lineY}" stroke="#EA580C" stroke-width="4" stroke-dasharray="12 8"/>
<text x="${hx.toFixed(1)}" y="${(hTop - 14).toFixed(1)}" font-size="22" font-weight="bold" fill="#2563EB" text-anchor="middle">Your time</text>
${axis}
<text x="60" y="860" font-size="22" fill="#6B7280">${escapeXml(facts.footnote)}</text>
</svg>`;
}

export function renderChartPng(facts: ChartFacts): Buffer {
  const resvg = new Resvg(renderChartSvg(facts), {
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  });
  return Buffer.from(resvg.render().asPng());
}

/** Every piece of text the chart is allowed to show. */
export function chartTexts(facts: ChartFacts): string[] {
  return [
    facts.headline,
    facts.subtitle,
    facts.legendHour,
    facts.legendLine,
    "Your time",
    ...facts.axisLabels.map((label) => label.text),
    facts.footnote,
  ];
}

function numbersIn(text: string): string[] {
  return (text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[–—-]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Accept a restyled chart only if its read-back matches the exact facts. */
export function checkReadback(facts: ChartFacts, readback: ChartReadback): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (normalize(readback.headline) !== normalize(facts.headline)) reasons.push("headline changed");
  const allowed = new Set(chartTexts(facts).flatMap(numbersIn));
  const extra = numbersIn(`${readback.headline} ${readback.allText}`).filter((n) => !allowed.has(n));
  if (extra.length) reasons.push(`unexpected numbers: ${[...new Set(extra)].join(", ")}`);
  if (BANNED.test(`${readback.headline} ${readback.allText}`)) reasons.push("verdict wording");
  const seen = readback.highlightedBarVsDashedLine;
  const relationOk =
    seen === facts.highlightedVsLine || (facts.highlightedVsLine === "about equal" && seen !== "unclear");
  if (!relationOk) reasons.push(`highlighted bar reads ${seen}, expected ${facts.highlightedVsLine}`);
  if (!readback.sameBarShapeAsOriginal) reasons.push("bar shape changed");
  if (readback.hasAlarmingImagery) reasons.push("alarming imagery");
  return { ok: reasons.length === 0, reasons };
}

function restylePrompt(facts: ChartFacts): string {
  return `Restyle this bar chart into a warm, friendly, easy-to-read graphic for someone with no data background, like a clean infographic in a phone app.

Hard rules:
- Keep exactly ${facts.counts.length} bars in the same order with the same relative heights. Do not add, remove, merge, or resize bars.
- Keep the one highlighted bar highlighted and the dashed "usual hour" line at the same height.
- Keep every piece of text exactly as written, word for word: ${chartTexts(facts).map((t) => JSON.stringify(t)).join(", ")}.
- Do not add any other text, numbers, axis values, or labels.
- No police, sirens, warning signs, skulls, red alerts, maps, people, or anything that implies danger. Calm, neutral colors.
- Flat, clean, plenty of white space, large readable text.`;
}

export async function geminiRestyle(png: Buffer, facts: ChartFacts): Promise<ChartImage> {
  const ai = getGeminiClient(config.geminiApiKey);
  const response = await ai.models.generateContent({
    model: config.geminiImageModel,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }, { text: restylePrompt(facts) }],
      },
    ],
    config: { responseModalities: ["IMAGE"] },
  });
  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no image");
  return { data: Buffer.from(part.inlineData.data, "base64"), mimeType: part.inlineData.mimeType ?? "image/png" };
}

const readbackSchema = {
  type: "object",
  properties: {
    headline: { type: "string", description: "The large title text of image B, verbatim." },
    allText: { type: "string", description: "Every piece of visible text in image B, verbatim, including any numbers." },
    highlightedBarVsDashedLine: {
      type: "string",
      enum: ["shorter", "taller", "about equal", "unclear"],
      description: "In image B, is the highlighted bar's top below (shorter), above (taller), or level with the dashed line?",
    },
    sameBarShapeAsOriginal: {
      type: "boolean",
      description: "True only if image B's bars rise and fall across the day like image A's (same number of bars, same tallest and shortest stretches).",
    },
    hasAlarmingImagery: {
      type: "boolean",
      description: "True if image B shows police, sirens, warning signs, danger symbols, or alarm-red emphasis.",
    },
  },
  required: ["headline", "allText", "highlightedBarVsDashedLine", "sameBarShapeAsOriginal", "hasAlarmingImagery"],
};

export async function geminiReadback(original: Buffer, restyled: ChartImage): Promise<ChartReadback> {
  const ai = getGeminiClient(config.geminiApiKey);
  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          { text: "Image A is the original chart:" },
          { inlineData: { mimeType: "image/png", data: original.toString("base64") } },
          { text: "Image B is a restyled version:" },
          { inlineData: { mimeType: restyled.mimeType, data: restyled.data.toString("base64") } },
          { text: "Describe image B exactly as it appears. Transcribe text verbatim; do not correct it." },
        ],
      },
    ],
    config: { responseMimeType: "application/json", responseJsonSchema: readbackSchema, temperature: 0 },
  });
  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty read-back");
  return JSON.parse(text) as ChartReadback;
}

export interface SafetyChartDeps {
  now?: Date;
  restyle?: (png: Buffer, facts: ChartFacts) => Promise<ChartImage>;
  readback?: (original: Buffer, restyled: ChartImage) => Promise<ChartReadback>;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /429|RESOURCE_EXHAUSTED|quota/i.test(text) ? "quota exceeded" : text.slice(0, 160);
}

/**
 * Exact chart → Gemini restyle → Gemini read-back check.
 * - Nothing honest to draw (high uncertainty, no data): null, text card only.
 * - Gemini can't restyle or read back (quota, error, timeout): the exact chart.
 * - Restyled image fails the read-back check: null, text card only.
 */
export async function safetyChartImage(report: BlockSafetyReport, deps: SafetyChartDeps = {}): Promise<ChartImage | null> {
  const facts = buildChartFacts(report, deps.now);
  if (!facts) {
    console.info("safety.chart skipped (too little data)");
    return null;
  }
  const restyle = deps.restyle ?? geminiRestyle;
  const readback = deps.readback ?? geminiReadback;
  const timeoutMs = deps.timeoutMs ?? 45_000;
  let original: Buffer;
  try {
    original = renderChartPng(facts);
  } catch (error) {
    console.warn(`safety.chart render failed: ${reason(error)}`);
    return null;
  }
  const exact: ChartImage = { data: original, mimeType: "image/png" };
  let restyled: ChartImage;
  try {
    restyled = await withTimeout(restyle(original, facts), timeoutMs);
  } catch (error) {
    console.warn(`safety.chart restyle unavailable (${reason(error)}); sending the exact chart`);
    return exact;
  }
  let check: { ok: boolean; reasons: string[] };
  try {
    check = checkReadback(facts, await withTimeout(readback(original, restyled), timeoutMs));
  } catch (error) {
    console.warn(`safety.chart read-back unavailable (${reason(error)}); sending the exact chart`);
    return exact;
  }
  if (!check.ok) {
    console.warn(`safety.chart rejected: ${check.reasons.join("; ")}`);
    return null;
  }
  console.info("safety.chart verified");
  return restyled;
}
