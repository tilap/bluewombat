/**
 * Read stdin until EOF, stopping once the byte ceiling is exceeded so a huge
 * document cannot fill memory. The returned string is oversized by at most one
 * chunk slice (maxBytes + 1), enough for the size check to refuse.
 */
export async function readStdinLimited(
  maxBytes: number,
  input: AsyncIterable<string | Buffer> = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size >= maxBytes + 1) {
      break;
    }
    const remaining = maxBytes + 1 - size;
    if (buf.length <= remaining) {
      chunks.push(buf);
      size += buf.length;
    } else {
      chunks.push(buf.subarray(0, remaining));
      size += remaining;
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
