import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/qr_code.dart';
import '../common/widgets.dart';

/// "My QR code" (provider side, Batch 3): shows a QR encoding
/// `near-service://provider/<provider-id>` — scanning it opens this
/// provider's profile. Share / copy buttons share the payload text so
/// the code works from a printed flyer or a chat message too.
class QrCodeScreen extends ConsumerStatefulWidget {
  const QrCodeScreen({super.key});

  @override
  ConsumerState<QrCodeScreen> createState() => _QrCodeScreenState();
}

class _QrCodeScreenState extends ConsumerState<QrCodeScreen> {
  MyProviderProfile? _profile;
  bool _loading = true;
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
      final profile = await ref.read(apiClientProvider).getMyProviderProfile();
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.userMessage;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final profile = _profile;
    final payload = profile == null ? '' : buildProviderQrPayload(profile.id);
    return Scaffold(
      appBar: AppBar(title: const Text('My QR code')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null && profile == null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: ErrorState(message: _error!, onRetry: _load),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    Text(
                      profile!.displayName,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                    ),
                    if (profile.shopName != null && profile.shopName!.isNotEmpty)
                      Text(
                        profile.shopName!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.grey),
                      ),
                    const SizedBox(height: 8),
                    const Text(
                      'Customers scan this code to open your profile and book you.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey),
                    ),
                    const SizedBox(height: 24),
                    Center(
                      child: Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: Colors.grey.shade300),
                        ),
                        child: QrImageView(
                          data: payload,
                          version: QrVersions.auto,
                          size: 240,
                          backgroundColor: Colors.white,
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    SelectableText(
                      payload,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: () => Share.share(
                          'Book ${profile.displayName} on Near Service: $payload',
                          subject: 'Near Service — ${profile.displayName}',
                        ),
                        icon: const Icon(Icons.share),
                        label: const Text('Share my QR code'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: () async {
                          final messenger = ScaffoldMessenger.of(context);
                          await Clipboard.setData(ClipboardData(text: payload));
                          if (!mounted) return;
                          messenger.showSnackBar(
                            const SnackBar(content: Text('Code copied')),
                          );
                        },
                        icon: const Icon(Icons.copy),
                        label: const Text('Copy code'),
                      ),
                    ),
                  ],
                ),
    );
  }
}
