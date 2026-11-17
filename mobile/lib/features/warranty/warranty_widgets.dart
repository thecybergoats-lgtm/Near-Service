// Warranty Product widgets (Phase 4, item 4).
//
// NEW FILE — pure UI + endpoint constants. It deliberately does NOT edit
// core/api_client.dart (shared file, owned by the integrator): the
// integrator adds these methods to ApiClient (signatures below, mirroring
// the existing _send/_u style) and wires the widgets into the booking /
// provider-profile / job-detail screens. Until then the widgets take
// callbacks, so they compile and render standalone.
//
//   ApiClient.getWarrantyQuote(double jobPricePkr) -> GET /warranty/quote?job_price_pkr=...
//   ApiClient.optInWarranty(String jobId)          -> POST /jobs/{id}/warranty/opt-in
//   ApiClient.collectWarrantyFee(String jobId)     -> POST /jobs/{id}/warranty/collect-fee
//   ApiClient.getWarrantyBadge(String providerId)  -> GET /providers/{id}/warranty-badge
//   ApiClient.getJobWarrantyReceipt(String jobId)  -> GET /jobs/{id}/warranty/receipt
//   ApiClient.fileWarrantyClaim(String jobId, {reason, description})
//                                                  -> POST /jobs/{id}/warranty/claims
//   ApiClient.getWarrantyRules()                   -> GET /warranty/rules (public)
// See docs/phase4-warranty.md for the full request/response shapes.
import 'package:flutter/material.dart';

/// Endpoint paths for the warranty API (all under the /api/v1 prefix).
class WarrantyEndpoints {
  static const rules = '/warranty/rules';
  static String quote(double jobPricePkr) => '/warranty/quote?job_price_pkr=$jobPricePkr';
  static String optIn(String jobId) => '/jobs/$jobId/warranty/opt-in';
  static String collectFee(String jobId) => '/jobs/$jobId/warranty/collect-fee';
  static String warranty(String jobId) => '/jobs/$jobId/warranty';
  static String receipt(String jobId) => '/jobs/$jobId/warranty/receipt';
  static String badge(String providerId) => '/providers/$providerId/warranty-badge';
  static String fileClaim(String jobId) => '/jobs/$jobId/warranty/claims';
  static String claim(String claimId) => '/warranty/claims/$claimId';
  static String reworkDone(String claimId) => '/warranty/claims/$claimId/rework-done';
  static String reworkFailed(String claimId) => '/warranty/claims/$claimId/rework-failed';
  static String closeClaim(String claimId) => '/warranty/claims/$claimId/close';
}

/// "7-Day Warranty" badge shown on Tier 3 (Trusted Pro) provider cards.
/// Only render when [warrantyEligible] is true — other tiers get no badge.
class WarrantyBadge extends StatelessWidget {
  const WarrantyBadge({
    super.key,
    required this.warrantyEligible,
    this.coverageDays = 7,
    this.compact = false,
  });

  final bool warrantyEligible;
  final int coverageDays;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (!warrantyEligible) return const SizedBox.shrink();
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 6 : 8, vertical: compact ? 2 : 4),
      decoration: BoxDecoration(
        color: Colors.green.shade700,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.verified_user, size: 14, color: Colors.white),
          const SizedBox(width: 4),
          Text(
            '$coverageDays-Day Warranty',
            style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

/// Opt-in card shown at booking for an eligible provider. The fee is
/// quoted from GET /warranty/quote before the customer opts in; the fee
/// itself is collected at payment time (collect-fee), not here.
class WarrantyOptInCard extends StatelessWidget {
  const WarrantyOptInCard({
    super.key,
    required this.feePkr,
    required this.coverageDays,
    required this.optedIn,
    required this.onOptIn,
    this.enabled = true,
  });

  final double feePkr;
  final int coverageDays;
  final bool optedIn;
  final VoidCallback onOptIn;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: const Icon(Icons.verified_user, color: Colors.green),
        title: Text('$coverageDays-Day Workmanship Warranty'),
        subtitle: Text(
          optedIn
              ? 'Added — PKR ${feePkr.toStringAsFixed(0)} will be collected at payment. Rework first, refund if rework fails.'
              : 'Add for PKR ${feePkr.toStringAsFixed(0)} — covers workmanship faults for $coverageDays days after completion. Rework first, refund if rework fails.',
        ),
        trailing: optedIn
            ? const Icon(Icons.check_circle, color: Colors.green)
            : ElevatedButton(
                onPressed: enabled ? onOptIn : null,
                child: const Text('Add'),
              ),
      ),
    );
  }
}

/// Claim form for a completed job inside its 7-day window. The claim
/// window is enforced server-side (422 WARRANTY_CLAIM_WINDOW_CLOSED);
/// [coverageEndsAt] is shown so the customer sees the deadline.
class WarrantyClaimForm extends StatefulWidget {
  const WarrantyClaimForm({
    super.key,
    required this.coverageEndsAt,
    required this.onSubmit,
  });

  final DateTime coverageEndsAt;
  final void Function(String reason, String description) onSubmit;

  @override
  State<WarrantyClaimForm> createState() => _WarrantyClaimFormState();
}

class _WarrantyClaimFormState extends State<WarrantyClaimForm> {
  String _reason = 'poor_work';
  final _description = TextEditingController();

  static const _reasons = {
    'poor_work': 'Poor workmanship',
    'incomplete': 'Work incomplete',
    'not_done': 'Work not done as agreed',
    'other': 'Something else',
  };

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final inWindow = DateTime.now().isBefore(widget.coverageEndsAt);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Warranty claim', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(
              inWindow
                  ? 'Covered until ${widget.coverageEndsAt.toLocal()} — rework is offered first.'
                  : 'The 7-day claim window has closed.',
            ),
            const SizedBox(height: 12),
            DropdownButton<String>(
              value: _reason,
              isExpanded: true,
              items: _reasons.entries
                  .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value)))
                  .toList(),
              onChanged: inWindow ? (v) => setState(() => _reason = v ?? 'poor_work') : null,
            ),
            TextField(
              controller: _description,
              enabled: inWindow,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'What went wrong?',
                hintText: 'Describe the fault — the provider will be asked to fix it first.',
              ),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: inWindow
                  ? () {
                      if (_description.text.trim().isEmpty) return;
                      widget.onSubmit(_reason, _description.text.trim());
                    }
                  : null,
              child: const Text('File claim'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Receipt rows for a warranted job: job price, warranty fee, coverage
/// window and claim status — mirrors GET /jobs/{id}/warranty/receipt.
class WarrantyReceiptSection extends StatelessWidget {
  const WarrantyReceiptSection({
    super.key,
    required this.jobPricePkr,
    required this.warrantyFeePkr,
    required this.coverageEndsAt,
    this.claimStatus,
  });

  final double jobPricePkr;
  final double warrantyFeePkr;
  final DateTime coverageEndsAt;
  final String? claimStatus;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Receipt', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            _row('Job price', 'PKR ${jobPricePkr.toStringAsFixed(0)}'),
            _row('Warranty fee (7-day cover)', 'PKR ${warrantyFeePkr.toStringAsFixed(0)}'),
            _row('Total charged', 'PKR ${(jobPricePkr + warrantyFeePkr).toStringAsFixed(0)}'),
            _row('Covered until', coverageEndsAt.toLocal().toString()),
            if (claimStatus != null) _row('Claim', claimStatus!),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label), Text(value, style: const TextStyle(fontWeight: FontWeight.w600))],
      ),
    );
  }
}
