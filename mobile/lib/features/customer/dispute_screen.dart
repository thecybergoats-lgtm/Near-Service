import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../common/widgets.dart';

/// Dispute centre (Phase 2): open a dispute on a job (reason +
/// description via POST /jobs/{id}/disputes), attach evidence
/// (POST /disputes/{id}/evidence), and list my disputes with status,
/// SLA text and the resolution outcome when present.
///
/// Photo evidence honesty note: there is no direct in-app photo-upload
/// API in Phase 2, so a photo is recorded as a note (kind = photo +
/// description / storage key if the user already has one) — it is
/// NEVER presented as an uploaded file. The screen tells the user to
/// share the actual photo with support on chat.
class DisputeScreen extends ConsumerStatefulWidget {
  const DisputeScreen({super.key, this.jobId});

  /// Job to open a dispute on. Null = list my disputes only.
  final String? jobId;

  @override
  ConsumerState<DisputeScreen> createState() => _DisputeScreenState();
}

class _DisputeScreenState extends ConsumerState<DisputeScreen> {
  static const List<(String, String)> _reasons = [
    ('not_completed', 'Work not completed'),
    ('poor_quality', 'Poor quality work'),
    ('overcharged', 'Charged more than agreed'),
    ('provider_no_show', 'Provider did not come'),
    ('damaged', 'Something was damaged'),
    ('other', 'Other'),
  ];

  String _reason = 'not_completed';
  final _descController = TextEditingController();
  bool _submitting = false;
  String? _formError;
  String? _formSuccess;

