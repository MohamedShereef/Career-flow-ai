import { auditLogs } from "@careerflow/db";
import { keyedHash } from "../crypto";
import type { Executor } from "../types";

export async function audit(
  db: Executor,
  entry: {
    userId?: string | null;
    actor: "user" | "system" | "agent" | "admin";
    action: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
) {
  await db.insert(auditLogs).values({
    userId: entry.userId ?? null,
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata,
    ipHash: entry.ip ? keyedHash(entry.ip, "ip") : null,
  });
}
