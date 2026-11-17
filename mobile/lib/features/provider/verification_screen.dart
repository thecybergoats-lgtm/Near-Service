import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/phase3_models.dart';

/// Phase 3 — Verification (provider): face-match + liveness + my risk
/// score. Advisory only: a face-match score NEVER approves or rejects
/// anything — tier upgrades happen only through a human officer's
/// decision. The default face-match provider is a local heuristic.
class VerificationScreen extends ConsumerStatefulWidget {
  const VerificationScreen({super.key});

  @override
  ConsumerState<VerificationScreen> createState() =>
      _VerificationScreenState();
}

class _VerificationScreenState extends ConsumerState<VerificationScreen> {
  RiskScore? _risk;
  FaceMatchResult? _faceMatch;
  LivenessChallenge? _challenge;
  bool _loading = true;
  String? _error;
  String? _msg;

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
      _risk = await ref.read(apiClientProvider).getMyRiskScore();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not load verification status.');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _startLiveness() async {
    try {
      _challenge =
          await ref.read(apiClientProvider).startLiveness();
      setState(() => _msg =
          'Challenge started — perform: ${_challenge!.actions.join(', ')}. Then answer with what you did.');
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
  }

  Future<void> _answerLiveness() async {
    if (_challenge == null) return;
    try {
      final res = await ref.read(apiClientProvider).respondLiveness(
            _challenge!.challengeId,
            _challenge!.actions,
          );
      setState(() => _msg = res['passed'] == true
          ? 'Liveness passed.'
          : 'Liveness not passed: ${res['reason'] ?? ''} (${res['attempts_used']}/${res['attempts_allowed']} attempts used).');
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Verification')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_msg != null) ...[
                      Text(_msg!),
                      const SizedBox(height: 12),
                    ],
                    Card(
                      child: ListTile(
                        title: const Text('My risk score'),
                        subtitle: Text(_risk == null
                            ? '—'
                            : 'Score ${_risk!.score}/100 · ${_risk!.level} '
                                '(review ≥ ${_risk!.reviewThreshold}, block ≥ ${_risk!.blockThreshold})'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text('Face-match',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                    ListTile(
                      title: Text(_faceMatch == null
                          ? 'No face-match submitted yet'
                          : 'Verdict: ${_faceMatch!.verdict}'
                              '${_faceMatch!.score != null ? ' (score ${_faceMatch!.score})' : ''}'),
                      subtitle: const Text(
                          'Submit a live selfie + your CNIC photo. The score is advisory only — an officer still decides.'),
                    ),
                    const SizedBox(height: 12),
                    const Text('Liveness',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                    if (_challenge != null)
                      ListTile(
                        title: Text('Challenge: ${_challenge!.status}'),
                        subtitle: Text(
                            'Do: ${_challenge!.actions.join(', ')} · attempts ${_challenge!.attemptsUsed}/${_challenge!.attemptsAllowed}'),
                      ),
                    Row(
                      children: [
                        ElevatedButton(
                            onPressed: _startLiveness,
                            child: const Text('Start liveness')),
                        const SizedBox(width: 8),
                        OutlinedButton(
                            onPressed:
                                _challenge == null ? null : _answerLiveness,
                            child: const Text('I did the actions')),
                      ],
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'Face-match uses the local heuristic provider in this build (no vendor). OCR assist is officer-side: the officer transcribes your CNIC and you can track the result here once submitted.',
                      style: TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                  ],
                ),
    );
  }
}
