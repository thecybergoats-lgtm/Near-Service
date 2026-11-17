import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../common/widgets.dart';

/// History (Phase 2): real GET /jobs with a role filter
/// (customer/provider), state filter chips, cursor pagination and
/// pull-to-refresh. Each job links to tracking, payment, rating,
/// dispute and rebook. Loading / empty / error / offline states are
/// all shown; nothing is invented when the API is unreachable.
class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key});

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  String _role = 'customer';
  String? _state; // null = all
  final List<Job> _jobs = [];
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  bool _offline = false;
  String? _error;

  static const List<(String?, String)> _stateFilters = [
    (null, 'All'),
    ('ACCEPTED', 'Accepted'),
    ('PROVIDER_EN_ROUTE', 'On the way'),
    ('ARRIVED', 'Arrived'),
    ('IN_PROGRESS', 'Working'),
    ('COMPLETED', 'Completed'),
    ('PAYMENT_SETTLED', 'Paid'),
    ('RATED', 'Rated'),
  ];

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
      final page = await ref.read(apiClientProvider).listJobs(
            role: _role,
            state: _state,
            limit: 20,
          );
      if (!mounted) return;
      setState(() {
        _jobs
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
      final page = await ref.read(apiClientProvider).listJobs(
            role: _role,
            state: _state,
            cursor: _cursor,
            limit: 20,
          );
      if (!mounted) return;
      setState(() {
        _jobs.addAll(page.items);
        _cursor = page.nextCursor;
      });
    } catch (_) {
      // Keep the loaded page; pull-to-refresh retries.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _setRole(String role) {
    if (role == _role) return;
    setState(() => _role = role);
    _load();
  }

  void _setState(String? state) {
    if (state == _state) return;
    setState(() => _state = state);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My jobs')),
      body: Column(
        children: [
          if (_offline) const OfflineBanner(isDemo: true),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'customer', label: Text('As customer')),
                ButtonSegment(value: 'provider', label: Text('As provider')),
              ],
              selected: {_role},
              onSelectionChanged: (s) => _setRole(s.first),
            ),
          ),
          SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: _stateFilters
                  .map((f) => Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: ChoiceChip(
                          label: Text(f.$2),
                          selected: _state == f.$1,
                          onSelected: (_) => _setState(f.$1),
                        ),
                      ))
                  .toList(),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null && _jobs.isEmpty
                    ? ErrorState(message: _error!, onRetry: _load)
                    : _jobs.isEmpty
                        ? EmptyState(
                            icon: Icons.history,
                            message:
                                'No jobs yet. Your jobs will appear here with a Rebook button.',
                            action: ElevatedButton(
                              onPressed: () => context.push('/customer/home'),
                              child: const Text('Post your first request'),
                            ),
                          )
                        : RefreshIndicator(
                            onRefresh: _load,
                            child: ListView.separated(
                              padding: const EdgeInsets.all(16),
                              itemCount:
                                  _jobs.length + (_cursor != null ? 1 : 0),
                              separatorBuilder: (_, __) =>
                                  const SizedBox(height: 12),
                              itemBuilder: (_, i) {
                                if (i == _jobs.length) {
                                  return OutlinedButton(
                                    onPressed: _loadingMore
                                        ? null
                                        : _loadMore,
                                    child: Text(_loadingMore
                                        ? 'Loading…'
                                        : 'Load more'),
                                  );
                                }
                                return _JobCard(
                                  job: _jobs[i],
                                  role: _role,
                                );
                              },
                            ),
                          ),
          ),
        ],
      ),
    );
  }

}

class _JobCard extends StatelessWidget {
  const _JobCard({required this.job, required this.role});

  final Job job;
  final String role;

  @override
  Widget build(BuildContext context) {
    final otherName = role == 'provider'
        ? (job.customerName.isNotEmpty ? job.customerName : 'Customer')
        : (job.providerName.isNotEmpty ? job.providerName : 'Provider');
    final live = job.state == 'ACCEPTED' ||
        job.state == 'PROVIDER_EN_ROUTE' ||
        job.state == 'ARRIVED' ||
        job.state == 'IN_PROGRESS';
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
                    otherName,
                    style: const TextStyle(
                        fontWeight: FontWeight.w700, fontSize: 16),
                  ),
                ),
                Chip(label: Text(job.state.replaceAll('_', ' '))),
              ],
            ),
            if (job.categoryName.isNotEmpty)
              Text(job.categoryName,
                  style: const TextStyle(color: Colors.grey, fontSize: 13)),
            const SizedBox(height: 4),
            Text(
              Money.pkr(job.agreedPrice),
              style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  color: Color(0xFFD97706),
                  fontSize: 16),
            ),
            if (job.createdAt != null)
              Text(
                job.createdAt!.toLocal().toString().substring(0, 16),
                style: const TextStyle(color: Colors.grey, fontSize: 12),
              ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (live)
                  OutlinedButton(
                    onPressed: () =>
                        context.push('/customer/job/${job.id}', extra: job),
                    child: const Text('Track live'),
                  ),
                if (job.state == 'COMPLETED' && role == 'customer')
                  ElevatedButton(
                    onPressed: () => context.push(
                        '/customer/payment/${job.id}',
                        extra: job),
                    child: const Text('Pay'),
                  ),
                // Fix B: either side can rate while PAYMENT_SETTLED; the
                // second review moves the job to RATED.
                if (job.state == 'PAYMENT_SETTLED')
                  OutlinedButton(
                    onPressed: () => context.push(
                        role == 'provider'
                            ? '/provider/rating/${job.id}'
                            : '/customer/rating/${job.id}',
                        extra: job),
                    child: const Text('Rate'),
                  ),
                OutlinedButton(
                  onPressed: () =>
                      context.push('/customer/dispute/${job.id}'),
                  child: const Text('Dispute'),
                ),
                OutlinedButton(
                  onPressed: () => context.push('/customer/request'),
                  child: const Text('Rebook'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
