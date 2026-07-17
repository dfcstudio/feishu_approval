import { describe, expect, it, vi } from "vitest";
import { ApprovalAuditJobService } from "../src/services/jobs/ApprovalAuditJobService.js";
import { FeishuNotifyService } from "../src/services/notify/FeishuNotifyService.js";

describe("poller shutdown", () => {
  it("does not replace the approved phase with a later completion status", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const worker = new ApprovalAuditJobService({ approvalAuditRun: { updateMany } } as never, {} as never, {
      AUDIT_WORKER_POLL_MS: 1000, AUDIT_JOB_LEASE_SECONDS: 30, AUDIT_JOB_MAX_RETRIES: 3,
    });

    await worker.recordStatus("instance-1", "COMPLETED");

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        instanceCode: "instance-1",
        OR: [{ requestedStatus: null }, { requestedStatus: { not: "APPROVED" } }],
      },
      data: { requestedStatus: "COMPLETED" },
    });
  });

  it("waits for an in-flight audit job", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const db = {
      approvalAuditRun: {
        findFirst: vi.fn().mockResolvedValue({ id: "job-1", instanceCode: "instance-1", saveFiles: true, requestedStatus: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const processor = { audit: vi.fn(async () => { await blocked; }) };
    const worker = new ApprovalAuditJobService(db as never, processor as never, {
      AUDIT_WORKER_POLL_MS: 1000, AUDIT_JOB_LEASE_SECONDS: 30, AUDIT_JOB_MAX_RETRIES: 3,
    });
    worker.start();
    await vi.waitFor(() => expect(processor.audit).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = worker.stopAndWait().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("waits for an in-flight outbox delivery", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const db = {
      notificationOutbox: {
        findFirst: vi.fn().mockResolvedValue({
          id: "outbox-1", payload: { receiveIdType: "open_id", receiveId: "ou_test", card: {} },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const client = { sendInteractiveCard: vi.fn(async () => { await blocked; }) };
    const service = new FeishuNotifyService(client as never, {
      FEISHU_NOTIFY_RECEIVE_ID_TYPE: "open_id", FEISHU_NOTIFY_RECEIVE_ID: "ou_test",
      FEISHU_APPROVAL_DETAIL_URL_TEMPLATE: "https://example.test/{instanceCode}",
    }, db as never);
    const processing = service.processNext();
    await vi.waitFor(() => expect(client.sendInteractiveCard).toHaveBeenCalledOnce());

    let idle = false;
    const waiting = service.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await Promise.all([processing, waiting]);
    expect(idle).toBe(true);
  });
});
