import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/qr_code.dart';

/// Scan a provider QR code (customer side, Batch 3): scanning a
/// `near-service://provider/<id>` code opens that provider's profile.
/// A manual code field sits below the camera as the fallback — camera
/// permission denied, scanner failing, or a printed code typed by hand.
/// Random QR codes are rejected with a message, never opened.
class QrScanScreen extends ConsumerStatefulWidget {
  const QrScanScreen({super.key});

  @override
  ConsumerState<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends ConsumerState<QrScanScreen> {
  final _codeController = TextEditingController();
  final _scannerController = MobileScannerController();
  bool _handled = false;
  String? _message;

  @override
  void dispose() {
    _codeController.dispose();
    _scannerController.dispose();
    super.dispose();
  }

  void _openProvider(String providerId) {
    if (_handled) return;
    _handled = true;
    _scannerController.stop();
    context.push('/customer/provider/$providerId');
    // Allow a fresh scan when coming back.
    Future.delayed(const Duration(seconds: 1), () {
      if (mounted) setState(() => _handled = false);
    });
  }

  void _tryCode(String raw) {
    final id = parseProviderIdFromQr(raw);
    if (id == null) {
      setState(() => _message = 'This is not a Near Service provider code.');
      return;
    }
    _openProvider(id);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan provider QR')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Point the camera at a provider QR code to open their profile.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: SizedBox(
              height: 320,
              child: MobileScanner(
                controller: _scannerController,
                onDetect: (capture) {
                  final raw = capture.barcodes.firstOrNull?.rawValue;
                  if (raw == null || raw.isEmpty) return;
                  _tryCode(raw);
                },
              ),
            ),
          ),
          if (_message != null) ...[
            const SizedBox(height: 12),
            Text(
              _message!,
              style: const TextStyle(color: Colors.red, fontWeight: FontWeight.w600),
            ),
          ],
          const SizedBox(height: 24),
          const Text('Or enter the code manually',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          TextField(
            controller: _codeController,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              hintText: 'near-service://provider/… or provider id',
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: () => _tryCode(_codeController.text),
              child: const Text('Open provider'),
            ),
          ),
        ],
      ),
    );
  }
}
