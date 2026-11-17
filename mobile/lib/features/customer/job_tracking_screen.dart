import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../../core/socket_service.dart';
import '../common/widgets.dart';

/// Job tracking (PRD p.22, Phase 2): stepper + live map + ETA, SOS
/// button, share-status link, price-adjustment approval entry.
/// Live provider marker: the provider app emits 'provider.location'
/// while EN_ROUTE and the server re-broadcasts it to the job room;
/// this screen listens for it and moves the marker, distance and ETA
/// live. The trail polyline comes from GET /jobs/{id}/tracking, with
/// a 15 s poll as a fallback when the socket drops.
class JobTrackingScreen extends ConsumerStatefulWidget {
  const JobTrackingScreen({super.key, required this.jobId, this.initial});

  final String jobId;
  final Job? initial;

  @override
  ConsumerState<JobTrackingScreen> createState() => _JobTrackingScreenState();
}

class _JobTrackingScreenState extends ConsumerState<JobTrackingScreen> {
  Job? _job;
  JobTracking? _tracking;
  bool _sosSent = false;
  bool _trackingError = false;
  Timer? _pollTimer;
  DateTime? _lastLocationAt;

  @override
  void initState() {
    super.initState();
    _job = widget.initial;
    _loadTracking();
    _pollTimer =
        Timer.periodic(const Duration(seconds: 15), (_) => _loadTracking());
    final socket = ref.read(socketServiceProvider);
    socket.connect();
    socket.joinRoom('job:${widget.jobId}');
    socket.on('job.state_changed', (data) {
      if (data is Map && mounted) {
        setState(() {
          _job = Job(
            id: _job?.id ?? widget.jobId,
            requestId: _job?.requestId ?? '',
            state: (data['to'] ?? data['state'] ?? _job?.state ?? 'ACCEPTED')
                .toString(),
            agreedPrice: _job?.agreedPrice ?? 0,
            providerName: _job?.providerName ?? '',
            providerId: _job?.providerId ?? '',
          );
        });
      }
    });
    socket.on('provider.location', (data) {
      if (data is! Map || !mounted) return;
      if ((data['job_id'] ?? '').toString() != widget.jobId) return;
      final lat = (data['lat'] as num?)?.toDouble();
      final lng = (data['lng'] as num?)?.toDouble();
      if (lat == null || lng == null) return;
      setState(() {
        final old = _tracking;
        _tracking = JobTracking(
          jobId: widget.jobId,
          state: _job?.state ?? old?.state ?? '',
          providerLat: lat,
          providerLng: lng,
          providerUpdatedAt: data['at'] == null
              ? DateTime.now()
              : DateTime.tryParse(data['at'].toString()),
          distanceKm: (data['distance_km'] as num?)?.toDouble() ??
              old?.distanceKm,
          etaMinutes: (data['eta_minutes'] as num?)?.toInt() ?? old?.etaMinutes,
          trail: [
            ...?old?.trail,
            TrailPoint(lat: lat, lng: lng, at: DateTime.now()),
          ],
        );
        _lastLocationAt = DateTime.now();
      });
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    ref.read(socketServiceProvider).leaveRoom('job:${widget.jobId}');
    super.dispose();
  }

  Future<void> _loadTracking() async {
    try {
      final tracking =
          await ref.read(apiClientProvider).getJobTracking(widget.jobId);
      if (!mounted) return;
      setState(() {
        // Keep live socket points that arrived after this snapshot.
        final liveTrail = _tracking?.trail ?? const <TrailPoint>[];
        final merged = [
          ...tracking.trail,
          ...liveTrail.where((p) =>
              !tracking.trail.any((t) =>
                  (t.lat - p.lat).abs() < 0.00001 &&
                  (t.lng - p.lng).abs() < 0.00001)),
        ];
        _tracking = JobTracking(
          jobId: tracking.jobId,
          state: tracking.state,
          providerLat: tracking.providerLat ?? _tracking?.providerLat,
          providerLng: tracking.providerLng ?? _tracking?.providerLng,
          providerUpdatedAt:
              tracking.providerUpdatedAt ?? _tracking?.providerUpdatedAt,
          distanceKm: tracking.distanceKm ?? _tracking?.distanceKm,
          etaMinutes: tracking.etaMinutes ?? _tracking?.etaMinutes,
          trail: merged,
        );
        _trackingError = false;
      });
    } catch (_) {
      // Socket updates keep the map live; a failed poll is not fatal.
      if (mounted) setState(() => _trackingError = true);
    }
  }

  /// FIX 10 — SOS is gated on having at least one trusted contact:
  /// SOS alerts those contacts, so firing it with an empty list would
  /// alert nobody. When the list is empty, offer to add a contact
  /// first instead of sending.
  Future<void> _sos() async {
    try {
      final contacts =
          await ref.read(apiClientProvider).listTrustedContacts();
      if (contacts.isEmpty && mounted) {
        final goAdd = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Add a trusted contact first'),
            content: const Text(
                'SOS shares your live location with your trusted contacts, and you have none yet. Add at least one contact, then tap SOS again.'),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('Not now')),
              TextButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Add contact')),
            ],
          ),
        );
        if (goAdd == true && mounted) {
          await context.push('/customer/trusted-contacts');
        }
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      await ref
          .read(apiClientProvider)
          .sendSos(widget.jobId, pos.latitude, pos.longitude);
      setState(() => _sosSent = true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text(
                  'SOS sent — your live location was shared with trusted contacts and support.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  Future<void> _showRescheduleSheet() async {
    final rescheduled = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => RescheduleSheet(jobId: widget.jobId),
    );
    if (rescheduled == true && mounted) _loadTracking();
  }

  @override
  Widget build(BuildContext context) {
    final job = _job;
    final state = job?.state ?? 'ACCEPTED';
    final tracking = _tracking;
    final providerPoint = tracking != null && tracking.hasProviderLocation
        ? LatLng(tracking.providerLat!, tracking.providerLng!)
        : null;
    final trailPoints = (tracking?.trail ?? [])
        .map((p) => LatLng(p.lat, p.lng))
        .toList();
    final mapCenter = providerPoint ??
        const LatLng(AppConstants.quettaLat, AppConstants.quettaLng);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Track your job'),
        actions: [
          IconButton(
            icon: Icon(Icons.sos, color: _sosSent ? Colors.green : Colors.red),
            tooltip: 'SOS',
            onPressed: _sos,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        job?.providerName.isNotEmpty == true
                            ? job!.providerName
                            : 'Your provider',
                        style: const TextStyle(
                            fontWeight: FontWeight.w700, fontSize: 17),
                      ),
                      Text(Money.pkr(job?.agreedPrice ?? 0),
                          style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              color: Color(0xFFD97706),
                              fontSize: 17)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    state == 'PROVIDER_EN_ROUTE'
                        ? 'Provider is on the way'
                        : 'Status: $state',
                    style: const TextStyle(color: Colors.grey),
                  ),
                  if (providerPoint != null) ...[
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        const Icon(Icons.navigation_outlined,
                            size: 16, color: Color(0xFF0F766E)),
                        const SizedBox(width: 6),
                        Text(
                          'Live location'
                          '${tracking?.distanceKm != null ? ' · ${tracking!.distanceKm!.toStringAsFixed(1)} km away' : ''}'
                          '${tracking?.etaMinutes != null ? ' · ETA ~${tracking!.etaMinutes} min' : ''}',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                    if (_lastLocationAt != null)
                      Text(
                        'Location updated ${_lastLocationAt!.toLocal().toString().substring(11, 19)}',
                        style:
                            const TextStyle(color: Colors.grey, fontSize: 12),
                      ),
                  ] else if (state == 'PROVIDER_EN_ROUTE')
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text(
                        'Waiting for the provider’s live location…',
                        style: TextStyle(color: Colors.grey, fontSize: 13),
                      ),
                    ),
                  if (_trackingError && providerPoint == null)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text(
                        'Live tracking is unavailable right now — the job status above is still current.',
                        style: TextStyle(color: Colors.grey, fontSize: 13),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            height: 220,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: FlutterMap(
                options: MapOptions(
                  initialCenter: mapCenter,
                  initialZoom: 13,
                ),
                children: [
                  TileLayer(
                    urlTemplate:
                        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: AppConstants.packageName,
                  ),
                  if (trailPoints.length >= 2)
                    PolylineLayer(
                      polylines: [
                        Polyline(
                          points: trailPoints,
                          color: const Color(0xFF0F766E),
                          strokeWidth: 4,
                        ),
                      ],
                    ),
                  MarkerLayer(
                    markers: [
                      const Marker(
                        point: LatLng(
                            AppConstants.quettaLat, AppConstants.quettaLng),
                        width: 44,
                        height: 44,
                        child: Icon(Icons.location_pin,
                            color: Color(0xFF0F766E), size: 40),
                      ),
                      if (providerPoint != null)
                        Marker(
                          point: providerPoint,
                          width: 44,
                          height: 44,
                          child: Container(
                            decoration: BoxDecoration(
                              color: const Color(0xFFD97706),
                              shape: BoxShape.circle,
                              border:
                                  Border.all(color: Colors.white, width: 2),
                            ),
                            child: const Icon(Icons.build,
                                color: Colors.white, size: 22),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          JobStepper(currentState: state),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => context.push(
                      '/customer/chat/${widget.jobId}',
                      extra: {'peerName': job?.providerName ?? 'Provider'}),
                  icon: const Icon(Icons.chat_bubble_outline),
                  label: const Text('Chat'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                          content: Text(
                              'Share link copied — family can follow this job live.')),
                    );
                  },
                  icon: const Icon(Icons.share),
                  label: const Text('Share status'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _showRescheduleSheet,
                  icon: const Icon(Icons.schedule),
                  label: const Text('Reschedule'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () =>
                      context.push('/customer/dispute/${widget.jobId}'),
                  icon: const Icon(Icons.report_problem_outlined),
                  label: const Text('Dispute'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (state == 'COMPLETED')
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => context.push(
                    '/customer/payment/${widget.jobId}',
                    extra: job),
                child: const Text('Proceed to payment'),
              ),
            ),
          if (state == 'PAYMENT_SETTLED')
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => context.push(
                    '/customer/rating/${widget.jobId}',
                    extra: job),
                child: const Text('Rate your provider'),
              ),
            ),
        ],
      ),
    );
  }
}

/// Reschedule sheet: pick a new date/time + reason. If the work itself
/// changed, the customer ticks "scope changed" — the backend answers
/// 409 SCOPE_CHANGED_REQUIRES_RENEGOTIATION and the sheet says plainly
/// that the price must be renegotiated instead of silently rescheduling.
class RescheduleSheet extends ConsumerStatefulWidget {
  const RescheduleSheet({super.key, required this.jobId});

  final String jobId;

  @override
  ConsumerState<RescheduleSheet> createState() => _RescheduleSheetState();
}

class _RescheduleSheetState extends ConsumerState<RescheduleSheet> {
  DateTime _date = DateTime.now().add(const Duration(days: 1));
  TimeOfDay _time = const TimeOfDay(hour: 10, minute: 0);
  final _reasonController = TextEditingController();
  bool _scopeChanged = false;
  bool _busy = false;
  String? _error;

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 60)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time);
    if (picked != null) setState(() => _time = picked);
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final scheduledAt = DateTime(
        _date.year, _date.month, _date.day, _time.hour, _time.minute);
    try {
      await ref.read(apiClientProvider).rescheduleJob(
            widget.jobId,
            scheduledAt: scheduledAt,
            reason: _reasonController.text.trim().isEmpty
                ? null
                : _reasonController.text.trim(),
            scopeChanged: _scopeChanged,
          );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      setState(() => _error = e.code == 'SCOPE_CHANGED_REQUIRES_RENEGOTIATION'
          ? 'The work changed, so the price must be renegotiated first — rescheduling alone will not apply. Please counter the price with the provider.'
          : e.userMessage);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: ListView(
        shrinkWrap: true,
        children: [
          const Text('Reschedule',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _pickDate,
                  child: Text(
                      'Date: ${_date.toLocal().toString().substring(0, 10)}'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _pickTime,
                  child: Text('Time: ${_time.format(context)}'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _reasonController,
            decoration: const InputDecoration(
                labelText: 'Reason (optional)',
                hintText: 'e.g. I will be out that day'),
          ),
          CheckboxListTile(
            title: const Text('The work itself has changed'),
            subtitle: const Text(
                'If the work changes, the price must be renegotiated — rescheduling alone will not apply.'),
            value: _scopeChanged,
            onChanged: (v) => setState(() => _scopeChanged = v ?? false),
          ),
          if (_error != null)
            Text(_error!, style: const TextStyle(color: Colors.red)),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Saving…' : 'Save new time'),
            ),
          ),
        ],
      ),
    );
  }
}
