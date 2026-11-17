import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../common/widgets.dart';

/// Dynamic request form per category (PRD p.7, Phase 2):
/// fields are rendered from GET /categories/{id}/form-schema when the
/// backend provides one — string / integer / number / enum / boolean —
/// with the Phase 1 book-binding / AC-repair fields kept as the
/// fallback when no schema is available. Fair-price meter +
/// too-low/too-high warning; guidance never blocks posting.
///
/// Phase 2 additions: schedule picker (Now / Today / date+time →
/// `scheduled_at`), promo code field with validation display, and a
/// recurring toggle (weekly/monthly + day picker) that creates a
/// recurring job (POST /recurring-jobs, same specs) after the first
/// request is posted.
///
/// [categoryId] may arrive as a UUID (from the API tree) or as a slug
/// (demo fallback / deep link). It is resolved through [CategoryResolver]
/// before any API call, so a slug is never sent as `category_id` —
/// the request is sent with `category_slug` instead (PRD v1.1).
class RequestFormScreen extends ConsumerStatefulWidget {
  const RequestFormScreen(
      {super.key,
      this.categoryId,
      this.categorySlug,
      this.initialOffer,
      this.initialDescription,
      this.initialPromoCode});

  final String? categoryId;
  final String? categorySlug;
  /// Batch 2 "Book again": pre-fill the offer (PKR) from the past job.
  final int? initialOffer;
  /// Batch 2 "Book again": pre-fill the description from the past job.
  final String? initialDescription;
  /// Batch 3: tapping a deal of the day pre-fills its promo code.
  final String? initialPromoCode;

  @override
  ConsumerState<RequestFormScreen> createState() => _RequestFormScreenState();
}

/// One field from a category form-schema (JSON Schema `properties`
/// entry, or a `fields` array entry — both shapes are accepted).
class _SchemaField {
  final String key;
  final String type; // string | integer | number | enum | boolean
  final String title;
  final List<String> options;
  final bool required;

  const _SchemaField({
    required this.key,
    required this.type,
    required this.title,
    this.options = const [],
    this.required = false,
  });
}

class _RequestFormScreenState extends ConsumerState<RequestFormScreen> {
  final _descController = TextEditingController();
  final _offerController = TextEditingController();
  String _fulfillment = 'PROVIDER_COMES';
  bool _getQuotes = false;
  bool _submitting = false;
  String? _error;

  /// Resolved category: UUID when the tree knows it, slug otherwise.
  String? _resolvedCategoryId;
  String? _resolvedCategorySlug;

  // Dynamic form-schema fields (Phase 2) and their current values.
  List<_SchemaField> _schemaFields = [];
  final Map<String, dynamic> _schemaValues = {};
  bool _schemaLoaded = false;

  // Book Binding specs (fallback when no schema is served)
  int _books = 20;
  String _bookSize = 'A4';
  String _bindingType = 'hard';
  // AC Repair specs (fallback when no schema is served)
  String _acType = 'Split';
  String _tonnage = '1.5 ton';
  String _acIssue = 'Cooling kam hai';
  // Generic specs (fallback when no schema is served)
  String _genericIssue = '';

  // Schedule (Phase 2): now | today | pick
  String _scheduleMode = 'now';
  DateTime _scheduleDate = DateTime.now().add(const Duration(days: 1));
  TimeOfDay _scheduleTime = const TimeOfDay(hour: 10, minute: 0);

  // Promo (Phase 2)
  final _promoController = TextEditingController();
  PromoValidation? _promo;
  bool _validatingPromo = false;
  String? _promoMessage;

  // Recurring (Phase 2)
  bool _recurring = false;
  String _frequency = 'weekly';
  int _dayOfWeek = 1; // 1 = Monday … 7 = Sunday
  int _dayOfMonth = 1;

  FairRange? _fairRange;
  int get _offer => Money.tryParse(_offerController.text) ?? 0;

