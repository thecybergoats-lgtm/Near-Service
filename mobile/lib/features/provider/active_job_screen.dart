import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/socket_service.dart';
import '../common/widgets.dart';

/// Provider active job (PRD p.22): stepper, navigate, chat/call,
/// state transitions via POST /jobs/{id}/transition, complete.
///
/// Phase 2 — live location: while the job is PROVIDER_EN_ROUTE the
/// app emits 'provider.location' {job_id, lat, lng} over Socket.IO so
/// the customer sees a live marker, distance and ETA on the tracking
/// screen. Adaptive interval (documented here and in the code):
/// - moving (moved > 50 m since the last emit): every 10–15 s.
/// - stationary (moved < 10 m): backs off to 60 s+ between emits, so
///   a parked provider does not spam the socket.
/// Emitting starts on entering EN_ROUTE and stops at ARRIVED (or
/// completion / screen dispose) — never after arrival.
class ActiveJobScreen extends ConsumerStatefulWidget {
  const ActiveJobScreen({super.key, required this.jobId});

  final String jobId;

  @override
  ConsumerState<ActiveJobScreen> createState() => _ActiveJobScreenState();
}

class _ActiveJobScreenState extends ConsumerState<ActiveJobScreen> {
  String _state = 'ACCEPTED';
  bool _busy = false;
  bool _sharingLocation = false;

  // Live-location emission state (EN_ROUTE only).
  Timer? _locationTimer;
  LatLng? _lastEmitted;
  int _stationaryTicks = 0;

  static const _nextState = {
    'ACCEPTED': 'PROVIDER_EN_ROUTE',
    'PROVIDER_EN_ROUTE': 'ARRIVED',
    'ARRIVED': 'IN_PROGRESS',
    'IN_PROGRESS': 'COMPLETED',
  };

  static const _nextLabel = {
    'ACCEPTED': "I'm on my way",
    'PROVIDER_EN_ROUTE': "I've arrived",
    'ARRIVED': 'Start work',
    'IN_PROGRESS': 'Kaam ho gaya',
  };

  @override
  void dispose() {
    _stopLocationSharing();
    super.dispose();
  }

  /// Starts adaptive location emission. Called when entering
  /// PROVIDER_EN_ROUTE; a no-op otherwise.
  void _startLocationSharing() {
    if (_sharingLocation) return;
    _sharingLocation = true;
    _lastEmitted = null;
    _stationaryTicks = 0;
    _scheduleLocationTick(const Duration(seconds: 10));
    if (mounted) setState(() {});
  }

  /// Stops emission. Called on ARRIVED, completion and dispose.
  void _stopLocationSharing() {
    _locationTimer?.cancel();
    _locationTimer = null;
    _sharingLocation = false;
    _lastEmitted = null;
    _stationaryTicks = 0;
  }

  void _scheduleLocationTick(Duration delay) {
    _locationTimer?.cancel();
    _locationTimer = Timer(delay, _emitLocationTick);
  }

  /// One emission tick: read the device position, compare with the
  /// last emitted point, emit when the provider moved, and pick the
  /// next interval — 10–15 s while moving, 60 s+ while stationary.
  Future<void> _emitLocationTick() async {
    if (!_sharingLocation || _state != 'PROVIDER_EN_ROUTE') {
      _stopLocationSharing();
      if (mounted) setState(() {});
      return;
    }
    Duration nextDelay = const Duration(seconds: 12);
    try {
      final pos = await Geolocator.getCurrentPosition();
      final current = LatLng(pos.latitude, pos.longitude);
      final last = _lastEmitted;
      final movedMetres = last == null
          ? double.infinity
          : const Distance().as(LengthUnit.Meter, last, current);
      if (last == null || movedMetres > 50) {
        // Moving (or first fix): emit now, keep the short interval.
        ref
            .read(socketServiceProvider)
            .emitProviderLocation(widget.jobId, pos.latitude, pos.longitude);
        _lastEmitted = current;
        _stationaryTicks = 0;
        nextDelay = const Duration(seconds: 12);
      } else if (movedMetres < 10) {
        // Stationary: count up and back off to 60 s+.
        _stationaryTicks++;
        nextDelay = _stationaryTicks >= 3
            ? const Duration(seconds: 60)
            : const Duration(seconds: 15);
      } else {
        // Small drift (10–50 m): emit, short interval.
        ref
            .read(socketServiceProvider)
            .emitProviderLocation(widget.jobId, pos.latitude, pos.longitude);
        _lastEmitted = current;
        _stationaryTicks = 0;
        nextDelay = const Duration(seconds: 15);
      }
    } catch (_) {
      // Location unavailable this tick — retry on the short interval;
      // the customer still sees the last known point + job status.
      nextDelay = const Duration(seconds: 15);
    }
    if (_sharingLocation && mounted) {
      _scheduleLocationTick(nextDelay);
    }
  }

