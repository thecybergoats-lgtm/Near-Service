// Sandbox / mock gateway providers (Phase 2).
// SANDBOX/MOCK ONLY: these providers NEVER call any network, never move
// real money, and label every response, log line and reference as sandbox.
// Live JazzCash/Easypaisa integration is NOT in this build — see
// docs/phase2-payments-guide.md for the merchant onboarding the owner must
// complete first. If PAYMENT_GATEWAY_MODE=live, the app refuses to boot
// (assertGatewayConfig) instead of silently falling back to sandbox.
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import {
  PaymentIntent,
  PaymentProvider,
  PaymentStatus,
  PayoutResult,
  RefundResult,
} from './gateway.interface';

export type GatewayMode = 'sandbox' | 'live';

export function gatewayMode(): GatewayMode {
  const m = (process.env.PAYMENT_GATEWAY_MODE ?? 'sandbox').toLowerCase();
  if (m !== 'sandbox' && m !== 'live') {
    throw new Error(`PAYMENT_GATEWAY_MODE must be 'sandbox' or 'live', got '${m}'`);
  }
  return m;
}

export function isSandboxMode(): boolean {
  return gatewayMode() === 'sandbox';
}

/**
 * Fail loudly at boot when live mode is requested without live merchant
 * credentials. Never silently fall back to sandbox in production.
 * Live credential env vars (see backend/.env.example + the onboarding
 * guide): JAZZCASH_LIVE_MERCHANT_ID, JAZZCASH_LIVE_PASSWORD,
 * EASYPAISA_LIVE_STORE_ID, EASYPAISA_LIVE_HASH_KEY.
 */
export function assertGatewayConfig(): void {
  const mode = gatewayMode();
  if (mode !== 'live') return;
  const missing = [
    'JAZZCASH_LIVE_MERCHANT_ID',
    'JAZZCASH_LIVE_PASSWORD',
    'EASYPAISA_LIVE_STORE_ID',
    'EASYPAISA_LIVE_HASH_KEY',
  ].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `PAYMENT_GATEWAY_MODE=live but live gateway credentials are missing: ${missing.join(', ')}. ` +
        `Complete JazzCash/Easypaisa merchant onboarding (docs/phase2-payments-guide.md) and set the ` +
        `live credentials, or run with PAYMENT_GATEWAY_MODE=sandbox. Refusing to boot — no silent sandbox fallback.`,
    );
  }
  // Credentials present, but no live provider implementation ships in this
  // build yet — that is a deliberate loud failure, not a silent mock.
  throw new Error(
    'PAYMENT_GATEWAY_MODE=live: live JazzCash/Easypaisa providers are not implemented in this build. ' +
      'Run with PAYMENT_GATEWAY_MODE=sandbox until the live integration lands (see docs/phase2-payments-guide.md).',
  );
}

/** Deterministic mock reference, e.g. JC-SANDBOX-3F9A1C2E. */
export function mockReference(prefix: string): string {
  return `${prefix}-SANDBOX-${randomUUID().slice(0, 8).toUpperCase()}`;
}

abstract class SandboxProviderBase implements PaymentProvider {
  protected readonly logger = new Logger(this.constructor.name);
  abstract readonly providerName: string;
  readonly sandbox = true;
  protected abstract refPrefix: string;

  async initiate(ref: { kind: 'job' | 'topup'; refId: string; amountPaisa: number; method: 'cash' | 'wallet' | 'jazzcash' | 'easypaisa'; phone?: string }): Promise<PaymentIntent> {
    const reference = mockReference(this.refPrefix);
    this.logger.log(`[SANDBOX/MOCK] ${this.providerName} initiate ${ref.kind} ${ref.refId} amount_paisa=${ref.amountPaisa} reference=${reference} — no real money moves`);
    return {
      intent_id: randomUUID(),
      provider: this.providerName,
      method: ref.method,
      amount_paisa: ref.amountPaisa,
      status: 'initiated',
      reference,
      sandbox: true,
    };
  }

  async confirm(intentId: string): Promise<PaymentStatus> {
    // Sandbox confirm always succeeds deterministically (mock).
    this.logger.log(`[SANDBOX/MOCK] ${this.providerName} confirm intent=${intentId} -> confirmed (mock)`);
    return { intent_id: intentId, status: 'confirmed', reference: mockReference(this.refPrefix), sandbox: true };
  }

  async refund(paymentId: string, amountPaisa: number, _reason: string): Promise<RefundResult> {
    this.logger.log(`[SANDBOX/MOCK] ${this.providerName} refund payment=${paymentId} amount_paisa=${amountPaisa} (mock)`);
    return { refund_id: mockReference(`${this.refPrefix}-REFUND`), status: 'refunded', amount_paisa: amountPaisa, sandbox: true };
  }

  async payout(walletId: string, destination: string, amountPaisa: number): Promise<PayoutResult> {
    this.logger.log(`[SANDBOX/MOCK] ${this.providerName} payout wallet=${walletId} destination=${destination} amount_paisa=${amountPaisa} (mock — no real payout)`);
    return { payout_id: mockReference(`${this.refPrefix}-PAYOUT`), status: 'initiated', amount_paisa: amountPaisa, destination, sandbox: true };
  }
}

/** Cash: the existing Phase 1 behaviour — payment is confirmed by both
 *  job parties in-app, no gateway is involved. Kept as a provider so the
 *  settlement code has one shape for every method. */
export class CashProvider extends SandboxProviderBase {
  readonly providerName = 'cash';
  protected refPrefix = 'CASH';
  override async initiate(ref: { kind: 'job' | 'topup'; refId: string; amountPaisa: number; method: 'cash' | 'wallet' | 'jazzcash' | 'easypaisa'; phone?: string }): Promise<PaymentIntent> {
    const intent = await super.initiate(ref);
    return { ...intent, status: 'pending' }; // cash settles on both-sides confirm
  }
}

export class JazzCashSandboxProvider extends SandboxProviderBase {
  readonly providerName = 'jazzcash';
  protected refPrefix = 'JC';
}

export class EasypaisaSandboxProvider extends SandboxProviderBase {
  readonly providerName = 'easypaisa';
  protected refPrefix = 'EP';
}

/** Build the provider set for the configured mode. In sandbox mode all
 *  three providers are mocks. Live mode is rejected by assertGatewayConfig
 *  before this is ever reached with live credentials. */
export function createGatewayProviders(): Record<'cash' | 'jazzcash' | 'easypaisa', PaymentProvider> {
  assertGatewayConfig();
  return {
    cash: new CashProvider(),
    jazzcash: new JazzCashSandboxProvider(),
    easypaisa: new EasypaisaSandboxProvider(),
  };
}