  static const List<String> _weekdays = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];

  @override
  void initState() {
    super.initState();
    // Batch 2 "Book again" pre-fill (same provider/category/price).
    if (widget.initialOffer != null && widget.initialOffer! > 0) {
      _offerController.text = widget.initialOffer.toString();
    }
    if (widget.initialDescription != null &&
        widget.initialDescription!.isNotEmpty) {
      _descController.text = widget.initialDescription!;
    }
    // Batch 3: a deal's promo code is pre-filled and validated once the
    // category resolves (validation needs the resolved category id).
    if (widget.initialPromoCode != null && widget.initialPromoCode!.isNotEmpty) {
      _promoController.text = widget.initialPromoCode!;
    }
    _resolveCategory();
  }

  /// Resolves the incoming category value (UUID or slug) once, then
  /// loads the fair range and the dynamic form-schema with the
  /// matching query key.
  Future<void> _resolveCategory() async {
    final incoming = widget.categoryId ?? widget.categorySlug ?? 'book-binding';
    final resolved =
        await ref.read(categoryResolverProvider).resolve(incoming);
    if (!mounted) return;
    setState(() {
      _resolvedCategoryId = resolved.categoryId;
      _resolvedCategorySlug = resolved.categorySlug;
    });
    await _loadFairRange();
    await _loadSchema();
    if (_promoController.text.trim().isNotEmpty) await _validatePromo();
  }

  Future<void> _loadFairRange() async {
    try {
      final range = await ref.read(apiClientProvider).fairRange(
            categoryId: _resolvedCategoryId,
            categorySlug: _resolvedCategorySlug,
            specs: _specs(),
          );
      if (mounted) setState(() => _fairRange = range);
    } catch (_) {
      // Fair range hidden until enough data (PRD p.24) — not an error.
    }
  }

  /// Loads GET /categories/{id}/form-schema and parses its fields.
  /// Accepts `{properties: {...}, required: [...]}` and
  /// `{fields: [{key, type, ...}]}` shapes. Any failure leaves the
  /// Phase 1 fallback fields in place — the form never blocks on it.
  Future<void> _loadSchema() async {
    final categoryId = _resolvedCategoryId;
    if (categoryId == null) {
      if (mounted) setState(() => _schemaLoaded = true);
      return;
    }
    try {
      final schema =
          await ref.read(apiClientProvider).getCategoryFormSchema(categoryId);
      final fields = _parseSchema(schema);
      if (mounted) {
        setState(() {
          _schemaFields = fields;
          for (final f in fields) {
            _schemaValues.putIfAbsent(f.key, () {
              if (f.type == 'boolean') return false;
              if (f.options.isNotEmpty) return f.options.first;
              return '';
            });
          }
          _schemaLoaded = true;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _schemaLoaded = true);
    }
  }

  List<_SchemaField> _parseSchema(Map<String, dynamic> schema) {
    final out = <_SchemaField>[];
    final required =
        (schema['required'] as List?)?.map((e) => e.toString()).toSet() ??
            <String>{};
    final props = schema['properties'] as Map<String, dynamic>?;
    if (props != null) {
      for (final entry in props.entries) {
        final prop = entry.value as Map<String, dynamic>? ?? {};
        final rawType = (prop['type'] ?? 'string').toString();
        final enumValues = prop['enum'] as List?;
        final type = enumValues != null && enumValues.isNotEmpty
            ? 'enum'
            : rawType;
        out.add(_SchemaField(
          key: entry.key,
          type: type,
          title: (prop['title'] ?? prop['description'] ?? entry.key)
              .toString(),
          options: enumValues == null
              ? const []
              : enumValues.map((e) => e.toString()).toList(),
          required: required.contains(entry.key),
        ));
      }
      return out;
    }
    final fields = schema['fields'] as List?;
    if (fields != null) {
      for (final raw in fields) {
        final f = raw as Map<String, dynamic>;
        final enumValues = f['enum'] as List? ?? f['options'] as List?;
        out.add(_SchemaField(
          key: (f['key'] ?? f['name'] ?? '').toString(),
          type: enumValues != null && enumValues.isNotEmpty
              ? 'enum'
              : (f['type'] ?? 'string').toString(),
          title: (f['title'] ?? f['label'] ?? f['key'] ?? '').toString(),
          options: enumValues == null
              ? const []
              : enumValues.map((e) => e.toString()).toList(),
          required: (f['required'] as bool?) ?? false,
        ));
      }
    }
    return out;
  }

  Map<String, dynamic> _specs() {
    final specs = <String, dynamic>{};
    if (_schemaFields.isNotEmpty) {
      specs.addAll(_schemaValues);
      return specs;
    }
    switch (_resolvedCategorySlug ?? widget.categorySlug ?? widget.categoryId) {
      case 'book-binding':
        return {'books': _books, 'size': _bookSize, 'binding': _bindingType};
      case 'ac-repair':
        return {'ac_type': _acType, 'tonnage': _tonnage, 'issue': _acIssue};
      default:
        return {'issue': _genericIssue};
    }
  }

  /// scheduled_at for the chosen schedule mode, or null for "Now".
  DateTime? get _scheduledAt {
    switch (_scheduleMode) {
      case 'today':
        final now = DateTime.now();
        return DateTime(now.year, now.month, now.day, _scheduleTime.hour,
            _scheduleTime.minute);
      case 'pick':
        return DateTime(_scheduleDate.year, _scheduleDate.month,
            _scheduleDate.day, _scheduleTime.hour, _scheduleTime.minute);
      default:
        return null;
    }
  }

  Future<void> _validatePromo() async {
    final code = _promoController.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _validatingPromo = true;
      _promoMessage = null;
    });
    try {
      final result = await ref.read(apiClientProvider).validatePromo(
            code: code,
            categoryId: _resolvedCategoryId,
            amountPkr: _offer > 0 ? _offer : null,
          );
      setState(() {
        _promo = result;
        _promoMessage = result.valid
            ? 'Promo applied — you save ${Money.pkr(result.discountPkr)} at payment.'
            : (result.reason ?? 'This promo code is not valid for this job.');
      });
    } on ApiException catch (e) {
      setState(() {
        _promo = null;
        _promoMessage = e.userMessage;
      });
    } finally {
      if (mounted) setState(() => _validatingPromo = false);
    }
  }

  Future<void> _submit() async {
    if (_descController.text.trim().isEmpty && _genericIssue.isEmpty) {
      setState(() => _error = 'Please describe the work briefly.');
      return;
    }
    if (!_getQuotes && _offer <= 0) {
      setState(() => _error = 'Enter your offer in PKR, or choose "Get quotes".');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    double lat = AppConstants.quettaLat, lng = AppConstants.quettaLng;
    try {
      final pos = await Geolocator.getCurrentPosition();
      lat = pos.latitude;
      lng = pos.longitude;
    } catch (_) {}
    try {
      final scheduledAt = _scheduledAt;
      final req = await ref.read(apiClientProvider).createRequest({
        if (_resolvedCategoryId != null) 'category_id': _resolvedCategoryId,
        if (_resolvedCategoryId == null && _resolvedCategorySlug != null)
          'category_slug': _resolvedCategorySlug,
        'description': _descController.text.trim(),
        'specs': _specs(),
        'fulfillment': _fulfillment,
        'lat': lat,
        'lng': lng,
        if (!_getQuotes) 'customer_offer': _offer,
        if (scheduledAt != null) 'scheduled_at': scheduledAt.toIso8601String(),
        if (_promo != null && _promo!.valid)
          'promo_code': _promoController.text.trim(),
      });
      // Recurring: created after the first request is posted, with the
      // same specs / fulfillment / location / offer.
      if (_recurring) {
        try {
          await ref.read(apiClientProvider).createRecurringJob({
            if (_resolvedCategoryId != null)
              'category_id': _resolvedCategoryId,
            if (_resolvedCategoryId == null && _resolvedCategorySlug != null)
              'category_slug': _resolvedCategorySlug,
            'specs': _specs(),
            'fulfillment': _fulfillment,
            'location': {'lat': lat, 'lng': lng},
            'offer': _getQuotes ? null : _offer,
            'frequency': _frequency,
            // Backend day_of_week uses JS/Postgres DOW numbering
            // (0=Sunday..6=Saturday); the picker is 1=Monday..7=Sunday,
            // so Sunday (7) maps to 0 and the rest pass through unchanged.
            if (_frequency == 'weekly') 'day_of_week': _dayOfWeek % 7,
            if (_frequency == 'monthly') 'day_of_month': _dayOfMonth,
            'starts_at': (scheduledAt ?? DateTime.now()).toIso8601String(),
          });
        } on ApiException catch (e) {
          // The request itself is posted; only the repeat failed.
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                  content: Text(
                      'Request posted, but the repeat could not be set up: ${e.userMessage}')),
            );
          }
        }
      }
      if (mounted) context.push('/customer/offers/${req.id}');
    } on ApiException catch (e) {
      setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final slug = _resolvedCategorySlug ?? widget.categorySlug ?? widget.categoryId;
    final isBinding = slug == 'book-binding';
    final isAc = slug == 'ac-repair';
    final useSchema = _schemaLoaded && _schemaFields.isNotEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('Post a request')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (useSchema) ...[
            _sectionTitle('Work details'),
            ..._schemaFields.map(_schemaFieldWidget),
          ] else if (isBinding) ...[
            _sectionTitle('Book Binding details'),
            _stepperRow('Number of books', _books, (v) => setState(() => _books = v.clamp(1, 1000))),
            const SizedBox(height: 12),
            _dropdown('Book size', _bookSize, ['A4', 'A5', 'Legal', 'Custom'],
                (v) => setState(() => _bookSize = v!)),
            const SizedBox(height: 12),
            _dropdown('Binding type', _bindingType, ['hard', 'soft', 'spiral', 'thesis'],
                (v) => setState(() => _bindingType = v!)),
          ] else if (isAc) ...[
            _sectionTitle('AC Repair details'),
            _dropdown('AC type', _acType, ['Split', 'Window', 'Inverter', 'Floor standing'],
                (v) => setState(() => _acType = v!)),
            const SizedBox(height: 12),
            _dropdown('Tonnage', _tonnage, ['1 ton', '1.5 ton', '2 ton'],
                (v) => setState(() => _tonnage = v!)),
            const SizedBox(height: 12),
            _dropdown('Issue', _acIssue, ['Cooling kam hai', 'Gas refill', 'Service', 'Installation', 'Paani leak'],
                (v) => setState(() => _acIssue = v!)),
          ] else ...[
            _sectionTitle('Work details'),
            TextField(
              decoration: const InputDecoration(hintText: 'What is the problem? e.g. switch kharab hai'),
              onChanged: (v) => _genericIssue = v,
            ),
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _descController,
            maxLines: 3,
            decoration: const InputDecoration(
              hintText: 'Describe the work… (e.g. 20 books, hard binding)',
              labelText: 'Description',
            ),
          ),
          const SizedBox(height: 16),
          _sectionTitle('How should it be done?'),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'PROVIDER_COMES', label: Text('Comes to me')),
              ButtonSegment(value: 'VISIT_SHOP', label: Text('I visit shop')),
              ButtonSegment(value: 'PICKUP_DELIVERY', label: Text('Pickup & delivery')),
            ],
            selected: {_fulfillment},
            onSelectionChanged: (s) => setState(() => _fulfillment = s.first),
          ),
          const SizedBox(height: 16),
          _sectionTitle('When should it be done?'),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'now', label: Text('Now')),
              ButtonSegment(value: 'today', label: Text('Today')),
              ButtonSegment(value: 'pick', label: Text('Pick date & time')),
            ],
            selected: {_scheduleMode},
            onSelectionChanged: (s) => setState(() => _scheduleMode = s.first),
          ),
          if (_scheduleMode != 'now') ...[
            const SizedBox(height: 12),
            Row(
              children: [
                if (_scheduleMode == 'pick')
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () async {
                        final picked = await showDatePicker(
                          context: context,
                          initialDate: _scheduleDate,
                          firstDate: DateTime.now(),
                          lastDate:
                              DateTime.now().add(const Duration(days: 60)),
                        );
                        if (picked != null) {
                          setState(() => _scheduleDate = picked);
                        }
                      },
                      child: Text(
                          'Date: ${_scheduleDate.toLocal().toString().substring(0, 10)}'),
                    ),
                  ),
                if (_scheduleMode == 'pick') const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () async {
                      final picked = await showTimePicker(
                          context: context, initialTime: _scheduleTime);
                      if (picked != null) {
                        setState(() => _scheduleTime = picked);
                      }
                    },
                    child: Text('Time: ${_scheduleTime.format(context)}'),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          SwitchListTile(
            title: const Text('Get quotes (no price from me)'),
            value: _getQuotes,
            onChanged: (v) => setState(() => _getQuotes = v),
          ),
          if (!_getQuotes) ...[
            TextField(
              controller: _offerController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Your offer (PKR)',
                prefixIcon: Icon(Icons.payments_outlined),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 12),
            if (_fairRange != null) FairPriceMeter(range: _fairRange!, offer: _offer),
            // Batch 2 (J2) — payment timing, next to the FairPriceMeter.
            // The form itself has no payment-method field (the method
            // is chosen at payment time), so both timings are shown
            // plainly rather than inventing a method choice here.
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F766E).withOpacity(0.08),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Payment timing',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  SizedBox(height: 4),
                  Text('Cash — Payment: kaam ke baad'),
                  Text('Wallet — Wallet: pehle escrow mein, kaam ke baad provider ko'),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _promoController,
            textCapitalization: TextCapitalization.characters,
            decoration: InputDecoration(
              labelText: 'Promo code (optional)',
              hintText: 'e.g. FIRSTJOB',
              suffixIcon: TextButton(
                onPressed: _validatingPromo ? null : _validatePromo,
                child: Text(_validatingPromo ? '…' : 'Apply'),
              ),
            ),
          ),
          if (_promoMessage != null) ...[
            const SizedBox(height: 8),
            Text(
              _promoMessage!,
              style: TextStyle(
                color: _promo != null && _promo!.valid
                    ? const Color(0xFF15803D)
                    : Colors.red,
              ),
            ),
          ],
          const SizedBox(height: 16),
          SwitchListTile(
            title: const Text('Repeat this job regularly'),
            subtitle: const Text('A new request is posted automatically on schedule.'),
            value: _recurring,
            onChanged: (v) => setState(() => _recurring = v),
          ),
          if (_recurring) ...[
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'weekly', label: Text('Weekly')),
                ButtonSegment(value: 'monthly', label: Text('Monthly')),
              ],
              selected: {_frequency},
              onSelectionChanged: (s) => setState(() => _frequency = s.first),
            ),
            const SizedBox(height: 12),
            if (_frequency == 'weekly')
              _dropdown('Day of the week', _weekdays[_dayOfWeek - 1], _weekdays,
                  (v) => setState(() => _dayOfWeek = _weekdays.indexOf(v!) + 1))
            else
              Row(
                children: [
                  const Expanded(child: Text('Day of the month')),
                  IconButton(
                      icon: const Icon(Icons.remove_circle_outline),
                      onPressed: () =>
                          setState(() => _dayOfMonth = (_dayOfMonth - 1).clamp(1, 28))),
                  Text('$_dayOfMonth',
                      style: const TextStyle(
                          fontSize: 18, fontWeight: FontWeight.w700)),
                  IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: () =>
                          setState(() => _dayOfMonth = (_dayOfMonth + 1).clamp(1, 28))),
                ],
              ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white))
                  : const Text('Post request — broadcast to nearby providers'),
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Your request goes to the nearest matching providers in waves. First offer usually in under 60 seconds.',
            style: TextStyle(fontSize: 12, color: Colors.grey),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  /// Renders one form-schema field by its JSON Schema type.
  Widget _schemaFieldWidget(_SchemaField field) {
    final value = _schemaValues[field.key];
    switch (field.type) {
      case 'boolean':
        return SwitchListTile(
          title: Text(field.title),
          value: value is bool ? value : false,
          onChanged: (v) => setState(() => _schemaValues[field.key] = v),
        );
      case 'enum':
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: _dropdown(
            field.title,
            (value ?? (field.options.isEmpty ? '' : field.options.first))
                .toString(),
            field.options,
            (v) => setState(() => _schemaValues[field.key] = v),
          ),
        );
      case 'integer':
      case 'number':
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(
            keyboardType: TextInputType.number,
            decoration: InputDecoration(
              labelText: field.title + (field.required ? ' *' : ''),
            ),
            onChanged: (v) => _schemaValues[field.key] =
                field.type == 'integer'
                    ? int.tryParse(v) ?? 0
                    : double.tryParse(v) ?? 0,
          ),
        );
      default: // string
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(
            decoration: InputDecoration(
              labelText: field.title + (field.required ? ' *' : ''),
            ),
            onChanged: (v) => _schemaValues[field.key] = v,
          ),
        );
    }
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(t, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
      );

  Widget _stepperRow(String label, int value, ValueChanged<int> onChanged) => Row(
        children: [
          Expanded(child: Text(label)),
          IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => onChanged(value - 1)),
          Text('$value', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          IconButton(icon: const Icon(Icons.add_circle_outline), onPressed: () => onChanged(value + 1)),
        ],
      );

  Widget _dropdown(String label, String value, List<String> items, ValueChanged<String?> onChanged) =>
      DropdownButtonFormField<String>(
        value: items.contains(value) ? value : (items.isEmpty ? null : items.first),
        decoration: InputDecoration(labelText: label),
        items: items.map((i) => DropdownMenuItem(value: i, child: Text(i))).toList(),
        onChanged: onChanged,
      );
}
