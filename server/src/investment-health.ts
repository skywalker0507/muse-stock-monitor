import { z, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import * as schema from "./schema";

type Db = ReturnType<Ctx["db"]>;
type Heartbeat = typeof schema.investmentHeartbeats.$inferSelect;
const jobs = ["price", "halt", "sec", "mail"] as const;
const graceMs = 45 * 60_000;
const inboxAcceptanceDays = 7 * 24 * 60 * 60_000;

export const heartbeatStatus = z.enum(["ok", "partial", "error", "skipped"]);
export const monitorHealthView = z.object({
  jobs: z.array(z.object({
    job: z.enum(jobs),
    state: z.enum(["unconfigured", "healthy", "partial", "error", "overdue", "paused"]),
    attemptedAt: z.number().nullable(),
    lastSuccessAt: z.number().nullable(),
    detail: z.string(),
  })),
  qqTestConfirmedAt: z.number().nullable(),
  qqTestFresh: z.boolean(),
});

export async function saveHeartbeat(
  db: Db, job: Heartbeat["job"], status: Heartbeat["status"], detail: string, time = Date.now(),
) {
  const table = schema.investmentHeartbeats;
  const lastSuccessAt = status === "ok" ? time : null;
  await db.insert(table).values({ job, attemptedAt: time, status, detail, lastSuccessAt }).onConflictDoUpdate({
    target: table.job,
    set: { attemptedAt: time, status, detail, ...(lastSuccessAt == null ? {} : { lastSuccessAt }) },
    setWhere: lte(table.attemptedAt, time),
  });
}

export async function monitorHealth(db: Db, now: number, priceExpected: boolean, workersExpected: boolean) {
  const mails = schema.investmentMail;
  const events = schema.investmentSignals;
  const [heartbeats, [lastTest]] = await Promise.all([
    db.select().from(schema.investmentHeartbeats),
    db.select({ confirmedAt: mails.confirmedAt }).from(mails)
      .innerJoin(events, eq(mails.id, events.mailId))
      .where(and(eq(events.kind, "test"), isNotNull(mails.confirmedAt), gt(mails.confirmedAt, 0)))
      .orderBy(desc(mails.confirmedAt)).limit(1),
  ]);
  const byJob = new Map(heartbeats.map((heartbeat) => [heartbeat.job, heartbeat]));
  const status = (row: Heartbeat | undefined, expected: boolean) => {
    if (!row) return "unconfigured" as const;
    if (!expected) return "paused" as const;
    if (now - row.attemptedAt > graceMs || row.status === "skipped") return "overdue" as const;
    if (row.status === "ok") return "healthy" as const;
    return row.status;
  };
  const qqTestConfirmedAt = lastTest?.confirmedAt ?? null;
  return {
    jobs: jobs.map((job) => {
      const row = byJob.get(job);
      return {
        job, state: status(row, job === "price" ? priceExpected : workersExpected),
        attemptedAt: row?.attemptedAt ?? null, lastSuccessAt: row?.lastSuccessAt ?? null, detail: row?.detail ?? "",
      };
    }),
    qqTestConfirmedAt,
    qqTestFresh: qqTestConfirmedAt != null && now - qqTestConfirmedAt <= inboxAcceptanceDays,
  };
}
