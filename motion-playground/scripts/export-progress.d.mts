/** 见 export-progress.mjs */
export function applyExportOutput<
  T extends { stage: string; frame: number; total: number; etaSec?: number; finalPct?: number },
>(prog: T, out: string): T;
