// Atomic offer acceptance — the concurrency-critical core (PRD p.7).
// Pure, DB-free logic so it is unit-testable: the caller holds the Redis
// lock + DB transaction; this class additionally serialises concurrent
// accept attempts for the same request in-process so a double-tap / retry
// can never create two jobs. Production layering:
//   Redis lock (lock:offer-accept:{offerId}) -> DB txn (SELECT ... FOR UPDATE)
//   -> AtomicOfferAcceptor.accept() -> commit.
export interface AcceptState {
  requestStatus: string;
  offerStatus: string;
  existingJobId: string | null;
}
export class OfferAlreadyClosedError extends Error { constructor() { super('OFFER_ALREADY_CLOSED'); } }
export class AtomicOfferAcceptor {
  private tails = new Map<string, Promise<void>>();
  /** Serialises accepts per request id. `createJob` runs at most once per
   *  request: concurrent callers queue behind the first attempt and then
   *  re-check state, so exactly one job is created. */
  async accept<T>(requestId: string, state: () => Promise<AcceptState>, createJob: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(requestId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.tails.set(requestId, prev.then(() => mine));
    await prev;
    try {
      const s = await state();
      if (s.existingJobId || s.requestStatus === 'ACCEPTED') throw new OfferAlreadyClosedError();
      if (s.offerStatus !== 'pending') throw new OfferAlreadyClosedError();
      return await createJob();
    } finally {
      release();
      if (this.tails.get(requestId) === prev.then(() => mine)) this.tails.delete(requestId);
    }
  }
}
