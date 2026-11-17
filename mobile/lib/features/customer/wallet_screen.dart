import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../common/widgets.dart';

/// Wallet (PRD p.10, Phase 2): real balance from GET /wallet with a
/// customer/provider profile-view toggle over the SAME single wallet,
/// cursor-paginated transactions from GET /wallet/transactions, and a
/// sandbox top-up flow (JazzCash / Easypaisa). The sandbox badge is
/// shown on every top-up step — no real money moves. Referral code,
/// referred count and credit live here too (GET /referrals/me).
class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key, this.startTopUp = false});

  /// When true (e.g. opened from Earnings), open the top-up sheet at once.
  final bool startTopUp;

  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  WalletInfo? _wallet;
  ReferralInfo? _referral;
  final List<WalletTransaction> _txns = [];
  String? _txnCursor;
  bool _loading = true;
  bool _loadingMore = false;
  bool _offline = false;
  bool _isDemo = false;
  String? _error;
  String _profileView = 'customer'; // customer | provider — view only

  @override
  void initState() {
    super.initState();
    _load().then((_) {
      if (widget.startTopUp && mounted) _showTopUpSheet();
    });
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final wallet = await ref.read(apiClientProvider).getWallet();
      ReferralInfo? referral;
      try {
        referral = await ref.read(apiClientProvider).getReferral();
      } catch (_) {
        referral = null; // Referrals are optional; wallet still shows.
      }
      final page =
          await ref.read(apiClientProvider).getWalletTransactions(limit: 20);
      if (!mounted) return;
      setState(() {
        _wallet = wallet;
        _referral = referral;
        _txns
          ..clear()
          ..addAll(page.items);
        _txnCursor = page.nextCursor;
        _offline = false;
        _isDemo = false;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _wallet = const WalletInfo();
        _offline = true;
        _isDemo = e is NetworkException;
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
      // Keep the loaded page; the user can retry by pulling to refresh.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  WalletProfileView? get _activeView => _profileView == 'provider'
      ? _wallet?.providerView
      : _wallet?.customerView;

  Future<void> _showTopUpSheet() async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const TopUpSheet(),
    );
    if (result == true && mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    final w = _wallet ?? const WalletInfo();
    final view = _activeView;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Wallet'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
            onPressed: _load,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_offline) OfflineBanner(isDemo: _isDemo),
                  if (_error != null && !_offline)
                    ErrorState(message: _error!, onRetry: _load),
                  Card(
                    color: const Color(0xFF134E4A),
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text('Wallet balance',
                                  style: TextStyle(color: Colors.white70)),
                              // Profile-view toggle: same wallet, two views.
                              SegmentedButton<String>(
                                segments: const [
                                  ButtonSegment(
                                      value: 'customer',
                                      label: Text('Customer',
                                          style: TextStyle(fontSize: 12))),
                                  ButtonSegment(
                                      value: 'provider',
                                      label: Text('Provider',
                                          style: TextStyle(fontSize: 12))),
                                ],
                                selected: {_profileView},
                                onSelectionChanged: (s) =>
                                    setState(() => _profileView = s.first),
                                style: SegmentedButton.styleFrom(
                                  selectedBackgroundColor: Colors.white24,
                                  selectedForegroundColor: Colors.white,
                                  foregroundColor: Colors.white70,
                                ),
                              ),
                            ],
                          ),
                          Text(
                            Money.pkr(w.balancePkr),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 32,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          if (w.isNegative)
                            const Text(
                              'Negative balance = commission owed on cash jobs. Top up to keep accepting jobs.',
                              style: TextStyle(color: Colors.amber, fontSize: 12),
                            ),
                          Text(
                            'Escrow held: ${Money.pkr(w.escrowHeldPaisa ~/ 100)}',
                            style: const TextStyle(color: Colors.white70),
                          ),
                          if (view != null) ...[
                            const SizedBox(height: 4),
                            Text(
                              _profileView == 'provider'
                                  ? 'Earnings: ${Money.pkr(view.earningsPkr)} · Commission owed: ${Money.pkr(view.commissionOwedPkr)} · Pending: ${Money.pkr(view.pendingPkr)}'
                                  : 'Spent: ${Money.pkr(view.spentPkr)} · Pending: ${Money.pkr(view.pendingPkr)}',
                              style: const TextStyle(
                                  color: Colors.white70, fontSize: 12),
                            ),
                          ],
                          const SizedBox(height: 8),
                          const Text(
                            'One wallet for your whole account — this same balance is shared across your customer and provider profiles.',
                            style: TextStyle(color: Colors.white70, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: _showTopUpSheet,
                      icon: const Icon(Icons.add),
                      label: const Text('Top up via JazzCash / Easypaisa'),
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
                  const Text('Transactions',
                      style:
                          TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 8),
                  if (_txns.isEmpty)
                    const Card(
                      child: ListTile(
                        title: Text('No transactions yet'),
                        subtitle: Text(
                            'Top-ups, payments and credits will appear here.'),
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
                            subtitle: Text(
                              [
                                if (t.txnId.isNotEmpty) t.txnId,
                                if (t.createdAt != null)
                                  t.createdAt!.toLocal().toString().substring(0, 16),
                              ].join(' · '),
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
                  const SizedBox(height: 24),
                  const Text('Referral',
                      style:
                          TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 8),
                  ReferralCard(referral: _referral, onClaimed: _load),
                  const SizedBox(height: 16),
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.local_offer_outlined),
                      title: const Text('First job discount'),
                      subtitle: const Text(
                          'Try code FIRSTJOB at payment on your first job.'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.push('/customer/history'),
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}

/// Referral card: own code + referred count + credit, and a claim field
/// for someone else's code. Used on the wallet screen and in settings.
class ReferralCard extends ConsumerStatefulWidget {
  const ReferralCard({super.key, required this.referral, this.onClaimed});

  final ReferralInfo? referral;
  final VoidCallback? onClaimed;

  @override
  ConsumerState<ReferralCard> createState() => _ReferralCardState();
}

class _ReferralCardState extends ConsumerState<ReferralCard> {
  final _claimController = TextEditingController();
  bool _claiming = false;
  String? _claimMessage;

  Future<void> _claim() async {
    final code = _claimController.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _claiming = true;
      _claimMessage = null;
    });
    try {
      await ref.read(apiClientProvider).claimReferral(code);
      setState(() => _claimMessage = 'Code claimed. Credit applies on your first completed job.');
      widget.onClaimed?.call();
    } on ApiException catch (e) {
      setState(() => _claimMessage = e.userMessage);
    } finally {
      if (mounted) setState(() => _claiming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.referral;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Your referral code',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                if (r != null && r.code.isNotEmpty)
                  Chip(
                    label: Text(r.code,
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                  )
                else
                  const Text('—', style: TextStyle(color: Colors.grey)),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              r == null
                  ? 'Referral details are unavailable right now.'
                  : 'Friends joined: ${r.referredCount} · Credit earned: ${Money.pkr(r.creditPkr)} · Pending: ${r.pendingCount}',
              style: const TextStyle(color: Colors.grey, fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _claimController,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Have a referral code? Enter it here',
                hintText: 'e.g. ALI123',
              ),
            ),
            const SizedBox(height: 8),
            if (_claimMessage != null)
              Text(_claimMessage!,
                  style: const TextStyle(color: Colors.grey, fontSize: 13)),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: _claiming ? null : _claim,
                child: const Text('Claim'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Sandbox top-up sheet: method picker (JazzCash / Easypaisa), amount,
/// phone → POST /wallet/topup → confirm step → POST
/// /wallet/topup/confirm. The SANDBOX badge is shown at the top and
/// again on the confirm button — this is a test payment, never live.
class TopUpSheet extends ConsumerStatefulWidget {
  const TopUpSheet({super.key});

  @override
  ConsumerState<TopUpSheet> createState() => _TopUpSheetState();
}

class _TopUpSheetState extends ConsumerState<TopUpSheet> {
  String _method = 'jazzcash';
  final _amountController = TextEditingController(text: '1000');
  final _phoneController = TextEditingController();
  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _started; // POST /wallet/topup response

  Future<void> _start() async {
    final amount = Money.tryParse(_amountController.text);
    final phone = _phoneController.text.trim();
    if (amount == null) {
      setState(() => _error = 'Enter an amount in PKR.');
      return;
    }
    if (phone.length < 10) {
      setState(() => _error = 'Enter your JazzCash / Easypaisa mobile number.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).topUpWallet(
            method: _method,
            amountPkr: amount,
            phone: phone,
          );
      setState(() => _started = res);
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirm() async {
    final paymentId = (_started?['payment_id'] ?? '').toString();
    if (paymentId.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).confirmTopUp(paymentId);
      if (mounted) Navigator.pop(context, true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Wallet topped up (sandbox).')),
        );
      }
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final amount = Money.tryParse(_amountController.text) ?? 0;
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: ListView(
        shrinkWrap: true,
        children: [
          const Row(
            children: [
              Icon(Icons.warning_amber_rounded, color: Color(0xFFD97706)),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'SANDBOX — no real money moves',
                  style: TextStyle(
                      fontWeight: FontWeight.w800, color: Color(0xFFD97706)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            'Sandbox top-up via JazzCash / Easypaisa. This is a test payment — no real money moves and no real charge is made.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 16),
          if (_started == null) ...[
            const Text('Method', style: TextStyle(fontWeight: FontWeight.w700)),
            RadioListTile<String>(
              title: const Text('JazzCash'),
              value: 'jazzcash',
              groupValue: _method,
              onChanged: (v) => setState(() => _method = v!),
            ),
            RadioListTile<String>(
              title: const Text('Easypaisa'),
              value: 'easypaisa',
              groupValue: _method,
              onChanged: (v) => setState(() => _method = v!),
            ),
            TextField(
              controller: _amountController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                  labelText: 'Amount (PKR)', prefixIcon: Icon(Icons.payments_outlined)),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                  labelText: 'Mobile number (JazzCash / Easypaisa account)',
                  prefixText: '+92 '),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _busy ? null : _start,
                child: Text(_busy
                    ? 'Starting…'
                    : 'Start sandbox top-up — ${Money.pkr(amount)}'),
              ),
            ),
          ] else ...[
            Card(
              child: ListTile(
                title: Text(
                    'Reference: ${(_started!['reference'] ?? _started!['payment_id'] ?? '').toString()}'),
                subtitle: Text(
                    'Provider: ${(_started!['provider'] ?? _method).toString()} · Status: ${(_started!['status'] ?? 'pending').toString()}'),
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Confirm below to credit your wallet. Sandbox only — nothing is charged.',
              style: TextStyle(color: Colors.grey, fontSize: 13),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _busy ? null : _confirm,
                child: Text(_busy
                    ? 'Confirming…'
                    : 'Confirm sandbox top-up — ${Money.pkr(amount)}'),
              ),
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => setState(() => _started = null),
              child: const Text('Back'),
            ),
          ],
        ],
      ),
    );
  }
}