  final List<Dispute> _disputes = [];
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  bool _offline = false;
  String? _error;
  String? _statusFilter;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _cursor = null;
    });
    try {
      final page = await ref.read(apiClientProvider).listDisputes(
            status: _statusFilter,
            limit: 20,
          );
      if (!mounted) return;
      setState(() {
        _disputes
          ..clear()
          ..addAll(page.items);
        _cursor = page.nextCursor;
        _offline = false;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _offline = true;
        _error = e.userMessage;
        _loading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    if (_cursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final page = await ref.read(apiClientProvider).listDisputes(
            status: _statusFilter,
            cursor: _cursor,
            limit: 20,
          );
      if (!mounted) return;
      setState(() {
        _disputes.addAll(page.items);
        _cursor = page.nextCursor;
      });
    } catch (_) {
      // Keep the loaded page; pull-to-refresh retries.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _openDispute() async {
    final jobId = widget.jobId;
    if (jobId == null || jobId.isEmpty) return;
    if (_descController.text.trim().isEmpty) {
      setState(() => _formError = 'Please describe what happened.');
      return;
    }
    setState(() {
      _submitting = true;
      _formError = null;
      _formSuccess = null;
    });
    try {
      final res = await ref.read(apiClientProvider).openDispute(
            jobId,
            reasonCode: _reason,
            description: _descController.text.trim(),
          );
      final dispute = Dispute.fromJson(res);
      setState(() {
        _formSuccess =
            'Dispute opened. Support reviews it and replies in the app.'
            '${dispute.slaDueAt != null ? ' Target response by ${dispute.slaDueAt}.' : ''}';
        _descController.clear();
      });
      _load();
    } on ApiException catch (e) {
      setState(() => _formError = e.userMessage);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Disputes')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_offline) const OfflineBanner(isDemo: true),
                  if (widget.jobId != null) ...[
                    const Text('Open a dispute',
                        style: TextStyle(
                            fontWeight: FontWeight.w700, fontSize: 16)),
                    const SizedBox(height: 8),
                    Text('Job: ${widget.jobId}',
                        style: const TextStyle(color: Colors.grey)),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      value: _reason,
                      decoration: const InputDecoration(
                          labelText: 'What went wrong?'),
                      items: _reasons
                          .map((r) => DropdownMenuItem(
                              value: r.$1, child: Text(r.$2)))
                          .toList(),
                      onChanged: (v) =>
                          setState(() => _reason = v ?? 'other'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _descController,
                      maxLines: 3,
                      decoration: const InputDecoration(
                        labelText: 'Describe what happened',
                        hintText: 'What happened, when, and what you expect…',
                      ),
                    ),
                    if (_formError != null) ...[
                      const SizedBox(height: 8),
                      Text(_formError!,
                          style: const TextStyle(color: Colors.red)),
                    ],
                    if (_formSuccess != null) ...[
                      const SizedBox(height: 8),
                      Text(_formSuccess!,
                          style: const TextStyle(
                              color: Color(0xFF15803D))),
                    ],
                    const SizedBox(height: 12),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _submitting ? null : _openDispute,
                        child: Text(
                            _submitting ? 'Opening…' : 'Open dispute'),
                      ),
                    ),
                    const SizedBox(height: 24),
                  ],
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('My disputes',
                          style: TextStyle(
                              fontWeight: FontWeight.w700, fontSize: 16)),
                      DropdownButton<String?>(
                        value: _statusFilter,
                        hint: const Text('All statuses'),
                        items: const [
                          DropdownMenuItem(value: null, child: Text('All')),
                          DropdownMenuItem(
                              value: 'open', child: Text('Open')),
                          DropdownMenuItem(
                              value: 'under_review',
                              child: Text('Under review')),
                          DropdownMenuItem(
                              value: 'resolved', child: Text('Resolved')),
                          DropdownMenuItem(
                              value: 'rejected', child: Text('Rejected')),
                        ],
                        onChanged: (v) {
                          setState(() => _statusFilter = v);
                          _load();
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (_error != null && _disputes.isEmpty)
                    ErrorState(message: _error!, onRetry: _load)
                  else if (_disputes.isEmpty)
                    const Card(
                      child: ListTile(
                        leading: Icon(Icons.report_problem_outlined),
                        title: Text('No disputes'),
                        subtitle: Text(
                            'If something goes wrong with a job, open one here.'),
                      ),
                    )
                  else
                    ..._disputes.map((d) => _DisputeCard(
                          dispute: d,
                          onEvidenceAdded: _load,
                        )),
                  if (_cursor != null) ...[
                    const SizedBox(height: 8),
                    OutlinedButton(
                      onPressed: _loadingMore ? null : _loadMore,
                      child: Text(
                          _loadingMore ? 'Loading…' : 'Load more'),
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}

class _DisputeCard extends ConsumerStatefulWidget {
  const _DisputeCard({required this.dispute, this.onEvidenceAdded});

  final Dispute dispute;
  final VoidCallback? onEvidenceAdded;

  @override
  ConsumerState<_DisputeCard> createState() => _DisputeCardState();
}

class _DisputeCardState extends ConsumerState<_DisputeCard> {
  bool _showEvidence = false;
  String _kind = 'photo';
  final _noteController = TextEditingController();
  final _keyController = TextEditingController();
  bool _busy = false;
  String? _message;

  Future<void> _addEvidence() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await ref.read(apiClientProvider).addDisputeEvidence(
            widget.dispute.id,
            kind: _kind,
            storageKey: _keyController.text.trim().isEmpty
                ? null
                : _keyController.text.trim(),
            note: _noteController.text.trim().isEmpty
                ? null
                : _noteController.text.trim(),
          );
      setState(() {
        _message = _kind == 'photo'
            ? 'Photo noted for support. Please also share the actual photo with support on chat — it was not uploaded from here.'
            : 'Evidence added.';
        _noteController.clear();
        _keyController.clear();
      });
      widget.onEvidenceAdded?.call();
    } on ApiException catch (e) {
      setState(() => _message = e.userMessage);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.dispute;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    d.reasonCode.replaceAll('_', ' '),
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                Chip(label: Text(d.status.replaceAll('_', ' '))),
              ],
            ),
            if (d.description.isNotEmpty) Text(d.description),
            Text('Job: ${d.jobId}',
                style: const TextStyle(color: Colors.grey, fontSize: 12)),
            if (d.slaDueAt != null)
              Text('Target response by ${d.slaDueAt}',
                  style: const TextStyle(color: Colors.grey, fontSize: 12)),
            if (d.isResolved && d.resolution != null) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Resolution',
                        style: TextStyle(fontWeight: FontWeight.w700)),
                    Text(d.resolution!),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => setState(() => _showEvidence = !_showEvidence),
              child: Text(_showEvidence ? 'Hide evidence' : 'Add evidence'),
            ),
            if (_showEvidence) ...[
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                value: _kind,
                decoration:
                    const InputDecoration(labelText: 'Evidence type'),
                items: const [
                  DropdownMenuItem(value: 'photo', child: Text('Photo')),
                  DropdownMenuItem(value: 'chat', child: Text('Chat')),
                  DropdownMenuItem(value: 'gps', child: Text('GPS')),
                ],
                onChanged: (v) => setState(() => _kind = v ?? 'photo'),
              ),
              if (_kind == 'photo')
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    'Photo upload is not available in the app yet — your photo is recorded as a note for support, with the kind and description. Share the actual photo with support on chat.',
                    style: TextStyle(color: Colors.grey, fontSize: 13),
                  ),
                ),
              const SizedBox(height: 8),
              TextField(
                controller: _noteController,
                decoration: InputDecoration(
                  labelText: _kind == 'photo'
                      ? 'Photo description (what it shows)'
                      : 'Note',
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _keyController,
                decoration: const InputDecoration(
                  labelText: 'Storage key (only if you already have one)',
                  hintText: 'Optional',
                ),
              ),
              if (_message != null) ...[
                const SizedBox(height: 8),
                Text(_message!,
                    style: const TextStyle(color: Colors.grey, fontSize: 13)),
              ],
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _busy ? null : _addEvidence,
                  child: Text(_busy ? 'Adding…' : 'Add evidence'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
