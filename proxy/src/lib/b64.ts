export const b64u = {
  encode(buf: Uint8Array): string {
    return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64url');
  },
  decode(s: string): Buffer {
    return Buffer.from(s, 'base64url');
  },
};
