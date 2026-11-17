import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';

/// OTP entry (POST /auth/otp/verify).
/// Batch 2 redesign: premium dark + gold, step 2 of 3, 6-digit entry,
/// 30 s resend timer, proper error states (wrong code, expired,
/// locked / too many attempts, no network). No code is ever shown in
/// the UI — the code arrives by SMS only.
class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key, required this.phone});

  final String phone;

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  final _controller = TextEditingController();
  bool _loading = false;
  String? _error;
  int _resendIn = 30;
  Timer? _resendTimer;
  bool _resending = false;

  static const _gold = Color(0xFFC9A227);
  static const _bg = Color(0xFF0E0E0E);

  @override
  void initState() {
    super.initState();
    _startResendTimer();
  }

  @override
  void dispose() {
    _resendTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _startResendTimer() {
    _resendTimer?.cancel();
    setState(() => _resendIn = 30);
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      if (_resendIn <= 1) {
        t.cancel();
        setState(() => _resendIn = 0);
      } else {
        setState(() => _resendIn--);
      }
    });
  }

  Future<void> _verify() async {
    final code = _controller.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'Enter the full 6-digit code.');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).verifyOtp(widget.phone, code);
      if (mounted) context.go('/auth/role');
    } on ApiException catch (e) {
      setState(() {
        if (e is NetworkException) {
          _error = 'No internet connection. Check your connection and try again.';
        } else if (e.code == 'INVALID_OTP') {
          _error = 'Wrong code. Please check the SMS and try again.';
        } else if (e.code == 'OTP_EXPIRED') {
          _error = 'The code has expired. Request a new one below.';
        } else if (e.statusCode == 429) {
          _error = 'Too many attempts. Wait a minute, then request a new code.';
        } else if (e.statusCode == 403) {
          _error = 'This number is locked for now. Try again later or contact support.';
        } else {
          _error = e.userMessage;
        }
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _resend() async {
    if (_resendIn > 0 || _resending) return;
    setState(() => _resending = true);
    try {
      await ref.read(apiClientProvider).requestOtp(widget.phone);
      if (mounted) {
        _startResendTimer();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('New code sent by SMS.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.userMessage)),
        );
      }
    } finally {
      if (mounted) setState(() => _resending = false);
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
              Row(
                children: [
                  _stepDot(1, done: true),
                  _stepLine(done: true),
                  _stepDot(2, active: true),
                  _stepLine(done: false),
                  _stepDot(3, active: false),
                ],
              ),
              const SizedBox(height: 8),
              const Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('Phone', style: TextStyle(color: _gold, fontSize: 12, fontWeight: FontWeight.w700)),
                  Text('OTP', style: TextStyle(color: _gold, fontSize: 12, fontWeight: FontWeight.w700)),
                  Text('Done', style: TextStyle(color: Colors.grey, fontSize: 12)),
                ],
              ),
              const SizedBox(height: 32),
              const Text('Verify your number',
                  style: TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.w800,
                      color: Colors.white)),
              const SizedBox(height: 8),
              Text('Code sent to ${widget.phone}',
                  style: const TextStyle(color: Colors.grey, fontSize: 15)),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => context.go('/auth/phone'),
                child: const Text('Wrong number? Change it',
                    style: TextStyle(color: _gold)),
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _controller,
                keyboardType: TextInputType.number,
                maxLength: 6,
                autofocus: true,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 24,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 8),
                textAlign: TextAlign.center,
                decoration: InputDecoration(
                  filled: true,
                  fillColor: const Color(0xFF1F2937),
                  hintText: '••••••',
                  hintStyle: const TextStyle(color: Colors.grey),
                  counterText: '',
                  prefixIcon: const Icon(Icons.lock_outline, color: _gold),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(16),
                    borderSide: BorderSide.none,
                  ),
                  errorText: _error,
                  errorMaxLines: 3,
                ),
                onSubmitted: (_) => _verify(),
                onChanged: (_) {
                  if (_error != null) setState(() => _error = null);
                },
              ),
              const SizedBox(height: 8),
              const Text(
                'Enter the 6-digit code from the SMS. It expires in a few minutes.',
                style: TextStyle(fontSize: 12, color: Colors.grey),
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
                  onPressed: _loading ? null : _verify,
                  child: _loading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                              color: Colors.black, strokeWidth: 2))
                      : const Text('Verify & continue',
                          style: TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w700)),
                ),
              ),
              const SizedBox(height: 16),
              Center(
                child: _resendIn > 0
                    ? Text('Resend code in ${_resendIn}s',
                        style:
                            const TextStyle(color: Colors.grey, fontSize: 14))
                    : TextButton(
                        onPressed: _resending ? null : _resend,
                        child: Text(
                          _resending ? 'Sending…' : 'Resend code',
                          style: const TextStyle(
                              color: _gold, fontWeight: FontWeight.w700),
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stepDot(int n, {bool active = false, bool done = false}) {
    return Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: done
            ? _gold
            : active
                ? _gold
                : const Color(0xFF1F2937),
        border: Border.all(color: done || active ? _gold : Colors.grey),
      ),
      child: done
          ? const Icon(Icons.check, size: 18, color: Colors.black)
          : Text('$n',
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
