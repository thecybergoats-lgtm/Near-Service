import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/errors.dart';
import '../../core/models.dart';

/// Provider onboarding wizard — resumable, 4 steps (PRD p.5):
/// 1 identity, 2 business, 3 service area, 4 payout.
/// Phase 1 verification is MANUAL review only (PRD v1.1):
/// CNIC photos + selfie are collected for a human verification officer.
/// Each step is sent as {step, data} per the OpenAPI contract, with
/// step one of identity | business | service_area | payout.
class ProviderOnboardingWizard extends ConsumerStatefulWidget {
  const ProviderOnboardingWizard({super.key});

  @override
  ConsumerState<ProviderOnboardingWizard> createState() => _ProviderOnboardingWizardState();
}

class _ProviderOnboardingWizardState extends ConsumerState<ProviderOnboardingWizard> {
  int _step = 0;
  bool _saving = false;
  String? _error;

  final _nameController = TextEditingController();
  final _cnicController = TextEditingController();
  final _shopController = TextEditingController();
  final _experienceController = TextEditingController(text: '5');
  String _providerType = 'INDIVIDUAL';
  final Set<String> _categories = {'book-binding'};
  List<Category> _wizardCategories = [];
  double _radiusKm = 5;
  String _payoutMethod = 'jazzcash';
  final _payoutController = TextEditingController();

  static const _stepNames = ['identity', 'business', 'service_area', 'payout'];

  @override
  void initState() {
    super.initState();
    _restoreStep();
    _loadCategories();
  }

  /// Category list for the checkboxes (names from the API tree;
  /// falls back to the launch slugs when offline).
  Future<void> _loadCategories() async {
    final cats = await ref.read(categoryResolverProvider).all();
    if (mounted && cats.isNotEmpty) {
      setState(() => _wizardCategories = cats);
    }
  }

