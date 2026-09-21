export const PRIMARY_PROCESSING_RUN_KEY = "primary";

export function processingRunKey(payload: Record<string, unknown>): string {
  const value = payload.processingRunKey;
  if (value == null) return PRIMARY_PROCESSING_RUN_KEY;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160) {
    throw new Error("processing stage received invalid processingRunKey");
  }
  return value.trim();
}

export function isReplayProcessingRun(payload: Record<string, unknown>): boolean {
  return processingRunKey(payload) !== PRIMARY_PROCESSING_RUN_KEY;
}
