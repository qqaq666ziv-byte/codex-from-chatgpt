import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';

export const ASSERTION_HEADER = 'x-autodev-gateway-assertion';
export const SIGNATURE_HEADER = 'x-autodev-gateway-signature';
const assertionSchema = z.object({
  version: z.literal(1), issuer: z.string().max(2048), grant: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  issued: z.number().int().nonnegative(), expires: z.number().int().positive(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/), method: z.literal('POST'), target: z.literal('/mcp'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Assertion = z.infer<typeof assertionSchema>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = (adminToken: string) => createHmac('sha256', adminToken).update('AutoDev trusted gateway request v1').digest();
const signature = (adminToken: string, payload: string) => createHmac('sha256', key(adminToken)).update(payload).digest();

export function gatewayAssertion(adminToken: string, input: { issuer: string; grantId: string; expiresAt: string; body: string; now?: number }): Record<string, string> {
  const issued = input.now ?? Date.now();
  const assertion: Assertion = { version: 1, issuer: input.issuer, grant: input.grantId, issued,
    expires: Math.min(issued + 60_000, Date.parse(input.expiresAt)), nonce: randomBytes(16).toString('base64url'),
    method: 'POST', target: '/mcp', digest: hash(input.body) };
  const payload = Buffer.from(JSON.stringify(assertionSchema.parse(assertion))).toString('base64url');
  return { [ASSERTION_HEADER]: payload, [SIGNATURE_HEADER]: signature(adminToken, payload).toString('base64url') };
}

/** The client credential alone cannot mint a gateway review identity. */
export class GatewayIdentityVerifier {
  private readonly used = new Map<string, number>();
  constructor(private readonly adminToken: string, private readonly now = Date.now) {}
  verify(headers: IncomingHttpHeaders, method: string | undefined, target: string | undefined, body: string): string | undefined {
    const payload = headers[ASSERTION_HEADER]; const proof = headers[SIGNATURE_HEADER];
    if (payload === undefined && proof === undefined) return undefined;
    if (typeof payload !== 'string' || payload.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(payload) || typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new Error('Invalid gateway assertion.');
    if (!timingSafeEqual(signature(this.adminToken, payload), Buffer.from(proof, 'base64url'))) throw new Error('Invalid gateway assertion.');
    const assertion = assertionSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const origin = new URL(assertion.issuer);
    const now = this.now();
    if (origin.protocol !== 'https:' || origin.origin !== assertion.issuer || assertion.method !== method || assertion.target !== target ||
        assertion.digest !== hash(body) || assertion.issued > now + 5_000 || assertion.expires <= now || assertion.expires > assertion.issued + 60_000) throw new Error('Invalid gateway assertion.');
    for (const [nonce, expiry] of this.used) if (expiry <= now) this.used.delete(nonce);
    if (this.used.has(assertion.nonce) || this.used.size >= 8192) throw new Error('Gateway assertion replay or capacity limit.');
    this.used.set(assertion.nonce, assertion.expires);
    return `gateway:${hash(`${assertion.issuer}\0${assertion.grant}`)}`;
  }
}
