import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StorageProvider } from "./StorageProvider.js";

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly baseDir: string) {}

  async save(input: {
    buffer: Buffer;
    fileName: string;
    mimeType?: string;
  }): Promise<{ storageKey: string; size: number }> {
    const extension = path.extname(input.fileName).slice(0, 16);
    const storageKey = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
    const fullPath = path.join(this.baseDir, storageKey);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.buffer);
    return { storageKey, size: input.buffer.byteLength };
  }
}
