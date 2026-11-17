import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/phase3_models.dart';

/// Phase 3 — AI search (customer): free-text intent, photo-description
/// search and the learned fair-price estimate.
///
/// Honest labels, from the backend contract: photo search is a heuristic
/// keyword match on the description/tags — NOT image recognition; voice
/// search needs a transcript from on-device recognition (audio-only is
/// 422 STT_UNAVAILABLE on the local provider).
class AiSearchScreen extends ConsumerStatefulWidget {
  const AiSearchScreen({super.key});

  @override
  ConsumerState<AiSearchScreen> createState() => _AiSearchScreenState();
}

class _AiSearchScreenState extends ConsumerState<AiSearchScreen> {
  final _text = TextEditingController();
  final _photo = TextEditingController();
  AiIntent? _intent;
  List<PhotoSuggestion> _suggestions = [];
  AiFairPrice? _fairPrice;
  bool _loading = false;
  String? _error;
  String? _voiceNote;

  Future<void> _run(Future<void> Function() fn) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await fn();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Something went wrong. Try again.');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _parseIntent() async {
    if (_text.text.trim().isEmpty) return;
    await _run(() async {
      _intent = await ref.read(apiClientProvider).parseIntent(_text.text.trim());
      _suggestions = [];
      _fairPrice = null;
      if (_intent!.categorySlug.isNotEmpty) {
        _fairPrice = await ref
            .read(apiClientProvider)
            .aiFairPrice(categorySlug: _intent!.categorySlug);
      }
    });
  }

  Future<void> _photoSearch() async {
    if (_photo.text.trim().isEmpty) return;
    await _run(() async {
      _suggestions = await ref
          .read(apiClientProvider)
          .photoSearch(description: _photo.text.trim());
      _intent = null;
      _fairPrice = null;
    });
  }

  /// Voice search with a transcript the phone already recognised.
  /// The transcript is always shown for manual correction before a
  /// request is posted (requires_confirmation=true server-side).
  Future<void> _voiceSearch(String transcript) async {
    await _run(() async {
      final res = await ref
          .read(apiClientProvider)
          .voiceSearch(transcript: transcript);
      _voiceNote =
          'Heard: "${res['transcript']}" — check it before posting a request.';
      _intent = AiIntent.fromJson(
          (res['intent'] as Map<String, dynamic>?) ?? {});
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('AI search')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _text,
            decoration: const InputDecoration(
              labelText: 'Describe the job (e.g. AC repair karwana hai)',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => _parseIntent(),
          ),
          const SizedBox(height: 8),
          ElevatedButton(
            onPressed: _loading ? null : _parseIntent,
            child: const Text('Find service'),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _photo,
            decoration: const InputDecoration(
              labelText: 'Photo of the problem — describe it in words',
              hintText: 'e.g. leaking tap, broken switch',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => _photoSearch(),
          ),
          const SizedBox(height: 8),
          ElevatedButton(
            onPressed: _loading ? null : _photoSearch,
            child: const Text('Suggest from photo description'),
          ),
          const Text(
            'Photo search matches your words against service names — it does not read image pixels.',
            style: TextStyle(fontSize: 12, color: Colors.grey),
          ),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: _loading
                ? null
                : () => _voiceSearch(_text.text.trim().isEmpty
                    ? 'AC repair karwana hai'
                    : _text.text.trim()),
            child: const Text('Voice search (from phone transcript)'),
          ),
          const Text(
            'Audio clips cannot be transcribed on this build — send the transcript your phone recognised instead.',
            style: TextStyle(fontSize: 12, color: Colors.grey),
          ),
          if (_loading) ...[
            const SizedBox(height: 16),
            const Center(child: CircularProgressIndicator()),
          ],
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          if (_voiceNote != null) ...[
            const SizedBox(height: 16),
            Text(_voiceNote!),
          ],
          if (_intent != null) ...[
            const SizedBox(height: 16),
            Card(
              child: ListTile(
                title: Text(_intent!.categoryName.isEmpty
                    ? 'No clear match — try keyword search'
                    : _intent!.categoryName),
                subtitle: Text(
                    'Confidence ${(_intent!.confidence * 100).round()}%${_intent!.fallbackToKeywordSearch ? ' · fell back to keyword search' : ''}'),
                trailing: _intent!.categorySlug.isEmpty
                    ? null
                    : TextButton(
                        onPressed: () => context.push(
                          '/customer/providers',
                          extra: {'categoryId': _intent!.categorySlug},
                        ),
                        child: const Text('See providers'),
                      ),
              ),
            ),
          ],
          if (_suggestions.isNotEmpty) ...[
            const SizedBox(height: 8),
            const Text('Suggestions',
                style: TextStyle(fontWeight: FontWeight.bold)),
            ..._suggestions.map((s) => ListTile(
                  title: Text(s.nameEn),
                  subtitle: Text(
                      'Confidence ${(s.confidence * 100).round()}% · heuristic match'),
                  onTap: () => context.push(
                    '/customer/providers',
                    extra: {'categoryId': s.categorySlug},
                  ),
                )),
          ],
          if (_fairPrice != null) ...[
            const SizedBox(height: 16),
            Card(
              child: ListTile(
                title: const Text('Fair price (learned from completed jobs)'),
                subtitle: Text(_fairPrice!.hidden
                    ? 'Not enough completed jobs yet to show a price.'
                    : 'Typical PKR ${_fairPrice!.typical?.round()} '
                        '(PKR ${_fairPrice!.min?.round()}–${_fairPrice!.max?.round()}, '
                        '${_fairPrice!.sampleSize} jobs, ${_fairPrice!.source})'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
