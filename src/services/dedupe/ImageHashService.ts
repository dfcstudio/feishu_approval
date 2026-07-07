import sharp from "sharp";

export class ImageHashService {
  async perceptualHash(buffer: Buffer): Promise<string | undefined> {
    try {
      const pixels = await sharp(buffer)
        .resize(8, 8, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer();
      const average = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
      let bits = "";
      for (const value of pixels) bits += value >= average ? "1" : "0";
      return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
    } catch {
      return undefined;
    }
  }

  hammingDistance(left: string, right: string): number {
    const leftBits = hexToBits(left);
    const rightBits = hexToBits(right);
    const length = Math.min(leftBits.length, rightBits.length);
    let distance = Math.abs(leftBits.length - rightBits.length);
    for (let index = 0; index < length; index += 1) {
      if (leftBits[index] !== rightBits[index]) distance += 1;
    }
    return distance;
  }
}

const hexToBits = (hex: string): string =>
  hex
    .split("")
    .map((char) => Number.parseInt(char, 16).toString(2).padStart(4, "0"))
    .join("");
