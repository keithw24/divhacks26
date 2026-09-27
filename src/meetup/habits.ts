export const MIN_LATE_BUFFER_MINUTES = 10;
export const LATE_INCIDENTS_TO_MARK = 2;

export interface LateHabitMark {
  self: boolean;
  names: string[];
}

export interface PersonLateHabit {
  habituallyLate: boolean;
  lateIncidents: number;
}

/** Extra minutes to leave before the timed departure. At least 10; grows with a long trip. */
export function lateHabitBufferMinutes(durationSeconds: number): number {
  const travelMin = Math.max(0, Math.round(durationSeconds / 60));
  return Math.max(MIN_LATE_BUFFER_MINUTES, Math.round(travelMin * 0.2));
}

const SELF =
  /\b(?:i(?:'|’)m|i am)\s+(?:always|habitually|usually|notoriously)\s+late\b|\bi always run late\b|\bi(?:'|’)m never on time\b|\bmark me as (?:always )?late\b/i;

const OTHER =
  /\b([A-Za-z][A-Za-z'-]{1,20})\s+is\s+(?:always|habitually|usually|notoriously)\s+late\b|\b([A-Za-z][A-Za-z'-]{1,20})\s+always\s+runs?\s+late\b|\b(?:mark|note)\s+([A-Za-z][A-Za-z'-]{1,20})\s+as\s+(?:always |habitually )?late\b/i;

const STOP_WORDS = new Set(["he", "she", "they", "we", "someone", "everybody", "everyone", "people"]);

export function parseLateHabit(text: string): LateHabitMark | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  const self = SELF.test(cleaned);
  const names: string[] = [];
  const global = new RegExp(OTHER.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = global.exec(cleaned))) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!raw || STOP_WORDS.has(raw.toLowerCase()) || /^i$/i.test(raw)) continue;
    names.push(raw);
  }
  if (!self && !names.length) return undefined;
  return { self, names };
}

export function emptyHabit(): PersonLateHabit {
  return { habituallyLate: false, lateIncidents: 0 };
}

export function applyLateIncident(habit: PersonLateHabit): PersonLateHabit {
  const lateIncidents = habit.lateIncidents + 1;
  return {
    lateIncidents,
    habituallyLate: habit.habituallyLate || lateIncidents >= LATE_INCIDENTS_TO_MARK,
  };
}

export function habitKey(name: string): string {
  return name.trim().toLowerCase();
}
