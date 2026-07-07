import { createHash } from "node:crypto";

export class HashService {
  sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }
}
