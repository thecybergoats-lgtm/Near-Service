import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';

/// Provider "Request extra work" (FIX 10): itemised price adjustment
/// on an IN_PROGRESS job (POST /jobs/{id}/adjustments). The customer
/// approves or rejects it; the job moves to PRICE_ADJUSTMENT_PENDING
/// until they decide. The backend only allows adjustments while the
/// job is IN_PROGRESS (409 NOT_IN_PROGRESS otherwise), so this screen
/// is only offered from the active-job screen in that state.
///
/// Photos: there is no adjustment-photo upload endpoint in Phase 2,
/// so each line takes an optional storage key (photo_key) for a photo
/// already uploaded elsewhere — never faked as an upload.
class AdjustmentScreen extends ConsumerStatefulWidget {
  const AdjustmentScreen({super.key, required this.jobId});

  final String jobId;

  @override
  ConsumerState<AdjustmentScreen> createState() => _AdjustmentScreenState();
}

class _Line {
  _Line({this.label = '', this.amountText = '', this.photoKey = ''});

  String label;
  String amountText;
  String photoKey;

  int get amount => Money.tryParse(amountText) ?? 0;
}

class _AdjustmentScreenState extends ConsumerState<AdjustmentScreen> {
  final _reasonController = TextEditingController();
  final List<_Line> _lines = [_Line()];
  bool _saving = false;
  String? _error;

  int get _total => _lines.fold<int>(0, (s, l) => s + l.amount);

  Future<void> _submit() async {
    final reason = _reasonController.text.trim();
    final items = <AdjustmentItem>[];
    for (final line in _lines) {
      final label = line.label.trim();
      if (label.isEmpty && line.amount <= 0) continue; // empty row
      if (label.isEmpty || line.amount <= 0) {
        setState(() => _error =
            'Every line needs a description and an amount above PKR 0.');
        return;
      }
      items.add(AdjustmentItem(
        label: label,
        amount: line.amount,
        photoKey:
            line.photoKey.trim().isEmpty ? null : line.photoKey.trim(),
      ));
    }
    if (items.isEmpty) {
      setState(() => _error = 'Add at least one line of extra work.');
      return;
    }
    if (reason.isEmpty) {
      setState(() => _error = 'Explain why the extra work is needed.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final adj = await ref.read(apiClientProvider).createJobAdjustment(
            widget.jobId,
            items: items,
            reason: reason,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(
                  'Extra work requested: ${Money.pkr(adj.addedAmount)} — waiting for the customer to approve.')),
        );
        Navigator.pop(context, true);
      }
    } on ApiException catch (e) {
      setState(() => _error = e.code == 'NOT_IN_PROGRESS'
          ? 'Extra work can only be requested while the job is in progress.'
          : e.userMessage);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Request extra work')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Job ${widget.jobId}',
              style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text(
            'List each extra item with its price. The customer approves or rejects the total — work stays paused at the old price until they decide.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 16),
          ..._lines.asMap().entries.map((entry) {
            final i = entry.key;
            final line = entry.value;
            return Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text('Item ${i + 1}',
                              style:
                                  const TextStyle(fontWeight: FontWeight.w700)),
                        ),
                        if (_lines.length > 1)
                          IconButton(
                            icon: const Icon(Icons.delete_outline,
                                color: Colors.red),
                            tooltip: 'Remove line',
                            onPressed: () =>
                                setState(() => _lines.removeAt(i)),
                          ),
                      ],
                    ),
                    TextField(
                      decoration: const InputDecoration(
                          labelText: 'What extra work / part?',
                          hintText: 'e.g. Extra pipe fitting'),
                      onChanged: (v) => line.label = v,
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Amount (PKR)',
                        prefixText: 'PKR ',
                      ),
                      onChanged: (v) => setState(() => line.amountText = v),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      decoration: const InputDecoration(
                        labelText: 'Photo storage key (optional)',
                        hintText: 'Only if the photo was already uploaded',
                      ),
                      onChanged: (v) => line.photoKey = v,
                    ),
                  ],
                ),
              ),
            );
          }),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => setState(() => _lines.add(_Line())),
            icon: const Icon(Icons.add),
            label: const Text('Add another line'),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _reasonController,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Why is this extra work needed?',
              hintText: 'e.g. The old pipe was rusted through and had to be replaced.',
            ),
          ),
          const SizedBox(height: 16),
          Card(
            color: const Color(0xFFF1F5F9),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Extra total',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  Text(Money.pkr(_total),
                      style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          color: Color(0xFFD97706),
                          fontSize: 17)),
                ],
              ),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _saving ? null : _submit,
              child: Text(_saving ? 'Sending…' : 'Send request to customer'),
            ),
          ),
        ],
      ),
    );
  }
}
