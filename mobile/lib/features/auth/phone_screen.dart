import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';

/// Phone entry — one phone number = one account (PRD p.5).
/// Batch 2 redesign: premium dark + gold, clear steps
/// (phone → OTP → done), PK mobile validation, proper error states.
/// Normalises to +92 format before calling POST /auth/otp/request.
/// No demo/pilot code is ever shown here.
class PhoneScreen extends ConsumerStatefulWidget {
  const PhoneScreen({super.key});

  @override
  ConsumerState<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends ConsumerState<PhoneScreen> {
  final _controller = TextEditingController();
  bool _loading = false;
  String? _error;

  static const _gold = Color(0xFFC9A227);
  static const _bg = Color(0xFF0E0E0E);

  String _normalise(String raw) {
    var digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.startsWith('92')) return '+$digits';
    if (digits.startsWith('0')) return '+92${digits.substring(1)}';
    if (digits.length == 10) return '+92$digits';
    return '+$digits';
  }

  /// Pakistani mobile: 03XX-XXXXXXX (11 digits) or +92 3XX XXXXXXX.
  bool _isValidPkMobile(String raw) {
    final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length == 11 && digits.startsWith('03')) return true;
    if (digits.length == 12 &&
        digits.startsWith('92') &&
        digits[2] == '3') return true;
    return false;
  }

  Future<void> _submit() async {
    final raw = _controller.text.trim();
    if (!_isValidPkMobile(raw)) {
      setState(() => _error =
          'Please enter a valid Pakistani mobile number, e.g. 03XX-XXXXXXX.');
      return;
    }
    final phone = _normalise(raw);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).requestOtp(phone);
      if (mounted) context.go('/auth/otp', extra: phone);
    } on ApiException catch (e) {
      setState(() => _error = e is NetworkException
          ? 'No internet connection. Check your connection and try again.'
          : e.userMessage);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 16),
              // Step indicator: 1 Phone → 2 OTP → 3 Done.
              Row(
                children: [
                  _stepDot(1, active: true, done: false),
                  _stepLine(done: false),
                  _stepDot(2, active: false, done: false),
                  _stepLine(done: false),
                  _stepDot(3, active: false, done: false),
                ],
              ),
              const SizedBox(height: 8),
              const Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('Phone', style: TextStyle(color: _gold, fontSize: 12, fontWeight: FontWeight.w700)),
                  Text('OTP', style: TextStyle(color: Colors.grey, fontSize: 12)),
                  Text('Done', style: TextStyle(color: Colors.grey, fontSize: 12)),
                ],
              ),
              const SizedBox(height: 32),
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: _gold.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: _gold.withOpacity(0.4)),
                ),
                child: const Icon(Icons.handyman_outlined,
                    color: _gold, size: 32),
              ),
              const SizedBox(height: 20),
              const Text('Near Service',
                  style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.w800,
                      color: Colors.white)),
              const SizedBox(height: 8),
              const Text(
                'Book trusted local services near you — book binding, AC repair, electrician, plumber, mobile repair.',
                style: TextStyle(color: Colors.grey, fontSize: 15),
              ),
              const SizedBox(height: 32),
              const Text('Enter your mobile number',
                  style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: Colors.white)),
              const SizedBox(height: 8),
              const Text('We will send you a 6-digit code by SMS.',
                  style: TextStyle(color: Colors.grey)),
              const SizedBox(height: 24),
              TextField(
                controller: _controller,
                keyboardType: TextInputType.phone,
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9+\- ]')),
                ],
                style: const TextStyle(color: Colors.white, fontSize: 18),
                decoration: InputDecoration(
                  filled: true,
                  fillColor: const Color(0xFF1F2937),
                  prefixText: '+92 ',
                  prefixStyle:
                      const TextStyle(color: Colors.white, fontSize: 18),
                  hintText: '3XX XXXXXXX',
                  hintStyle: const TextStyle(color: Colors.grey),
                  prefixIcon: const Icon(Icons.phone, color: _gold),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(16),
                    borderSide: BorderSide.none,
                  ),
                  errorText: _error,
                  errorMaxLines: 2,
                ),
                onSubmitted: (_) => _submit(),
              ),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: _gold,
                    foregroundColor: Colors.black,
                    minimumSize: const Size.fromHeight(52),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  onPressed: _loading ? null : _submit,
                  child: _loading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                              color: Colors.black, strokeWidth: 2))
                      : const Text('Send code',
                          style: TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w700)),
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'By continuing you agree to be contacted by SMS about your jobs.',
                style: TextStyle(fontSize: 12, color: Colors.grey),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stepDot(int n, {required bool active, required bool done}) {
    return Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: active ? _gold : const Color(0xFF1F2937),
        border: Border.all(color: active ? _gold : Colors.grey),
      ),
      child: Text('$n',
          style: TextStyle(
              color: active ? Colors.black : Colors.grey,
              fontWeight: FontWeight.w700)),
    );
  }

  Widget _stepLine({required bool done}) {
    return Expanded(
      child: Container(
        height: 2,
        color: done ? _gold : const Color(0xFF374151),
        margin: const EdgeInsets.symmetric(horizontal: 4),
      ),
    );
  }
}
