export type AgendaRealisticEvent = {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
};

export type AgendaAnalysis = {
  timedEvents: AgendaRealisticEvent[];
  allDayCount: number;
  busyMinutes: number;
  conflicts: Array<{ first: AgendaRealisticEvent; second: AgendaRealisticEvent }>;
  tightTransitions: Array<{ first: AgendaRealisticEvent; second: AgendaRealisticEvent; gapMinutes: number }>;
  longestFreeWindow: { start: string; end: string; minutes: number } | null;
};

function validTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function analyzeAgenda(
  events: AgendaRealisticEvent[],
  dayStart: string,
  dayEnd: string,
): AgendaAnalysis {
  const allDayCount = events.filter((event) => event.allDay).length;
  const startBoundary = validTime(dayStart)!;
  const endBoundary = validTime(dayEnd)!;
  const timedEvents = events
    .filter((event) => !event.allDay && validTime(event.start) !== null && validTime(event.end) !== null && validTime(event.end)! > validTime(event.start)!)
    .sort((left, right) => validTime(left.start)! - validTime(right.start)!);

  const conflicts: AgendaAnalysis["conflicts"] = [];
  const tightTransitions: AgendaAnalysis["tightTransitions"] = [];
  for (let index = 1; index < timedEvents.length; index += 1) {
    const first = timedEvents[index - 1];
    const second = timedEvents[index];
    const gapMinutes = Math.round((validTime(second.start)! - validTime(first.end)!) / 60_000);
    if (gapMinutes < 0) conflicts.push({ first, second });
    else if (gapMinutes < 15) tightTransitions.push({ first, second, gapMinutes });
  }

  const blocks: Array<{ start: number; end: number }> = [];
  for (const event of timedEvents) {
    const start = validTime(event.start)!;
    const end = validTime(event.end)!;
    const current = blocks[blocks.length - 1];
    if (current && start <= current.end) current.end = Math.max(current.end, end);
    else blocks.push({ start, end });
  }
  const busyMinutes = Math.round(blocks.reduce((sum, block) => (
    sum + Math.max(0, Math.min(block.end, endBoundary) - Math.max(block.start, startBoundary))
  ), 0) / 60_000);
  let cursor = startBoundary;
  let longestFreeWindow: AgendaAnalysis["longestFreeWindow"] = null;
  for (const block of blocks) {
    const freeEnd = Math.min(block.start, endBoundary);
    if (freeEnd > cursor && (!longestFreeWindow || freeEnd - cursor > Date.parse(longestFreeWindow.end) - Date.parse(longestFreeWindow.start))) {
      longestFreeWindow = { start: new Date(cursor).toISOString(), end: new Date(freeEnd).toISOString(), minutes: Math.round((freeEnd - cursor) / 60_000) };
    }
    cursor = Math.max(cursor, block.end);
  }
  if (endBoundary > cursor && (!longestFreeWindow || endBoundary - cursor > Date.parse(longestFreeWindow.end) - Date.parse(longestFreeWindow.start))) {
    longestFreeWindow = { start: new Date(cursor).toISOString(), end: new Date(endBoundary).toISOString(), minutes: Math.round((endBoundary - cursor) / 60_000) };
  }

  return { timedEvents, allDayCount, busyMinutes, conflicts, tightTransitions, longestFreeWindow };
}
