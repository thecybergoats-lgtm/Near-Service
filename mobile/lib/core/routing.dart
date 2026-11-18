import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';

/// In-app driving directions via the free OSRM demo server
/// (https://router.project-osrm.org — no key, no account).
///
/// The route is drawn on the app's own flutter_map as a polyline — the
/// app never opens an external Maps app for directions. OSRM is a public
/// demo service: it can be slow or unavailable, so a failure returns null
/// and the caller shows "route nahi mil saka" while the map stays usable.
class RouteResult {
  const RouteResult({
    required this.points,
    required this.distanceKm,
    required this.durationMin,
  });

  /// Route geometry as [lat, lng] points (OSRM returns [lng, lat]).
  final List<LatLng> points;
  final double distanceKm;
  final int durationMin;
}

/// Fetch a driving route from [from] to [to]. Returns null on any failure
/// (non-200, empty routes, bad geometry, timeout, network error).
Future<RouteResult?> fetchDrivingRoute(LatLng from, LatLng to) async {
  final uri = Uri.parse(
    'https://router.project-osrm.org/route/v1/driving/'
    '${from.longitude},${from.latitude};${to.longitude},${to.latitude}'
    '?overview=full&geometries=geojson',
  );
  try {
    final res = await http
        .get(uri, headers: {'User-Agent': 'NearService/1.0'})
        .timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) return null;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final routes = body['routes'] as List?;
    if (routes == null || routes.isEmpty) return null;
    final route = routes.first as Map<String, dynamic>;
    final coords =
        (route['geometry'] as Map?)?['coordinates'] as List? ?? [];
    final points = coords
        .map((c) => LatLng(
              (c[1] as num).toDouble(),
              (c[0] as num).toDouble(),
            ))
        .toList();
    if (points.isEmpty) return null;
    return RouteResult(
      points: points,
      distanceKm: (route['distance'] as num).toDouble() / 1000,
      durationMin: ((route['duration'] as num).toDouble() / 60).round(),
    );
  } catch (_) {
    return null;
  }
}
