import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';

/// Phone entry — one phone number = one account (PRD p.5).
/// Normalises to +92 format before calling POST /auth/otp/request.
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

  Future<void> _submit() async {
    final phone = _normalise(_controller.text);
    if (phone.length < 12) {
      setState(() => _error = 'Please enter a valid Pakistani mobile number, e.g. 03XX-XXXXXXX.');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).requestOtp(phone);
      if (mounted) context.go('/auth/otp', extra: phone);
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Near Service')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Enter your mobile number',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text('We will send you a 6-digit code by SMS.',
                style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 24),
            TextField(
              controller: _controller,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                prefixText: '+92 ',
                hintText: '3XX XXXXXXX',
                prefixIcon: Icon(Icons.phone),
              ),
              onSubmitted: (_) => _submit(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _loading ? null : _submit,
                child: _loading
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white))
                    : const Text('Send code'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
