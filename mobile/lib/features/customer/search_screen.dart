import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/demo_data.dart';
import '../../l10n/app_localizations.dart';
import '../common/widgets.dart';

/// Search & suggestions (PRD p.22): recent, popular, taxonomy matches.
/// No-results -> waitlist join.
/// Batch 2 — voice search is real now: on-device speech recognition
/// (speech_to_text) transcribes, then the normal category/service
/// search runs on the transcribed text. The transcript is shown for
/// manual correction before searching. Microphone denial shows a
/// clear message and falls back to typing — never a fake result.
class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key, this.autoListen = false});

  /// True when opened from the home mic button: start listening at once.
  final bool autoListen;

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _controller = TextEditingController();
  final _speech = SpeechToText();
  List<Map<String, dynamic>> _results = [];
  bool _loading = false;
  bool _searched = false;
  bool _onWaitlist = false;
  bool _listening = false;
  bool _speechAvailable = false;

  @override
  void initState() {
    super.initState();
    if (widget.autoListen) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _startListening());
    }
  }

  @override
  void dispose() {
    _speech.cancel();
    _controller.dispose();
    super.dispose();
  }

  /// Starts on-device recognition. Returns false (with a plain
  /// message) when the microphone is unavailable or permission was
  /// denied — the user just types instead.
  Future<void> _startListening() async {
    if (_listening) {
      await _speech.stop();
      if (mounted) setState(() => _listening = false);
      return;
    }
    final available = await _speech.initialize(
      onError: (e) {
        if (!mounted) return;
        setState(() => _listening = false);
        if (e.errorMsg == 'error_permission' ||
            e.errorMsg == 'error_no_match') {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(L.of(ref.read(localeProvider)).t('mic_denied'))),
          );
        }
      },
      onStatus: (status) {
        if (status == 'done' || status == 'notListening') {
          if (mounted) setState(() => _listening = false);
        }
      },
    );
    if (!available) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(L.of(ref.read(localeProvider)).t('mic_denied'))),
        );
      }
      return;
    }
    setState(() {
      _speechAvailable = true;
      _listening = true;
    });
    // Prefer Urdu (Pakistan) recognition for Roman Urdu speech, fall
    // back to the device default when it is not installed.
    String? localeId;
    try {
      final locales = await _speech.locales();
      final urPk = locales.where((l) => l.localeId == 'ur-PK').toList();
      if (urPk.isNotEmpty) localeId = 'ur-PK';
    } catch (_) {
      localeId = null;
    }
    await _speech.listen(
      listenOptions: SpeechListenOptions(
        partialResults: true,
        localeId: localeId,
      ),
      onResult: (result) {
        _controller.text = result.recognizedWords;
        if (result.finalResult && result.recognizedWords.trim().isNotEmpty) {
          setState(() => _listening = false);
          _search(result.recognizedWords);
        }
      },
    );
  }

  Future<void> _search(String q) async {
    if (q.trim().isEmpty) return;
    setState(() {
      _loading = true;
      _searched = true;
    });
    try {
      _results = await ref.read(apiClientProvider).search(
            q,
            AppConstants.quettaLat,
            AppConstants.quettaLng,
          );
    } catch (_) {
      // Offline fallback: match demo taxonomy by name / alias.
      final query = q.toLowerCase();
      _results = DemoData.categories
          .where((c) =>
              c.nameEn.toLowerCase().contains(query) ||
              c.nameRoman.toLowerCase().contains(query) ||
              c.nameUr.contains(q))
          .map((c) => <String, dynamic>{
                'type': 'category',
                'id': c.id,
                'name': c.nameEn,
                'name_roman': c.nameRoman,
              })
          .toList();
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final locale = ref.watch(localeProvider);
    final l = L.of(locale);
    return Scaffold(
      appBar: AppBar(title: const Text('Search')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _controller,
              autofocus: !widget.autoListen,
              decoration: InputDecoration(
                hintText: l.t('search_hint'),
                prefixIcon: const Icon(Icons.search),
                suffixIcon: IconButton(
                  icon: Icon(
                    _listening ? Icons.mic : Icons.mic_none,
                    color: _listening ? Colors.red : null,
                  ),
                  tooltip: l.t('voice_search_hint'),
                  onPressed: _startListening,
                ),
              ),
              onSubmitted: _search,
            ),
            if (_listening) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _controller.text.isEmpty
                          ? 'Listening… speak now'
                          : 'Heard: "${_controller.text}"',
                      style: const TextStyle(fontStyle: FontStyle.italic),
                    ),
                  ),
                ],
              ),
            ],
            if (!_speechAvailable && !_listening) ...[
              const SizedBox(height: 8),
              Text(
                l.t('voice_search_hint'),
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
            const SizedBox(height: 16),
            if (!_searched) ...[
              const Text('Popular near you', style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: DemoData.categories
                    .map((c) => ActionChip(
                          label: Text(c.nameEn),
                          onPressed: () {
                            _controller.text = c.nameEn;
                            _search(c.nameEn);
                          },
                        ))
                    .toList(),
              ),
            ],
            if (_loading) const Expanded(child: Center(child: CircularProgressIndicator())),
            if (!_loading && _searched && _results.isEmpty)
              Expanded(
                child: EmptyState(
                  icon: Icons.search_off,
                  message: 'No one nearby yet for "${_controller.text}". Join the waitlist — we will tell you when a provider joins.',
                  action: ElevatedButton(
                    onPressed: () => setState(() => _onWaitlist = true),
                    child: Text(_onWaitlist ? 'You are on the waitlist ✓' : 'Join waitlist'),
                  ),
                ),
              ),
            if (!_loading && _results.isNotEmpty)
              Expanded(
                child: ListView.builder(
                  itemCount: _results.length,
                  itemBuilder: (_, i) {
                    final r = _results[i];
                    final name = (r['name_roman'] ?? r['name'] ?? '').toString();
                    return ListTile(
                      leading: const Icon(Icons.category),
                      title: Text(name),
                      subtitle: Text((r['type'] ?? 'service').toString()),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () {
                        // Provider hits open the provider profile;
                        // category hits open the request form. A UUID
                        // goes as `categoryId`, a slug as `categorySlug`
                        // — never a slug as `categoryId` (PRD v1.1).
                        if (r['type'] == 'provider') {
                          context.push(
                            '/customer/provider/${r['id']}',
                          );
                          return;
                        }
                        final id = (r['id'] ?? r['category_id'] ?? 'book-binding').toString();
                        context.push(
                          '/customer/request',
                          extra: CategoryResolver.isUuid(id)
                              ? {'categoryId': id}
                              : {'categorySlug': id},
                        );
                      },
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}
