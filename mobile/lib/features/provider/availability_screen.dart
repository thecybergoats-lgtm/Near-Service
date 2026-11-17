import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';

/// Provider "Working hours" (FIX 10): one slot per weekday
/// (0 = Monday … 6 = Sunday), saved with PUT /providers/me/availability.
/// A day-off slot sends opens/closes null (backend 422 otherwise).
class AvailabilityScreen extends ConsumerStatefulWidget {
  const AvailabilityScreen({super.key});

  @override
  ConsumerState<AvailabilityScreen> createState() => _AvailabilityScreenState();
}

class _AvailabilityScreenState extends ConsumerState<AvailabilityScreen> {
  // Weekday -> editable slot. No GET endpoint exists for availability,
  // so the screen starts at the common default (Mon–Sat 09:00–18:00,
  // Sunday off) and PUT replaces the whole week.
  final Map<int, AvailabilitySlot> _slots = {
    for (var d = 0; d < 7; d++)
      d: AvailabilitySlot(
        weekday: d,
        opens: d == 6 ? null : '09:00',
        closes: d == 6 ? null : '18:00',
        isDayOff: d == 6,
      ),
  };
  bool _saving = false;

  String _fmt(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  TimeOfDay _parse(String? hhmm, TimeOfDay fallback) {
    if (hhmm == null) return fallback;
    final parts = hhmm.split(':');
    if (parts.length != 2) return fallback;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null) return fallback;
    return TimeOfDay(hour: h, minute: m);
  }

  Future<void> _pickTime(int weekday, bool isOpens) async {
    final slot = _slots[weekday]!;
    final picked = await showTimePicker(
      context: context,
      initialTime: _parse(
        isOpens ? slot.opens : slot.closes,
        isOpens
            ? const TimeOfDay(hour: 9, minute: 0)
            : const TimeOfDay(hour: 18, minute: 0),
      ),
    );
    if (picked == null) return;
    setState(() {
      _slots[weekday] = slot.copyWith(
        opens: isOpens ? _fmt(picked) : slot.opens,
        closes: isOpens ? slot.closes : _fmt(picked),
      );
    });
  }

  Future<void> _save() async {
    final slots = _slots.values.toList()..sort((a, b) => a.weekday.compareTo(b.weekday));
    for (final s in slots) {
      if (!s.isDayOff && (s.opens == null || s.closes == null)) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Pick opening and closing times for ${s.weekdayName}.')),
        );
        return;
      }
    }
    setState(() => _saving = true);
    try {
      await ref.read(apiClientProvider).updateAvailability(slots);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Working hours saved.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Working hours')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Set your hours for each day. Customers only see you as open inside these hours.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 12),
          ...List.generate(7, (weekday) {
            final slot = _slots[weekday]!;
            return Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    SwitchListTile(
                      title: Text(slot.weekdayName,
                          style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text(slot.isDayOff
                          ? 'Day off'
                          : '${slot.opens ?? '—'} – ${slot.closes ?? '—'}'),
                      value: !slot.isDayOff,
                      onChanged: (open) => setState(() {
                        _slots[weekday] = slot.copyWith(
                          isDayOff: !open,
                          opens: open ? (slot.opens ?? '09:00') : null,
                          closes: open ? (slot.closes ?? '18:00') : null,
                        );
                      }),
                    ),
                    if (!slot.isDayOff)
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => _pickTime(weekday, true),
                              child: Text('Opens ${slot.opens ?? '09:00'}'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => _pickTime(weekday, false),
                              child: Text('Closes ${slot.closes ?? '18:00'}'),
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            );
          }),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _saving ? null : _save,
              child: Text(_saving ? 'Saving…' : 'Save working hours'),
            ),
          ),
        ],
      ),
    );
  }
}
