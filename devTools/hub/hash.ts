import crypto from 'node:crypto';

/** A short content hash: the `?v=` on asset URLs */
export const hashContent = (content: string | Buffer) =>
  crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
