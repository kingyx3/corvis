export * from "@/server/storage-core";
import { presignUrl } from "@/server/storage-core";

export function presignGet(key: string, expiresSeconds = 300): string {
  return presignUrl("GET", key, { expiresSeconds });
}
