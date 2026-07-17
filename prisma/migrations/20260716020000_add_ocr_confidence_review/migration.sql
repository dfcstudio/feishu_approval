ALTER TABLE "payment_evidences"
  ADD COLUMN "ocrConfidenceScore" INTEGER,
  ADD COLUMN "ocrReviewStorageKey" TEXT;

UPDATE "payment_evidences"
SET "ocrConfidenceScore" = GREATEST(1, LEAST(5, CEIL("ocrConfidence" * 5)::INTEGER));

ALTER TABLE "payment_evidences"
  ALTER COLUMN "ocrConfidenceScore" SET NOT NULL;