  Future<void> _advance() async {
    final next = _nextState[_state];
    if (next == null) return;
    setState(() => _busy = true);
    try {
      // Batch 2 (J1): marking the work done uses the provider-only
      // POST /jobs/:id/complete ("Kaam ho gaya") — not the generic
      // transition. The customer's confirmation is a separate call.
      final job = next == 'COMPLETED'
          ? await ref.read(apiClientProvider).completeJob(widget.jobId)
          : await ref.read(apiClientProvider).transitionJob(widget.jobId, next);
      _applyState(job.state);
    } on ApiException catch (e) {
      // Demo job id has no backend job — advance locally so the flow is demonstrable.
      if (widget.jobId.startsWith('demo-')) {
        _applyState(next);
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _applyState(String next) {
    setState(() => _state = next);
    if (next == 'PROVIDER_EN_ROUTE') {
      _startLocationSharing();
    } else {
      // ARRIVED / IN_PROGRESS / COMPLETED: stop sharing.
      _stopLocationSharing();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Active job')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Job ${widget.jobId}', style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  const Text('Status updates are written to the job event log (PRD p.8).',
                      style: TextStyle(color: Colors.grey, fontSize: 13)),
                  if (_sharingLocation) ...[
                    const SizedBox(height: 8),
                    const Row(
                      children: [
                        Icon(Icons.location_on, size: 16, color: Color(0xFF0F766E)),
                        SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            'Sharing your live location with the customer while you travel.',
                            style: TextStyle(fontSize: 13, color: Color(0xFF0F766E)),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          JobStepper(currentState: _state),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => context.push('/customer/chat/${widget.jobId}',
                      extra: {'peerName': 'Customer'}),
                  icon: const Icon(Icons.chat_bubble_outline),
                  label: const Text('Chat'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Open navigation in your maps app — live tracking uses the same pin.')),
                    );
                  },
                  icon: const Icon(Icons.navigation_outlined),
                  label: const Text('Navigate'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_nextState[_state] != null)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _busy ? null : _advance,
                child: Text(_nextLabel[_state] ?? 'Next'),
              ),
            ),
          // FIX 10 — extra-work adjustments are only allowed while the
          // job is IN_PROGRESS (backend 409 NOT_IN_PROGRESS otherwise).
          if (_state == 'IN_PROGRESS') ...[
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () => context.push(
                    '/provider/adjustment/${widget.jobId}'),
                icon: const Icon(Icons.add_circle_outline),
                label: const Text('Request extra work'),
              ),
            ),
          ],
          if (_state == 'COMPLETED') ...[
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Work done — collect cash from the customer.',
                        style: TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    const Text(
                      'The customer confirms completion in their app ("Confirm karo") — payment settles only after their confirmation. Commission (default 10%) is recorded against your wallet.',
                      style: TextStyle(color: Colors.grey, fontSize: 13),
                    ),
                    const SizedBox(height: 12),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        onPressed: () => context.go('/provider/dashboard'),
                        child: const Text('Back to dashboard'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
          // Fix B — rate the customer once payment has settled. The
          // second review (either side) moves the job to RATED; after
          // RATED the backend refuses further reviews (409).
          if (_state == 'PAYMENT_SETTLED') ...[
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => context.push('/provider/rating/${widget.jobId}'),
                child: const Text('Rate customer'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
