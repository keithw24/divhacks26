import type { Location, SkillResult } from "../domain/contracts.js";
import {
  currentHourEt,
  lookupBlockSafety,
  parseRequestedHour,
  type BlockSafetyReport,
} from "../safety.js";

export interface SafetyInput {
  origin: Location;
  when: string;
  databaseUrl?: string;
  now?: Date;
}

export async function getSafety(input: SafetyInput): Promise<SkillResult<BlockSafetyReport | null>> {
  if (!input.databaseUrl) {
    console.info("tiger: skipped (no DATABASE_URL)");
    return {
      status: "unavailable",
      data: null,
      sources: [],
      warnings: ["Tiger Data is not configured."],
    };
  }

  try {
    const clock = currentHourEt(input.now);
    const hourEt = parseRequestedHour(input.when, clock.hourEt);
    const report = await lookupBlockSafety(
      input.databaseUrl,
      input.origin.latitude,
      input.origin.longitude,
      hourEt,
      clock.asOfEt,
    );
    const vsNyc = report.baselines.hourVsNyc;
    const vsNycLabel = vsNyc == null ? "n/a" : `${vsNyc.toFixed(2)}x NYC`;
    console.info(
      `tiger: queried nypd_complaints (${input.origin.label}, ${hourEt}:00 ET, ${vsNycLabel})`,
    );
    return {
      status: "ok",
      data: { ...report, placeLabel: input.origin.label },
      sources: [
        {
          name: "NYPD Complaint Data via Tiger Data",
          url: "https://data.cityofnewyork.us/d/5uac-w243",
          updatedAt: report.asOfEt,
        },
      ],
      warnings: ["Historical public context is not a live safety score."],
    };
  } catch (error) {
    console.info("tiger: skipped (query failed)");
    console.error("safety skill failed:", error);
    return {
      status: "unavailable",
      data: null,
      sources: [],
      warnings: ["Historical safety context is temporarily unavailable."],
    };
  }
}
