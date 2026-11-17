/// Backend error shape: { "error": { "code": "...", "message": "..." },
/// "request_id": "..." } (OpenAPI Error schema, PRD v1.1).
/// All API failures surface as [ApiException].
class ApiException implements Exception {
  final String code;
  final String message;
  final int? statusCode;

  const ApiException(this.code, this.message, [this.statusCode]);

  @override
  String toString() => message;

  /// Friendly, user-facing text for the common backend codes.
  String get userMessage {
    switch (code) {
      case 'OFFER_EXPIRED':
        return 'This offer has expired. Please post a new request.';
      case 'REQUEST_CLOSED':
        return 'This request is already closed.';
      case 'RATE_LIMITED':
        return 'Too many attempts. Please wait a minute and try again.';
      case 'INVALID_OTP':
        return 'Wrong code. Please check and try again.';
      case 'OTP_EXPIRED':
        return 'The code has expired. Request a new one.';
      case 'NETWORK':
        return 'No internet connection. Showing saved data.';
      default:
        return message.isNotEmpty ? message : 'Something went wrong. Try again.';
    }
  }
}

class NetworkException extends ApiException {
  const NetworkException()
      : super('NETWORK', 'No internet connection. Showing saved data.');
}
