import { AtomicOfferAcceptor, OfferAlreadyClosedError, AcceptState } from '../../src/modules/offers/domain/atomic-accept';
describe('atomic offer accept — concurrent accepts create exactly one job', () => {
  it('10 concurrent accepts -> 1 job, 9 conflicts', async () => {
    const acceptor = new AtomicOfferAcceptor();
    let jobCount = 0;
    let job: { id: string } | null = null;
    const state = async (): Promise<AcceptState> => ({ requestStatus: job ? 'ACCEPTED' : 'OFFERS_RECEIVED', offerStatus: job ? 'accepted' : 'pending', existingJobId: job?.id ?? null });
    const createJob = async () => { await new Promise((r) => setTimeout(r, 10)); jobCount += 1; job = { id: 'job-1' }; return job; };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => acceptor.accept('req-1', state, createJob)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(jobCount).toBe(1);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    rejected.forEach((r) => { if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(OfferAlreadyClosedError); });
  });
  it('second accept after the first committed is rejected', async () => {
    const acceptor = new AtomicOfferAcceptor();
    let job: { id: string } | null = null;
    const state = async (): Promise<AcceptState> => ({ requestStatus: job ? 'ACCEPTED' : 'OFFERS_RECEIVED', offerStatus: job ? 'accepted' : 'pending', existingJobId: job?.id ?? null });
    await acceptor.accept('req-2', state, async () => { job = { id: 'job-2' }; return job; });
    await expect(acceptor.accept('req-2', state, async () => ({ id: 'job-3' }))).rejects.toBeInstanceOf(OfferAlreadyClosedError);
  });
});
