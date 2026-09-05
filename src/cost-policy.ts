import { z } from 'zod';

// Cost is about actual liability, not whether a service uses an API key or cloud.
// These are assertions backed by current plan/account evidence, not a budget.
export const safeguardsSchema = z.object({
  newPaymentMethodRequired: z.literal(false),
  automaticCharges: z.literal(false),
  automaticPaidUpgrade: z.literal(false),
  quotaExhaustion: z.literal('stop'),
  autoRecharge: z.literal(false),
  purchases: z.literal(false),
}).strict();
export const costBasisSchema = z.enum(['free-service', 'free-tier', 'free-credits']);
export type CostBasis = z.infer<typeof costBasisSchema>;
export const noChargeSafeguards = () => safeguardsSchema.parse({
  newPaymentMethodRequired: false, automaticCharges: false, automaticPaidUpgrade: false,
  quotaExhaustion: 'stop', autoRecharge: false, purchases: false,
});
export function assertCurrentCostEvidence(basis: CostBasis, safeguards: unknown, expiresAt?: string, now = Date.now()) {
  costBasisSchema.parse(basis); safeguardsSchema.parse(safeguards);
  if (basis === 'free-credits' && !expiresAt) throw new Error('COST_UNVERIFIED: free credits require their applicable expiry and hard-stop evidence.');
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now)) throw new Error('COST_UNVERIFIED: cost evidence or free credits expired. No paid fallback is allowed.');
}
