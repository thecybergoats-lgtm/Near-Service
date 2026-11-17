import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';

/// OTP entry (POST /auth/otp/verify).
/// DEV NOTE: in dev mode the backend prints the OTP to its console —
/// check the backend terminal if no SMS arrives. Never paste OTPs in chat.
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

  Future<void> _verify() async {
    final code = _controller.text.trim();
    if (code.length < 4) {
      setState(() => _error = 'Enter the full code.');
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
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Verify your number')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Code sent to ${widget.phone}',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 24),
            TextField(
              controller: _controller,
              keyboardType: TextInputType.number,
              maxLength: 6,
              decoration: const InputDecoration(
                hintText: '6-digit code',
                prefixIcon: Icon(Icons.lock_outline),
              ),
              onSubmitted: (_) => _verify(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const SizedBox(height: 8),
            const Text(
              'Dev mode: the OTP is printed to the backend console — check the backend terminal if no SMS arrives.',
              style: TextStyle(fontSize: 12, color: Colors.grey),
            ),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _loading ? null : _verify,
                child: _loading
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white))
                    : const Text('Verify & continue'),
              ),
            ),
            const SizedBox(height: 12),
            TextButton(
              onPressed: () async {
                try {
                  await ref.read(apiClientProvider).requestOtp(widget.phone);
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('New code sent.')),
                    );
                  }
                } on ApiException catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(e.userMessage)),
                    );
                  }
                }
              },
              child: const Text('Resend code'),
            ),
          ],
        ),
      ),
    );
  }
}
