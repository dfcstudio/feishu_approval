import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { ImageHashService } from "./ImageHashService.js";
import { moneyEquals } from "../../utils/money.js";

export type DuplicateMatchType = "SHA256" | "PERCEPTUAL_HASH" | "TRANSACTION_ID" | "COMPOSITE";

export interface EvidenceSummary {
  id: string;
  instanceCode: string;
  applicantName?: string | null;
  approvalAmount?: unknown;
  ocrAmount?: unknown;
  createdAt?: Date;
}

export interface DuplicateMatchResult {
  matchedEvidence: EvidenceSummary;
  matchType: DuplicateMatchType;
  score: number;
  reason: string;
}

export interface DedupeInput {
  currentEvidenceId: string;
  instanceCode: string;
  sha256: string;
  transactionId?: string | null;
  perceptualHash?: string | null;
  approvalAmount: string;
  ocrAmount?: string | null;
  paidAt?: Date | null;
  payee?: string | null;
}

export interface DedupeRepository {
  findBySha256(sha256: string, excludeId: string, excludeInstanceCode: string): Promise<EvidenceSummary[]>;
  findByTransactionId(transactionId: string, excludeId: string, excludeInstanceCode: string): Promise<EvidenceSummary[]>;
  findWithPerceptualHash(excludeId: string, excludeInstanceCode: string): Promise<(EvidenceSummary & { perceptualHash?: string | null })[]>;
  findByComposite(input: {
    approvalAmount: string;
    paidAt: Date;
    payee: string;
    excludeId: string;
    excludeInstanceCode: string;
  }): Promise<EvidenceSummary[]>;
  createDuplicateMatches(currentEvidenceId: string, matches: DuplicateMatchResult[]): Promise<void>;
}

export class PrismaDedupeRepository implements DedupeRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  private async approvedInstanceCodes(excludeInstanceCode: string): Promise<string[]> {
    const runs = await this.client.approvalAuditRun.findMany({
      where: { requestedStatus: { equals: "APPROVED", mode: "insensitive" }, instanceCode: { not: excludeInstanceCode } },
      select: { instanceCode: true },
    });
    return runs.map((run) => run.instanceCode);
  }

  async findBySha256(sha256: string, excludeId: string, excludeInstanceCode: string): Promise<EvidenceSummary[]> {
    const approvedInstanceCodes = await this.approvedInstanceCodes(excludeInstanceCode);
    if (!approvedInstanceCodes.length) return [];
    return this.client.paymentEvidence.findMany({
      where: { sha256, id: { not: excludeId }, instanceCode: { in: approvedInstanceCodes } },
      select: summarySelect,
      take: 20,
    });
  }

  async findByTransactionId(transactionId: string, excludeId: string, excludeInstanceCode: string): Promise<EvidenceSummary[]> {
    const approvedInstanceCodes = await this.approvedInstanceCodes(excludeInstanceCode);
    if (!approvedInstanceCodes.length) return [];
    return this.client.paymentEvidence.findMany({
      where: { transactionId, id: { not: excludeId }, instanceCode: { in: approvedInstanceCodes } },
      select: summarySelect,
      take: 20,
    });
  }

  async findWithPerceptualHash(excludeId: string, excludeInstanceCode: string): Promise<(EvidenceSummary & { perceptualHash?: string | null })[]> {
    const approvedInstanceCodes = await this.approvedInstanceCodes(excludeInstanceCode);
    if (!approvedInstanceCodes.length) return [];
    return this.client.paymentEvidence.findMany({
      where: { perceptualHash: { not: null }, id: { not: excludeId }, instanceCode: { in: approvedInstanceCodes } },
      select: { ...summarySelect, perceptualHash: true },
      take: 500,
    });
  }

  async findByComposite(input: {
    approvalAmount: string;
    paidAt: Date;
    payee: string;
    excludeId: string;
    excludeInstanceCode: string;
  }): Promise<EvidenceSummary[]> {
    const approvedInstanceCodes = await this.approvedInstanceCodes(input.excludeInstanceCode);
    if (!approvedInstanceCodes.length) return [];
    const start = new Date(input.paidAt);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return this.client.paymentEvidence.findMany({
      where: {
        id: { not: input.excludeId },
        instanceCode: { in: approvedInstanceCodes },
        approvalAmount: input.approvalAmount,
        paidAt: { gte: start, lt: end },
        payee: input.payee,
      },
      select: summarySelect,
      take: 20,
    });
  }

  async createDuplicateMatches(currentEvidenceId: string, matches: DuplicateMatchResult[]): Promise<void> {
    if (matches.length === 0) return;
    await this.client.duplicateMatch.createMany({
      data: matches.map((match) => ({
        currentEvidenceId,
        matchedEvidenceId: match.matchedEvidence.id,
        matchType: match.matchType,
        score: match.score,
        reason: match.reason,
      })),
      skipDuplicates: true,
    });
  }
}

