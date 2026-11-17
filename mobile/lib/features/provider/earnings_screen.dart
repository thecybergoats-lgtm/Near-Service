import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../common/widgets.dart';

/// Earnings + wallet + payout request (provider side, Phase 2).
/// Shows the single shared wallet balance, commission owed (from the
/// provider profile view of GET /wallet), the transaction list, and a
/// "top up wallet" shortcut that opens the wallet top-up flow.
/// Payouts are still Phase 2-pending on the backend and shown
/// disabled with the reason, not faked.
class EarningsScreen extends ConsumerStatefulWidget {
  const EarningsScreen({super.key});

  @override
  ConsumerState<EarningsScreen> createState() => _EarningsScreenState();
}

class _EarningsScreenState extends ConsumerState<EarningsScreen> {
  WalletInfo? _wallet;
  final List<WalletTransaction> _txns = [];
  String? _txnCursor;
  bool _loading = true;
  bool _loadingMore = false;
  bool _offline = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final wallet = await ref.read(apiClientProvider).getWallet();
      final page =
          await ref.read(apiClientProvider).getWalletTransactions(limit: 20);
      if (!mounted) return;
      setState(() {
        _wallet = wallet;
        _txns
          ..clear()
          ..addAll(page.items);
        _txnCursor = page.nextCursor;
        _offline = false;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _wallet = const WalletInfo();
        _offline = true;
        _error = e.userMessage;
        _loading = false;
      });
    }
  }

  Future<void> _loadMoreTxns() async {
    if (_txnCursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final page = await ref.read(apiClientProvider).getWalletTransactions(
            cursor: _txnCursor,
            limit: 20,
          );
      if (!mounted) return;
      setState(() {
        _txns.addAll(page.items);
        _txnCursor = page.nextCursor;
      });
    } catch (_) {
      // Keep the loaded page; pull-to-refresh retries.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = _wallet ?? const WalletInfo();
    final providerView = w.providerView;
    return Scaffold(
      appBar: AppBar(title: const Text('Earnings & wallet')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_offline) const OfflineBanner(isDemo: true),
                  if (_error != null && _txns.isEmpty)
                    ErrorState(message: _error!, onRetry: _load),
                  Card(
                    color: const Color(0xFF134E4A),
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Wallet balance',
                              style: TextStyle(color: Colors.white70)),
                          Text(Money.pkr(w.balancePkr),
                              style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 32,
                                  fontWeight: FontWeight.w800)),
                          if (providerView != null) ...[
                            Text(
                              'Earnings: ${Money.pkr(providerView.earningsPkr)}',
                              style: const TextStyle(color: Colors.white70),
                            ),
                            Text(
                              'Commission owed: ${Money.pkr(providerView.commissionOwedPkr)}',
                              style: TextStyle(
                                color: providerView.commissionOwedPkr > 0
                                    ? Colors.amber
                                    : Colors.white70,
                                fontWeight:
                                    providerView.commissionOwedPkr > 0
                                        ? FontWeight.w700
                                        : FontWeight.w400,
                              ),
                            ),
                            Text(
                              'Pending: ${Money.pkr(providerView.pendingPkr)}',
                              style: const TextStyle(color: Colors.white70),
                            ),
                          ],
                          const SizedBox(height: 8),
                          const Text(
                            'One wallet for your whole account — this is the same balance your customer profile sees.',
                            style: TextStyle(
                                color: Colors.white70, fontSize: 12),
                          ),
                          const Text(
                            'Negative balance = commission owed on cash jobs. Crossing the admin-set threshold pauses new job acceptance until you top up (PRD p.10).',
                            style: TextStyle(
                                color: Colors.white70, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: () => context
                          .push('/customer/wallet', extra: true)
                          .then((_) => _load()),
                      icon: const Icon(Icons.add),
                      label: const Text('Top up wallet'),
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'SANDBOX — no real money moves',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFFD97706)),
                  ),
                  const SizedBox(height: 16),
                  const Text('Payout',
                      style:
                          TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 8),
                  const Card(
                    child: ListTile(
                      leading: Icon(Icons.account_balance_outlined),
                      title: Text('Payouts arrive in Phase 2'),
                      subtitle: Text(
                          'JazzCash / Easypaisa / bank payout with a fee quote first.'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: null,
                      child: const Text('Request payout — Phase 2'),
                    ),
                  ),
                  const SizedBox(height: 24),
                  const Text('Transactions',
                      style:
                          TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 8),
                  if (_txns.isEmpty)
                    const Card(
                      child: ListTile(
                        title: Text('No transactions yet'),
                        subtitle: Text(
                            'Earnings, commission and top-ups will appear here.'),
                      ),
                    )
                  else
                    ..._txns.map((t) => Card(
                          child: ListTile(
                            leading: Icon(
                              t.isCredit
                                  ? Icons.arrow_downward
                                  : Icons.arrow_upward,
                              color: t.isCredit
                                  ? const Color(0xFF15803D)
                                  : const Color(0xFFDC2626),
                            ),
                            title: Text(
                                t.memo.isNotEmpty ? t.memo : t.accountCode),
                            subtitle: t.createdAt == null
                                ? null
                                : Text(
                                    t.createdAt!
                                        .toLocal()
                                        .toString()
                                        .substring(0, 16),
                                    style: const TextStyle(fontSize: 12),
                                  ),
                            trailing: Text(
                              '${t.isCredit ? '+' : '−'} ${Money.pkr(t.amountPkr)}',
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                color: t.isCredit
                                    ? const Color(0xFF15803D)
                                    : const Color(0xFFDC2626),
                              ),
                            ),
                          ),
                        )),
                  if (_txnCursor != null) ...[
                    const SizedBox(height: 8),
                    OutlinedButton(
                      onPressed: _loadingMore ? null : _loadMoreTxns,
                      child: Text(_loadingMore ? 'Loading…' : 'Load more'),
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}
