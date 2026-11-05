import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH;
}

export function hashPassword(password: string): Promise<string> {
  // Argon2 genera un salt aleatorio y lo incluye, junto con los parámetros, en el hash.
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash.startsWith('$argon2id$') || password.length > MAX_PASSWORD_LENGTH) return false;
  try { return await argon2.verify(hash, password); } catch { return false; }
}

export function temporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}
