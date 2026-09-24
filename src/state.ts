/** State helpers — truncation and splitting for the 60k char cap. */

export const MAX_STATE_CHARS = 60_000;
const HEAD_RATIO = 0.6;

/** Smart truncate: keep head + tail with marker, preserve JSON structure when possible. */
export function smartTruncate(input: string, max = MAX_STATE_CHARS): { text: string; truncated: boolean; origChars: number } {
  const origChars = input.length;
  if (origChars <= max) return { text: input, truncated: false, origChars };
  const head = Math.floor(max * HEAD_RATIO);
  const tail = max - head - 80; // room for marker
  const marker = `\n\n…[truncated ${origChars - max} chars; head ${head} + tail ${tail} kept]…\n\n`;
  return { text: input.slice(0, head) + marker + input.slice(origChars - tail), truncated: true, origChars };
}

/** Lint choice criteria — warns on vague/overlapping options (common failure for bounded tasks). */
export function lintChoiceCriteria(criteria: Record<string, string | null>): string[] {
  const warnings: string[] = [];
  for (const [opt, desc] of Object.entries(criteria)) {
    if (desc === null) continue;
    const d = desc.trim();
    if (d.length < 12) warnings.push(`option "${opt}" description too short (${d.length} chars) — add a rubric sentence`);
    if (d.length > 2000) warnings.push(`option "${opt}" description too long — trim to <500 chars`);
  }
  // Jaccard overlap check: flag near-duplicate descriptions
  const opts = Object.keys(criteria);
  for (let i = 0; i < opts.length; i++) {
    for (let j = i + 1; j < opts.length; j++) {
      const a = new Set(((criteria[opts[i]!] ?? "") as string).toLowerCase().split(/\W+/).filter(Boolean));
      const b = new Set(((criteria[opts[j]!] ?? "") as string).toLowerCase().split(/\W+/).filter(Boolean));
      const inter = [...a].filter((x) => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      const jacc = union ? inter / union : 0;
      if (jacc > 0.6 && a.size > 3) warnings.push(`options "${opts[i]}"/"${opts[j]}" descriptions overlap (Jaccard ${jacc.toFixed(2)}) — differentiate rubrics`);
    }
  }
  return warnings;
}

/** Lint score levels — ordered, distinct, sufficient */
export function lintScoreLevels(levels: string[]): string[] {
  const w: string[] = [];
  if (levels.length < 2) w.push("score needs ≥2 levels");
  if (levels.length > 16) w.push("score supports ≤16 levels");
  const uniq = new Set(levels.map((s) => s.trim().toLowerCase()));
  if (uniq.size !== levels.length) w.push("score levels must be distinct");
  return w;
}