  Future<void> _restoreStep() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getInt('ns_provider_onboarding_step') ?? 0;
    if (mounted) setState(() => _step = saved.clamp(0, 3));
  }

  Future<void> _saveStep() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt('ns_provider_onboarding_step', _step);
  }

  Future<void> _submitStep() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      // Category ids are UUIDs in the contract: resolve the selected
      // slugs through the category tree before sending.
      final resolver = ref.read(categoryResolverProvider);
      final categoryIds = <String>[];
      for (final slug in _categories) {
        // Only resolved UUIDs are sent; an unknown slug is dropped
        // rather than sent as a category id (PRD v1.1 identifier rule).
        final id = await resolver.idForSlug(slug);
        if (id != null) categoryIds.add(id);
      }
      final data = <String, dynamic>{
        if (_step == 0) ...{
          'legal_name': _nameController.text.trim(),
          'cnic': _cnicController.text.trim(),
        },
        if (_step == 1) ...{
          'provider_type': _providerType,
          'shop_name': _shopController.text.trim(),
          'experience_years': int.tryParse(_experienceController.text) ?? 0,
          'categories': categoryIds,
        },
        if (_step == 2) {'radius_km': _radiusKm},
        if (_step == 3) ...{
          'payout_method': _payoutMethod,
          'payout_account': _payoutController.text.trim(),
        },
      };
      await ref.read(apiClientProvider).submitProviderOnboarding(
            step: _stepNames[_step],
            data: data,
          );
      if (_step < 3) {
        setState(() => _step++);
        await _saveStep();
      } else {
        final prefs = await SharedPreferences.getInstance();
        await prefs.remove('ns_provider_onboarding_step');
        if (mounted) context.go('/provider/dashboard');
      }
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Become a provider')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Step ${_step + 1} of 4', style: const TextStyle(color: Colors.grey)),
            const SizedBox(height: 8),
            LinearProgressIndicator(value: (_step + 1) / 4),
            const SizedBox(height: 24),
            Expanded(child: _stepBody()),
            if (_error != null) ...[
              Text(_error!, style: const TextStyle(color: Colors.red)),
              const SizedBox(height: 8),
            ],
            Row(
              children: [
                if (_step > 0)
                  OutlinedButton(
                    onPressed: () async {
                      setState(() => _step--);
                      await _saveStep();
                    },
                    child: const Text('Back'),
                  ),
                const Spacer(),
                ElevatedButton(
                  onPressed: _saving ? null : _submitStep,
                  child: Text(_step == 3 ? 'Finish — submit for review' : 'Save & continue'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _stepBody() {
    switch (_step) {
      case 0:
        return ListView(
          children: [
            const Text('Identity', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text(
              'Your CNIC and selfie are reviewed manually by a verification officer. Nothing is auto-approved.',
              style: TextStyle(color: Colors.grey),
            ),
            const SizedBox(height: 16),
            TextField(controller: _nameController, decoration: const InputDecoration(labelText: 'Legal name (as on CNIC)')),
            const SizedBox(height: 12),
            TextField(
              controller: _cnicController,
              keyboardType: TextInputType.number,
              maxLength: 13,
              decoration: const InputDecoration(labelText: 'CNIC number (13 digits, no dashes)'),
            ),
            const SizedBox(height: 12),
            const Card(
              child: ListTile(
                leading: Icon(Icons.photo_camera_outlined),
                title: Text('CNIC front / back + selfie'),
                subtitle: Text('Photos are uploaded to private storage and seen masked by reviewers.'),
              ),
            ),
          ],
        );
      case 1:
        return ListView(
          children: [
            const Text('Business', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'INDIVIDUAL', label: Text('Individual')),
                ButtonSegment(value: 'SHOP', label: Text('Shop')),
              ],
              selected: {_providerType},
              onSelectionChanged: (s) => setState(() => _providerType = s.first),
            ),
            const SizedBox(height: 12),
            TextField(controller: _shopController, decoration: const InputDecoration(labelText: 'Shop name (if a shop)')),
            const SizedBox(height: 12),
            TextField(
              controller: _experienceController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Years of experience'),
            ),
            const SizedBox(height: 16),
            const Text('Categories you serve', style: TextStyle(fontWeight: FontWeight.w700)),
            ...(_wizardCategories.isEmpty
                    ? AppConstants.launchCategorySlugs.map((slug) => (slug: slug, label: slug))
                    : _wizardCategories.map((c) => (slug: c.slug, label: c.displayName('en'))))
                .map((c) => CheckboxListTile(
                      title: Text(c.label),
                      value: _categories.contains(c.slug),
                      onChanged: (v) => setState(() {
                        if (v == true) {
                          _categories.add(c.slug);
                        } else {
                          _categories.remove(c.slug);
                        }
                      }),
                    )),
          ],
        );
      case 2:
        return ListView(
          children: [
            const Text('Service area', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text('Requests are sent to you when the customer is inside your radius around your shop / home pin.'),
            const SizedBox(height: 16),
            Text('Radius: ${_radiusKm.toInt()} km'),
            Slider(
              value: _radiusKm,
              min: 1,
              max: 25,
              divisions: 24,
              label: '${_radiusKm.toInt()} km',
              onChanged: (v) => setState(() => _radiusKm = v),
            ),
          ],
        );
      default:
        return ListView(
          children: [
            const Text('Payout', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text('Used from Phase 2 for wallet payouts. Cash jobs in Phase 1 are paid directly by the customer.'),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              value: _payoutMethod,
              decoration: const InputDecoration(labelText: 'Payout method'),
              items: const [
                DropdownMenuItem(value: 'jazzcash', child: Text('JazzCash')),
                DropdownMenuItem(value: 'easypaisa', child: Text('Easypaisa')),
                DropdownMenuItem(value: 'bank', child: Text('Bank (IBAN)')),
              ],
              onChanged: (v) => setState(() => _payoutMethod = v ?? 'jazzcash'),
            ),
            const SizedBox(height: 12),
            TextField(controller: _payoutController, decoration: const InputDecoration(labelText: 'JazzCash / Easypaisa number or IBAN')),
          ],
        );
    }
  }
}
