// Minimal bech32 (BIP-173) implementation, matching the variant age uses.
// age encodes X25519 secret scalars with hrp "age-secret-key-" (the encoded
// identity is then uppercased) and public keys with hrp "age".

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let checksum = 1;

  for (const value of values) {
    const top = checksum >> 25;

    checksum = ((checksum & 0x1ffffff) << 5) ^ value;

    for (let index = 0; index < 5; index += 1) {
      if (((top >> index) & 1) !== 0) {
        checksum ^= GEN[index];
      }
    }
  }

  return checksum;
}

function hrpExpand(hrp: string): number[] {
  const result: number[] = [];

  for (const character of hrp) {
    result.push(character.charCodeAt(0) >> 5);
  }

  result.push(0);

  for (const character of hrp) {
    result.push(character.charCodeAt(0) & 31);
  }

  return result;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(values) ^ 1;

  const result: number[] = [];

  for (let index = 0; index < 6; index += 1) {
    result.push((checksum >> (5 * (5 - index))) & 31);
  }

  return result;
}

function convertBits(
  data: Uint8Array,
  fromBits: number,
  toBits: number,
): number[] {
  let accumulator = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  const result: number[] = [];

  for (const value of data) {
    if (value >> fromBits !== 0) {
      throw new Error("Invalid byte for bech32 input width");
    }

    accumulator = ((accumulator << fromBits) | value) & maxAccumulator;
    bits += fromBits;

    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >> bits) & maxv);
    }
  }

  if (bits > 0) {
    result.push((accumulator << (toBits - bits)) & maxv);
  }

  return result;
}

/**
 * Encode a 32-byte value as a bech32 string for the given human-readable part.
 *
 * @param hrp Human-readable part (lowercase).
 * @param data 32 raw bytes.
 */
export function bech32Encode(hrp: string, data: Uint8Array): string {
  const values = convertBits(data, 8, 5);

  return (
    hrp +
    "1" +
    values
      .concat(createChecksum(hrp, values))
      .map((value) => CHARSET[value])
      .join("")
  );
}
