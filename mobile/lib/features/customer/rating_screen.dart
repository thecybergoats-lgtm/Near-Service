import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';

/// Rating screen (PRD p.9): stars + tag chips + comment.
/// Only after a completed, payment-settled job — one review per side.
/// Fix B: the provider rates the customer too (role 'provider', route
/// /provider/rating/:jobId) — the second review moves the job to RATED.
class RatingScreen extends ConsumerStatefulWidget {
  const RatingScreen({super.key, required this.jobId, this.job, this.role = 'customer', this.returnRoute});

  final String jobId;
  final Job? job;
  /// 'customer' (rates the provider) or 'provider' (rates the customer).
  final String role;
  /// Where "Back to home" goes; defaults to the role's home.
  final String? returnRoute;

  @override
  ConsumerState<RatingScreen> createState() => _RatingScreenState();
}

class _RatingScreenState extends ConsumerState<RatingScreen> {
  int _stars = 5;
  final Set<String> _tags = {};
  final _commentController = TextEditingController();
  bool _done = false;
  bool _submitting = false;
  String? _error;

  static const _allTags = [
    'On time', 'Good work', 'Fair price', 'Polite', 'Clean work', 'Late', 'Price changed',
  ];

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).submitReview(
            widget.jobId,
            _stars,
            _tags.toList(),
            _commentController.text.trim(),
          );
      setState(() => _done = true);
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_done) {
      return Scaffold(
        appBar: AppBar(title: const Text('Thank you')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.check_circle, size: 64, color: Color(0xFF15803D)),
                const SizedBox(height: 16),
                const Text('Thanks for rating!', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: () => context.go(widget.returnRoute ??
                        (widget.role == 'provider' ? '/provider/dashboard' : '/customer/home')),
                    child: const Text('Back to home'),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.role == 'provider' ? 'Rate your customer' : 'Rate your provider')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.role == 'provider'
                  ? 'How was working for ${widget.job?.customerName.isNotEmpty == true ? widget.job!.customerName : 'your customer'}?'
                  : 'How was the work by ${widget.job?.providerName.isNotEmpty == true ? widget.job!.providerName : 'your provider'}?',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(5, (i) => IconButton(
                    icon: Icon(
                      i < _stars ? Icons.star : Icons.star_border,
                      size: 40,
                      color: const Color(0xFFD97706),
                    ),
                    onPressed: () => setState(() => _stars = i + 1),
                  )),
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              children: _allTags.map((t) => FilterChip(
                    label: Text(t),
                    selected: _tags.contains(t),
                    onSelected: (v) => setState(() {
                      if (v) {
                        _tags.add(t);
                      } else {
                        _tags.remove(t);
                      }
                    }),
                  )).toList(),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _commentController,
              maxLines: 3,
              decoration: const InputDecoration(hintText: 'Tell others about the work (optional)'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const Spacer(),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _submitting ? null : _submit,
                child: const Text('Submit rating'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
