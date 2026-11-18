import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/theme.dart';

/// Phone entry — one phone number = one account (PRD p.5).
/// Batch 2 redesign: premium dark + gold, clear steps
/// (phone → OTP → done), PK mobile validation, proper error states.
/// Batch 4: follows the app theme exactly (light/dark) — no hardcoded
/// dark background or white text; the gold accent is the theme token
/// [AppColors.gold]. Normalises to +92 format before calling
/// POST /auth/otp/request. No demo/pilot code is ever shown here.
class PhoneScreen extends ConsumerStatefulWidget {
  const PhoneScreen({super.key});

  @override
  ConsumerState<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends ConsumerState<PhoneScreen> {
  final _controller = TextEditingController();
  bool _loading = false;
  String? _error;

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
    final scheme = Theme.of(context).colorScheme;
    final fill = Theme.of(context).inputDecorationTheme.fillColor;
    return Scaffold(
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
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Phone', style: TextStyle(color: AppColors.gold, fontSize: 12, fontWeight: FontWeight.w700)),
                  Text('OTP', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12)),
                  Text('Done', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12)),
                ],
              ),
              const SizedBox(height: 32),
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: AppColors.gold.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: AppColors.gold.withOpacity(0.4)),
                ),
                child: const Icon(Icons.handyman_outlined,
                    color: AppColors.gold, size: 32),
              ),
              const SizedBox(height: 20),
              Text('Near Service',
                  style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.w800,
                      color: scheme.onSurface)),
              const SizedBox(height: 8),
              Text(
                'Book trusted local services near you — book binding, AC repair, electrician, plumber, mobile repair.',
                style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 15),
              ),
              const SizedBox(height: 32),
              Text('Enter your mobile number',
                  style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: scheme.onSurface)),
              const SizedBox(height: 8),
              Text('We will send you a 6-digit code by SMS.',
                  style: TextStyle(color: scheme.onSurfaceVariant)),
              const SizedBox(height: 24),
              TextField(
                controller: _controller,
                keyboardType: TextInputType.phone,
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9+\- ]')),
                ],
                style: TextStyle(color: scheme.onSurface, fontSize: 18),
                decoration: InputDecoration(
                  filled: true,
                  fillColor: fill,
                  prefixText: '+92 ',
                  prefixStyle:
                      TextStyle(color: scheme.onSurface, fontSize: 18),
                  hintText: '3XX XXXXXXX',
                  hintStyle: TextStyle(color: scheme.onSurfaceVariant),
                  prefixIcon: const Icon(Icons.phone, color: AppColors.gold),
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
                    backgroundColor: AppColors.gold,
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
              Text(
                'By continuing you agree to be contacted by SMS about your jobs.',
                style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stepDot(int n, {required bool active, required bool done}) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: active ? AppColors.gold : scheme.surfaceContainerHighest,
        border: Border.all(
            color: active ? AppColors.gold : scheme.outlineVariant),
      ),
      child: Text('$n',
          style: TextStyle(
              color: active ? Colors.black : scheme.onSurfaceVariant,
              fontWeight: FontWeight.w700)),
    );
  }

  Widget _stepLine({required bool done}) {
    final scheme = Theme.of(context).colorScheme;
    return Expanded(
      child: Container(
        height: 2,
        color: done ? AppColors.gold : scheme.outlineVariant,
        margin: const EdgeInsets.symmetric(horizontal: 4),
      ),
    );
  }
}
