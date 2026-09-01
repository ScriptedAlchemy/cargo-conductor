import { randomBytes } from 'node:crypto';

export const shortId = (): string => randomBytes(6).toString('hex');
