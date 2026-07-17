import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApprovalAuditJobService } from "../src/services/jobs/ApprovalAuditJobService.js";
import { FeishuNotifyService } from "../src/services/notify/FeishuNotifyService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const prefix = `concurrency-${process.pid}-${Date.now()}`;
const db = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : undefined;

integration("PostgreSQL queue concurrency", () => {
  beforeAll(async () => { await db!.$connect(); });
  afterAll(async () => {
    await db!.notificationOutbox.deleteMany({ where: { dedupeKey: { startsWith: prefix } } });
    await db!.approvalAuditRun.deleteMany({ where: { instanceCode: { startsWith: prefix } } });
    await db!.$disconnect();
  });

  it("allows only one job worker to claim a queued audit", async () => {
    const instanceCode = `${prefix}-job-claim`;
    await db!.approvalAuditRun.create({ data: { instanceCode, status: "QUEUED" } });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const audit = vi.fn(async () => { await blocked; return { skipped: false, evidenceIds: [] }; });
    const processor = { audit } as never;
    const config = { AUDIT_WORKER_POLL_MS: 1000, AUDIT_JOB_LEASE_SECONDS: 30, AUDIT_JOB_MAX_RETRIES: 3 };
    const first = new ApprovalAuditJobService(db!, processor, config);
    const second = new ApprovalAuditJobService(db!, processor, config);

    const attempts = [first.processNext(), second.processNext()];
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    release();
    await Promise.all(attempts);

    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("recovers an audit whose processing lease expired", async () => {
    const instanceCode = `${prefix}-job-recovery`;
    await db!.approvalAuditRun.create({ data: {
      instanceCode, status: "PROCESSING", leaseOwner: "dead-worker",
      leaseUntil: new Date(Date.now() - 1000),
    } });
    const audit = vi.fn().mockResolvedValue({ skipped: false, evidenceIds: [] });
    const worker = new ApprovalAuditJobService(db!, { audit } as never, {
      AUDIT_WORKER_POLL_MS: 1000, AUDIT_JOB_LEASE_SECONDS: 30, AUDIT_JOB_MAX_RETRIES: 3,
    });

    expect(await worker.processNext()).toBe(true);
    expect(audit).toHaveBeenCalledWith(instanceCode, true, undefined);
  });

  it("allows only one outbox worker to deliver a pending notification", async () => {
    const dedupeKey = `${prefix}-outbox-claim`;
    await db!.notificationOutbox.create({ data: {
      kind: "FEISHU_INTERACTIVE", dedupeKey, receiveIdType: "open_id", receiveId: "ou_test",
      payload: { receiveIdType: "open_id", receiveId: "ou_test", card: {} },
    } });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sendInteractiveCard = vi.fn(async () => { await blocked; });
    const client = { sendInteractiveCard } as never;
    const config = { FEISHU_NOTIFY_RECEIVE_ID_TYPE: "open_id", FEISHU_NOTIFY_RECEIVE_ID: "ou_test", FEISHU_APPROVAL_DETAIL_URL_TEMPLATE: "https://example.test/{instanceCode}" } as const;
    const first = new FeishuNotifyService(client, config, db!);
    const second = new FeishuNotifyService(client, config, db!);

    const attempts = [first.processNext(), second.processNext()];
    await vi.waitFor(() => expect(sendInteractiveCard).toHaveBeenCalledTimes(1));
    release();
    await Promise.all(attempts);

    expect(sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect((await db!.notificationOutbox.findUnique({ where: { dedupeKey } }))?.status).toBe("SENT");
  });

  it("recovers an outbox item whose sending lease expired", async () => {
    const dedupeKey = `${prefix}-outbox-recovery`;
    await db!.notificationOutbox.create({ data: {
      kind: "FEISHU_INTERACTIVE", dedupeKey, receiveIdType: "open_id", receiveId: "ou_test",
      status: "SENDING", leaseUntil: new Date(Date.now() - 1000),
      payload: { receiveIdType: "open_id", receiveId: "ou_test", card: {} },
    } });
    const sendInteractiveCard = vi.fn().mockResolvedValue(undefined);
    const service = new FeishuNotifyService({ sendInteractiveCard } as never, {
      FEISHU_NOTIFY_RECEIVE_ID_TYPE: "open_id", FEISHU_NOTIFY_RECEIVE_ID: "ou_test",
      FEISHU_APPROVAL_DETAIL_URL_TEMPLATE: "https://example.test/{instanceCode}",
    }, db!);

    expect(await service.processNext()).toBe(true);
    expect(sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect((await db!.notificationOutbox.findUnique({ where: { dedupeKey } }))?.status).toBe("SENT");
  });
});
