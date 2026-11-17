// PaymentProvider interface (Phase 2) — PRD v1.1 p.18.
// All money is integer paisa. Every provider answers with sandbox:true
// while it is a sandbox/mock implementation; live providers must answer
// sandbox:false. No provider in this file ever touches the network.
export type GatewayMethod = 'cash' | 'wallet' | 'jazzcash' | 'easypaisa';

export type PaymentIntentStatus = 'initiated' | 'pending' | 'confirmed' | 'failed';

export interface PaymentIntent {
  intent_id: string;
  provider: string;
  method: GatewayMethod;
  amount_paisa: number;
  status: PaymentIntentStatus;
  /** Provider reference (mock in sandbox, e.g. JC-SANDBOX-<uuid8>). */
  reference: string;
  sandbox: boolean;
}

export interface PaymentStatus {
  intent_id: string;
  status: PaymentIntentStatus;
  reference: string;
  sandbox: boolean;
}

export interface RefundResult {
  refund_id: string;
  status: 'refunded' | 'failed';
  amount_paisa: number;
  sandbox: boolean;
}

export interface PayoutResult {
  payout_id: string;
  status: 'initiated' | 'failed';
  amount_paisa: number;
  destination: string;
  sandbox: boolean;
}

/** A payment provider. `initiate` starts a payment/top-up, `confirm`
 *  finalises it, `refund` returns money, `payout` moves wallet money out
 *  to a destination (bank / mobile account). */
export interface PaymentProvider {
  readonly providerName: string;
  readonly sandbox: boolean;
  initiate(ref: { kind: 'job' | 'topup'; refId: string; amountPaisa: number; method: GatewayMethod; phone?: string }): Promise<PaymentIntent>;
  confirm(intentId: string): Promise<PaymentStatus>;
  refund(paymentId: string, amountPaisa: number, reason: string): Promise<RefundResult>;
  payout(walletId: string, destination: string, amountPaisa: number): Promise<PayoutResult>;
}
