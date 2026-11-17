import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import 'wallet_screen.dart';

/// Payment (PRD p.10, Phase 2): cash (unchanged), wallet (with balance
/// check + promo code validated before confirming), and JazzCash /
/// Easypaisa shown ONLY as "top up wallet via … (sandbox)" — never
/// presented as a live payment. Wallet payment calls
/// POST /jobs/{id}/pay-wallet; a 409 INSUFFICIENT_WALLET_BALANCE
/// surfaces the top-up action instead of failing silently.
class PaymentScreen extends ConsumerStatefulWidget {
  const PaymentScreen({super.key, required this.jobId, this.job});

  final String jobId;
  final Job? job;

  @override
  ConsumerState<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends ConsumerState<PaymentScreen> {
  String _method = 'cash';
  WalletInfo? _wallet;
  List<PaymentMethodInfo> _methods = [];
  bool _loadingMethods = true;
  bool _paid = false;
  bool _submitting = false;
  String? _error;
  String _paidMethod = 'cash';

  final _promoController = TextEditingController();
  PromoValidation? _promo;
  bool _validatingPromo = false;
  String? _promoMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final wallet = await ref.read(apiClientProvider).getWallet();
      List<PaymentMethodInfo> methods;
      try {
        methods = await ref.read(apiClientProvider).getPaymentMethods();
      } catch (_) {
        // Fall back to the known Phase 2 method set; cash always works.
        methods = const [
          PaymentMethodInfo(id: 'cash'),
          PaymentMethodInfo(id: 'wallet'),
          PaymentMethodInfo(id: 'jazzcash', sandbox: true),
          PaymentMethodInfo(id: 'easypaisa', sandbox: true),
        ];
      }
      if (mounted) {
        setState(() {
          _wallet = wallet;
          _methods = methods;
          _loadingMethods = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _wallet = const WalletInfo();
          _methods = const [
            PaymentMethodInfo(id: 'cash'),
            PaymentMethodInfo(id: 'wallet'),
            PaymentMethodInfo(id: 'jazzcash', sandbox: true),
            PaymentMethodInfo(id: 'easypaisa', sandbox: true),
          ];
          _loadingMethods = false;
        });
      }
    }
  }

  int get _amount => widget.job?.agreedPrice ?? 0;
  int get _discountPkr => _promo != null && _promo!.valid ? _promo!.discountPkr : 0;
  int get _payable => (_amount - _discountPkr).clamp(0, 1000000000);
  bool get _walletShort =>
      _method == 'wallet' && (_wallet?.balancePkr ?? 0) < _payable;

  bool _methodAvailable(String id) =>
      _methods.isEmpty || _methods.any((m) => m.id == id);

  Future<void> _validatePromo() async {
    final code = _promoController.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _validatingPromo = true;
      _promoMessage = null;
    });
    try {
      final result = await ref.read(apiClientProvider).validatePromo(
            code: code,
            amountPkr: _amount,
          );
      setState(() {
        _promo = result;
        _promoMessage = result.valid
            ? 'Promo applied — you save ${Money.pkr(result.discountPkr)}.'
            : (result.reason ?? 'This promo code is not valid for this job.');
      });
    } on ApiException catch (e) {
      setState(() {
        _promo = null;
        _promoMessage = e.userMessage;
      });
    } finally {
      if (mounted) setState(() => _validatingPromo = false);
    }
  }

  Future<void> _confirm() async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      if (_method == 'wallet') {
        await ref.read(apiClientProvider).payJobWithWallet(
              widget.jobId,
              promoCode: _promo != null && _promo!.valid
                  ? _promoController.text.trim()
                  : null,
            );
        _paidMethod = 'wallet';
      } else {
        // Cash — unchanged Phase 1 behaviour.
        await ref.read(apiClientProvider).confirmPayment(widget.jobId);
        _paidMethod = 'cash';
      }
      setState(() => _paid = true);
    } on ApiException catch (e) {
      if (e.code == 'INSUFFICIENT_WALLET_BALANCE' || e.statusCode == 409) {
        setState(() => _error =
            'Wallet balance is not enough. Top up your wallet or pay in cash.');
      } else {
        setState(() => _error = e.userMessage);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _topUpThenRetry() async {
    final toppedUp = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const TopUpSheet(),
    );
    if (toppedUp == true && mounted) {
      await _load();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Wallet topped up — you can pay with wallet now.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_paid) {
      return Scaffold(
        appBar: AppBar(title: const Text('Receipt')),
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.receipt_long, size: 64, color: Color(0xFF15803D)),
              const SizedBox(height: 16),
              const Text('Payment settled',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text('Paid: ${Money.pkr(_payable)}',
                  style: const TextStyle(fontSize: 18)),
              if (_discountPkr > 0)
                Text('Promo saved you ${Money.pkr(_discountPkr)}',
                    style: const TextStyle(color: Color(0xFF15803D))),
              Text('Job: ${widget.jobId}'),
              Text('Method: ${_paidMethod == 'wallet' ? 'Wallet' : 'Cash'}'),
              Text('Date: ${DateTime.now().toLocal()}'),
              const SizedBox(height: 8),
              const Text(
                'A PDF receipt is generated from the ledger (backend). Commission (default 10%) is recorded in the wallet ledger.',
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => context.push(
                      '/customer/rating/${widget.jobId}',
                      extra: widget.job),
                  child: const Text('Rate your provider'),
                ),
              ),
            ],
          ),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Payment')),
      body: _loadingMethods
          ? const Center(child: CircularProgressIndicator())
          : Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('How to pay',
                      style:
                          TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 16),
                  Card(
                    child: RadioListTile<String>(
                      value: 'cash',
                      groupValue: _method,
                      onChanged: (v) => setState(() => _method = v!),
                      title: const Text('Cash'),
                      subtitle: const Text('Pay the provider directly in cash.'),
                    ),
                  ),
                  if (_methodAvailable('wallet'))
                    Card(
                      child: RadioListTile<String>(
                        value: 'wallet',
                        groupValue: _method,
                        onChanged: (v) => setState(() => _method = v!),
                        title: const Text('Pay with wallet'),
                        subtitle: Text(
                            'Balance: ${Money.pkr(_wallet?.balancePkr ?? 0)}'),
                      ),
                    ),
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.account_balance_wallet_outlined),
                      title: const Text('JazzCash / Easypaisa'),
                      subtitle: const Text(
                          'Top up wallet via JazzCash / Easypaisa (sandbox) — not a live payment.'),
                      trailing: const Chip(label: Text('SANDBOX')),
                      onTap: _topUpThenRetry,
                    ),
                  ),
                  if (_method == 'wallet' && _walletShort) ...[
                    const SizedBox(height: 12),
                    Card(
                      color: const Color(0xFFFEF3C7),
                      child: ListTile(
                        leading: const Icon(Icons.warning_amber_rounded,
                            color: Color(0xFFD97706)),
                        title: const Text('Wallet balance is not enough'),
                        subtitle: Text(
                            'Balance ${Money.pkr(_wallet?.balancePkr ?? 0)} · needed ${Money.pkr(_payable)}. Top up or pay in cash.'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        onPressed: _topUpThenRetry,
                        child: const Text('Top up wallet'),
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
                  TextField(
                    controller: _promoController,
                    textCapitalization: TextCapitalization.characters,
                    decoration: InputDecoration(
                      labelText: 'Promo code (optional)',
                      hintText: 'e.g. FIRSTJOB',
                      suffixIcon: TextButton(
                        onPressed:
                            _validatingPromo ? null : _validatePromo,
                        child: Text(_validatingPromo ? '…' : 'Apply'),
                      ),
                    ),
                  ),
                  if (_promoMessage != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      _promoMessage!,
                      style: TextStyle(
                        color: _promo != null && _promo!.valid
                            ? const Color(0xFF15803D)
                            : Colors.red,
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Text('Amount due: ${Money.pkr(_amount)}',
                      style: const TextStyle(fontSize: 18)),
                  if (_discountPkr > 0)
                    Text('Promo discount: − ${Money.pkr(_discountPkr)}',
                        style: const TextStyle(color: Color(0xFF15803D))),
                  Text(
                    'Payable now: ${Money.pkr(_payable)}',
                    style: const TextStyle(
                        fontSize: 20, fontWeight: FontWeight.w800),
                  ),
                  const Text(
                      'The accepted price is locked — no increase without your approval (PRD p.8).',
                      style: TextStyle(color: Colors.grey, fontSize: 13)),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: const TextStyle(color: Colors.red)),
                  ],
                  const Spacer(),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: _submitting ||
                              (_method == 'wallet' && _walletShort)
                          ? null
                          : _confirm,
                      child: Text(_submitting
                          ? 'Confirming…'
                          : _method == 'wallet'
                              ? 'Pay ${Money.pkr(_payable)} from wallet'
                              : 'I paid ${Money.pkr(_payable)} in cash — confirm'),
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
