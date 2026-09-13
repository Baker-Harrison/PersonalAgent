/** Small, dependency-free security helpers shared by the desktop boundary. */
export const LOCAL_ORIGIN = 'http://127.0.0.1';

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      (url.port === '' || url.port === '80');
  } catch { return false; }
}

export function safeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 256 && /^[A-Za-z0-9._~-]+$/.test(value);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
