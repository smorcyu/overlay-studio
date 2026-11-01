/** 见 loudness.mjs */
export const LOUDNESS_TARGET: number;
export const MAX_GAIN_DB: number;
export const SILENT_LUFS: number;
export function ebur128Args(file: string): string[];
export function parseLoudness(stderr: unknown): number | null;
export function loudnessGain(lufs: number | null): number;
export function loudnessStatus(lufs: number | null): "adjusted" | "ok" | "silent" | "capped" | null;
