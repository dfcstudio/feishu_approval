export interface StorageProvider {
  save(input: {
    buffer: Buffer;
    fileName: string;
    mimeType?: string;
  }): Promise<{ storageKey: string; size: number }>;
}