export class DedupeService {
  constructor(
    private readonly repository: DedupeRepository = new PrismaDedupeRepository(),
    private readonly imageHashService = new ImageHashService(),
    private readonly perceptualHashThreshold = env.PERCEPTUAL_HASH_DISTANCE_THRESHOLD,
  ) {}

  async findAndPersistMatches(input: DedupeInput): Promise<DuplicateMatchResult[]> {
    const matches = await this.findMatches(input);
    await this.repository.createDuplicateMatches(input.currentEvidenceId, matches);
    return matches;
  }

  async findMatches(input: DedupeInput): Promise<DuplicateMatchResult[]> {
    const results = new Map<string, DuplicateMatchResult>();

    const add = (match: DuplicateMatchResult) => {
      const key = `${match.matchType}:${match.matchedEvidence.id}`;
      results.set(key, match);
    };

    for (const matchedEvidence of await this.repository.findBySha256(input.sha256, input.currentEvidenceId, input.instanceCode)) {
      add({ matchedEvidence, matchType: "SHA256", score: 1, reason: "原始文件 SHA-256 完全一致" });
    }

    if (input.transactionId) {
      for (const matchedEvidence of await this.repository.findByTransactionId(
        input.transactionId,
        input.currentEvidenceId,
        input.instanceCode,
      )) {
        add({ matchedEvidence, matchType: "TRANSACTION_ID", score: 1, reason: "交易流水号完全一致" });
      }
    }

    if (input.perceptualHash) {
      const candidates = await this.repository.findWithPerceptualHash(input.currentEvidenceId, input.instanceCode);
      for (const candidate of candidates) {
        if (!candidate.perceptualHash) continue;
        const currentAmount = input.ocrAmount ?? input.approvalAmount;
        const candidateAmount = candidate.ocrAmount ?? candidate.approvalAmount;
        if (candidateAmount === null || candidateAmount === undefined || !moneyEquals(currentAmount, String(candidateAmount))) {
          continue;
        }
        const distance = this.imageHashService.hammingDistance(input.perceptualHash, candidate.perceptualHash);
        if (distance <= this.perceptualHashThreshold) {
          add({
            matchedEvidence: candidate,
            matchType: "PERCEPTUAL_HASH",
            score: 1 - distance / 64,
            reason: `图片感知 hash 距离 ${distance}，低于阈值 ${this.perceptualHashThreshold}`,
          });
        }
      }
    }

    if (input.paidAt && input.payee) {
      for (const matchedEvidence of await this.repository.findByComposite({
        approvalAmount: input.approvalAmount,
        paidAt: input.paidAt,
        payee: input.payee,
        excludeId: input.currentEvidenceId,
        excludeInstanceCode: input.instanceCode,
      })) {
        add({
          matchedEvidence,
          matchType: "COMPOSITE",
          score: 0.75,
          reason: "金额、付款日期、收款方组合一致",
        });
      }
    }

    return [...results.values()];
  }
}

const summarySelect = {
  id: true,
  instanceCode: true,
  applicantName: true,
  approvalAmount: true,
  ocrAmount: true,
  createdAt: true,
} as const;
