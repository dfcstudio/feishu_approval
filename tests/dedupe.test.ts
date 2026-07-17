import { describe, expect, it } from "vitest";
import {
  DedupeService,
  type DedupeRepository,
  type DuplicateMatchResult,
  type EvidenceSummary,
} from "../src/services/dedupe/DedupeService.js";

class FakeDedupeRepository implements DedupeRepository {
  public created: DuplicateMatchResult[] = [];

  constructor(private readonly evidence: EvidenceSummary[]) {}

  async findBySha256(): Promise<EvidenceSummary[]> {
    return this.evidence.filter((item) => item.id === "sha_match");
  }

  async findByTransactionId(): Promise<EvidenceSummary[]> {
    return this.evidence.filter((item) => item.id === "tx_match");
  }

  async findWithPerceptualHash(): Promise<(EvidenceSummary & { perceptualHash?: string | null })[]> {
    return this.evidence.filter((item) => "perceptualHash" in item) as (EvidenceSummary & { perceptualHash?: string | null })[];
  }

  async findByComposite(): Promise<EvidenceSummary[]> {
    return [];
  }

  async createDuplicateMatches(_currentEvidenceId: string, matches: DuplicateMatchResult[]): Promise<void> {
    this.created = matches;
  }
}

describe("DedupeService", () => {
  it("detects sha256 duplicates", async () => {
    const repo = new FakeDedupeRepository([{ id: "sha_match", instanceCode: "old_1" }]);
    const service = new DedupeService(repo);
    const matches = await service.findAndPersistMatches({
      currentEvidenceId: "current",
      instanceCode: "current_instance",
      sha256: "abc",
      approvalAmount: "10.00",
    });

    expect(matches).toEqual([expect.objectContaining({ matchType: "SHA256" })]);
    expect(repo.created).toHaveLength(1);
  });

  it("detects transaction id duplicates", async () => {
    const repo = new FakeDedupeRepository([{ id: "tx_match", instanceCode: "old_2" }]);
    const service = new DedupeService(repo);
    const matches = await service.findMatches({
      currentEvidenceId: "current",
      instanceCode: "current_instance",
      sha256: "abc",
      transactionId: "TX123456",
      approvalAmount: "10.00",
    });

    expect(matches).toEqual([expect.objectContaining({ matchType: "TRANSACTION_ID" })]);
  });

  it("does not flag similar layouts when OCR amounts differ", async () => {
    const repo = new FakeDedupeRepository([{
      id: "similar_layout", instanceCode: "old_3", perceptualHash: "0000000000000000",
      approvalAmount: "92.80", ocrAmount: "239.46",
    } as EvidenceSummary & { perceptualHash: string }]);
    const service = new DedupeService(repo);
    const matches = await service.findMatches({
      currentEvidenceId: "current", instanceCode: "current_instance", sha256: "new",
      perceptualHash: "0000000000000000", approvalAmount: "15.00", ocrAmount: "15.00",
    });

    expect(matches).toEqual([]);
  });
});
