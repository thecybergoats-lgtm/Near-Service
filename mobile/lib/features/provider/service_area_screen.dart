import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/errors.dart';

/// Provider "Service area" (FIX 10): a centre pin + radius slider,
/// saved with PUT /providers/me/service-area as {center, radius_km}.
/// Only the radius form is sent (the backend requires exactly one of
/// radius or polygon — see ApiClient.updateServiceArea).
class ServiceAreaScreen extends ConsumerStatefulWidget {
  const ServiceAreaScreen({super.key});

  @override
  ConsumerState<ServiceAreaScreen> createState() => _ServiceAreaScreenState();
}

class _ServiceAreaScreenState extends ConsumerState<ServiceAreaScreen> {
  LatLng _center = const LatLng(AppConstants.quettaLat, AppConstants.quettaLng);
  double _radiusKm = AppConstants.defaultRadiusKm;
  bool _saving = false;
  bool _locating = false;
  final _mapController = MapController();

  Future<void> _useMyLocation() async {
    setState(() => _locating = true);
    try {
      final pos = await Geolocator.getCurrentPosition();
      setState(() {
        _center = LatLng(pos.latitude, pos.longitude);
      });
      _mapController.move(_center, 13);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text(
                  'Could not read your location — move the pin manually.')),
        );
      }
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await ref.read(apiClientProvider).updateServiceArea(
            lat: _center.latitude,
            lng: _center.longitude,
            radiusKm: _radiusKm,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(
                  'Service area saved: ${_radiusKm.toStringAsFixed(0)} km around your pin.')),
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
      appBar: AppBar(title: const Text('Service area')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Tap the map to move your centre pin. Customers inside the circle can see you.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 300,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: FlutterMap(
                mapController: _mapController,
                options: MapOptions(
                  initialCenter: _center,
                  initialZoom: 13,
                  onTap: (_, point) => setState(() => _center = point),
                ),
                children: [
                  TileLayer(
                    urlTemplate:
                        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: AppConstants.packageName,
                  ),
                  CircleLayer(
                    circles: [
                      CircleMarker(
                        point: _center,
                        radius: _radiusKm * 1000,
                        useRadiusInMeter: true,
                        color: const Color(0xFF0F766E).withOpacity(0.15),
                        borderColor: const Color(0xFF0F766E),
                        borderStrokeWidth: 2,
                      ),
                    ],
                  ),
                  MarkerLayer(
                    markers: [
                      Marker(
                        point: _center,
                        width: 44,
                        height: 44,
                        child: const Icon(Icons.location_pin,
                            color: Color(0xFFD97706), size: 40),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Radius', style: TextStyle(fontWeight: FontWeight.w700)),
              Text('${_radiusKm.toStringAsFixed(0)} km',
                  style: const TextStyle(fontWeight: FontWeight.w700)),
            ],
          ),
          Slider(
            value: _radiusKm,
            min: 1,
            max: 25,
            divisions: 24,
            label: '${_radiusKm.toStringAsFixed(0)} km',
            onChanged: (v) => setState(() => _radiusKm = v),
          ),
          const Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('1 km', style: TextStyle(color: Colors.grey, fontSize: 12)),
              Text('25 km', style: TextStyle(color: Colors.grey, fontSize: 12)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Centre: ${_center.latitude.toStringAsFixed(4)}, ${_center.longitude.toStringAsFixed(4)}',
            style: const TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: _locating ? null : _useMyLocation,
            icon: const Icon(Icons.my_location_outlined),
            label: Text(_locating ? 'Locating…' : 'Use my current location'),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _saving ? null : _save,
              child: Text(_saving ? 'Saving…' : 'Save service area'),
            ),
          ),
        ],
      ),
    );
  }
}
