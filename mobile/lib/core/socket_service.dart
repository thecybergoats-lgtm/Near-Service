import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'constants.dart';

/// Socket.IO client (PRD p.25). Rooms: request:{id}, job:{id}, user:{id}.
/// Events: offer.received, offer.updated, job.state_changed, offer.closed,
/// chat.message, provider.location, notification.
/// Reconnects automatically; all callbacks are null-safe so a dropped
/// socket never crashes the UI — the screens also poll as a fallback.
class SocketService {
  io.Socket? _socket;
  bool get isConnected => _socket?.connected ?? false;

  final Map<String, List<void Function(dynamic)>> _handlers = {};

  Future<void> connect() async {
    if (isConnected) return;
    const storage = FlutterSecureStorage();
    final token = await storage.read(key: StorageKeys.accessToken);
    _socket = io.io(
      AppConstants.socketUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .enableAutoConnect()
          .setAuth({'token': token})
          .build(),
    );
    _socket!.onConnect((_) {
      for (final entry in _handlers.entries) {
        _socket!.on(entry.key, (data) {
          for (final cb in entry.value) {
            cb(data);
          }
        });
      }
    });
    _socket!.connect();
  }

  void on(String event, void Function(dynamic) handler) {
    _handlers.putIfAbsent(event, () => []).add(handler);
    _socket?.on(event, (data) => handler(data));
  }

  void off(String event) {
    _handlers.remove(event);
    _socket?.off(event);
  }

  void joinRoom(String room) => _socket?.emit('join', {'room': room});
  void leaveRoom(String room) => _socket?.emit('leave', {'room': room});

  void sendHeartbeat(double lat, double lng) =>
      _socket?.emit('presence.heartbeat', {'lat': lat, 'lng': lng});

  /// Phase 2 — provider live location for one job. The provider app
  /// emits this while EN_ROUTE only; the server re-broadcasts it to the
  /// job room as 'provider.location' {job_id, lat, lng, at,
  /// distance_km, eta_minutes}. The customer tracking screen listens
  /// for that event. Emitting stops at ARRIVED / completion — see
  /// ActiveJobScreen for the adaptive interval (moving 10–15 s,
  /// stationary 60 s+).
  void emitProviderLocation(String jobId, double lat, double lng) =>
      _socket?.emit('provider.location', {
        'job_id': jobId,
        'lat': lat,
        'lng': lng,
      });

  void sendTyping(String chatId) =>
      _socket?.emit('typing', {'chat_id': chatId});

  void disconnect() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }
}

final socketServiceProvider = Provider<SocketService>((ref) {
  final service = SocketService();
  ref.onDispose(service.disconnect);
  return service;
});
