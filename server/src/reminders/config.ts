import { createECDH, timingSafeEqual } from 'node:crypto';

export interface ReminderVapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Validate locally before SDK construction; errors never echo key material.
 * Shared environment parsing can call this helper without sending anything. */
export function validateReminderVapidConfig(input: ReminderVapidConfig): ReminderVapidConfig {
  try {
    const { subject, publicKey, privateKey } = input;
    const url = new URL(subject);
    if (
      !['https:', 'mailto:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      subject.length > 2048 ||
      (!url.pathname && !url.hostname) ||
      !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
      !/^[A-Za-z0-9_-]{43}$/.test(privateKey)
    )
      throw new Error();
    const publicBytes = Buffer.from(publicKey, 'base64url');
    const privateBytes = Buffer.from(privateKey, 'base64url');
    if (
      publicBytes.length !== 65 ||
      publicBytes[0] !== 4 ||
      privateBytes.length !== 32 ||
      publicBytes.toString('base64url') !== publicKey ||
      privateBytes.toString('base64url') !== privateKey
    )
      throw new Error();
    const curve = createECDH('prime256v1');
    curve.setPrivateKey(privateBytes); // rejects zero/out-of-range private scalars
    if (!timingSafeEqual(curve.getPublicKey(), publicBytes)) throw new Error();
    return { subject, publicKey, privateKey };
  } catch {
    throw new Error('Invalid Web Push reminder configuration.');
  }
}
