export interface PaymentOCRResult {
  rawText: string;
  amount?: string;
  transactionId?: string;
  paidAt?: string;
  payee?: string;
  confidence: number;
}

export interface OCRProvider {
  recognizePaymentEvidence(input: {
    fileBuffer: Buffer;
    fileName: string;
    mimeType?: string;
  }): Promise<PaymentOCRResult>;
}
