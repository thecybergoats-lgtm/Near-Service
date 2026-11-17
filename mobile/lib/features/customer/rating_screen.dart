import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

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
  // Batch 2 — photo reviews (max 3). Photos are picked from the
  // gallery, uploaded via the signed-URL flow (same as dispute
  // evidence: request upload URL, PUT bytes, attach the storage key
  // as photo_keys), then submitted with the review.
  final List<XFile> _photos = [];
  bool _uploadingPhotos = false;
  String? _photoNote;

  static const _allTags = [
    'On time', 'Good work', 'Fair price', 'Polite', 'Clean work', 'Late', 'Price changed',
  ];

  Future<void> _pickPhoto() async {
    if (_photos.length >= 3) {
      setState(() => _photoNote = 'Maximum 3 photos.');
      return;
    }
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1280,
        imageQuality: 80,
      );
      // Null = the user cancelled the picker — not an error.
      if (picked == null) return;
      setState(() {
        _photos.add(picked);
        _photoNote = null;
      });
    } on PlatformException {
      // Permission denied (or picker unavailable): plain message,
      // the review still works without a photo.
      setState(() => _photoNote =
          'Photo access is off — allow photo access in settings, or submit the review without a photo.');
    } catch (_) {
      setState(() => _photoNote = 'Could not pick that photo. Try another one.');
    }
  }

  /// Uploads the picked photos and returns their storage keys.
  /// A failed upload-request (endpoint not live yet) or a failed PUT
  /// skips that photo instead of failing the review.
  Future<List<String>> _uploadPhotos() async {
    final api = ref.read(apiClientProvider);
    final keys = <String>[];
    for (final photo in _photos) {
      try {
        final up = await api.requestReviewPhotoUpload(widget.jobId);
        if (up.uploadUrl.isEmpty || up.storageKey.isEmpty) continue;
        final bytes = await File(photo.path).readAsBytes();
        final ok = await api.uploadPhotoBytes(up.uploadUrl, bytes);
        if (ok) keys.add(up.storageKey);
      } catch (_) {
        // Skip this photo; the review goes through without it.
      }
    }
    return keys;
  }

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _error = null;
      _photoNote = null;
    });
    try {
      List<String> photoKeys = const [];
      if (_photos.isNotEmpty) {
        setState(() => _uploadingPhotos = true);
        photoKeys = await _uploadPhotos();
        if (photoKeys.length < _photos.length && mounted) {
          setState(() => _photoNote =
              'Some photos could not be uploaded — the review is submitted with the ones that did.');
        }
        if (mounted) setState(() => _uploadingPhotos = false);
      }
      await ref.read(apiClientProvider).submitReview(
            widget.jobId,
            _stars,
            _tags.toList(),
            _commentController.text.trim(),
            photoKeys: photoKeys,
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
            const SizedBox(height: 16),
            const Text('Photos of the work (optional, max 3)',
                style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Row(
              children: [
                ..._photos.map((p) => Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Stack(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: Image.file(
                              File(p.path),
                              width: 72,
                              height: 72,
                              fit: BoxFit.cover,
                            ),
                          ),
                          Positioned(
                            right: 0,
                            top: 0,
                            child: GestureDetector(
                              onTap: () => setState(() => _photos.remove(p)),
                              child: Container(
                                decoration: const BoxDecoration(
                                  color: Colors.black54,
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(Icons.close,
                                    size: 18, color: Colors.white),
                              ),
                            ),
                          ),
                        ],
                      ),
                    )),
                if (_photos.length < 3)
                  OutlinedButton.icon(
                    onPressed: _submitting ? null : _pickPhoto,
                    icon: const Icon(Icons.add_a_photo_outlined),
                    label: const Text('Add photo'),
                  ),
              ],
            ),
            if (_photoNote != null) ...[
              const SizedBox(height: 8),
              Text(_photoNote!,
                  style: const TextStyle(color: Colors.grey, fontSize: 13)),
            ],
            if (_uploadingPhotos) ...[
              const SizedBox(height: 8),
              const Row(
                children: [
                  SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 8),
                  Text('Uploading photos…',
                      style: TextStyle(fontSize: 13)),
                ],
              ),
            ],
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
