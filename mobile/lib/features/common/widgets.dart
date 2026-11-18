import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/money.dart';
import '../../core/theme.dart';

/// Shared widgets (PRD p.26 component list). Every widget has loading /
/// empty / error variants where it loads data; see [skeletons.dart].

class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, this.isDemo = false});

  final bool isDemo;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      color: isDemo ? AppColors.accent : AppColors.danger,
      child: Text(
        isDemo
            ? 'Demo data — connect to the API for live providers.'
            : 'You are offline. Showing saved data.',
        style: const TextStyle(color: Colors.white, fontSize: 13),
        textAlign: TextAlign.center,
      ),
    );
  }
}

class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off, size: 48, color: AppColors.secondaryText),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.message, this.action});

  final IconData icon;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48, color: AppColors.secondaryText),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

/// Verification tier badge (PRD p.5). Phase 1 verification is MANUAL
/// review only (PRD v1.1) — the badge reflects a human officer's decision.
class TierBadge extends StatelessWidget {
  const TierBadge({super.key, required this.tier});

  final int tier;

  @override
  Widget build(BuildContext context) {
    const labels = ['Unverified', 'ID Verified', 'Verified', 'Trusted Pro'];
    final scheme = Theme.of(context).colorScheme;
    // Theme-aware: the old fixed greys were unreadable on dark cards.
    final colors = [
      scheme.onSurfaceVariant,
      AppColors.accent,
      scheme.primary,
      AppColors.success,
    ];
    final i = tier.clamp(0, 3);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: colors[i].withOpacity(0.12),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.verified, size: 14, color: colors[i]),
          const SizedBox(width: 4),
          Text(
            labels[i],
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: colors[i],
            ),
          ),
        ],
      ),
    );
  }
}

class ProviderCard extends StatelessWidget {
  const ProviderCard({
    super.key,
    required this.provider,
    this.onTap,
    this.onRequestQuote,
    this.isFavorite,
    this.onFavoriteToggle,
  });

  final ServiceProvider provider;
  final VoidCallback? onTap;
  final VoidCallback? onRequestQuote;
  /// Null = no heart shown. Non-null = heart state (Batch 2).
  final bool? isFavorite;
  final VoidCallback? onFavoriteToggle;

  @override
  Widget build(BuildContext context) {
    // Theme-aware secondary colours: the old fixed greys were unreadable
    // on dark cards (Batch 4).
    final scheme = Theme.of(context).colorScheme;
    final secondary = scheme.onSurfaceVariant;
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.card),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header: avatar + name + rating. The name gets its own
              // full-width line (maxLines 1 + ellipsis) — the old layout
              // squeezed it between avatar, badge and heart until it
              // wrapped letter-by-letter (Batch 4 bug report).
              Row(
                children: [
                  CircleAvatar(
                    radius: 24,
                    backgroundColor: AppColors.primary.withOpacity(0.12),
                    backgroundImage: provider.photoUrl == null
                        ? null
                        : NetworkImage(provider.photoUrl!),
                    child: provider.photoUrl == null
                        ? Text(
                            provider.name.isNotEmpty
                                ? provider.name[0]
                                : '?',
                            style: const TextStyle(
                              color: AppColors.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          )
                        : null,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          provider.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            const Icon(Icons.star, size: 14, color: AppColors.accent),
                            Flexible(
                              child: Text(
                                ' ${provider.rating.toStringAsFixed(1)} (${provider.ratingCount}) · ${provider.jobsCompleted} jobs',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: secondary,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (isFavorite != null)
                    IconButton(
                      icon: Icon(
                        isFavorite! ? Icons.favorite : Icons.favorite_border,
                        color: isFavorite! ? Colors.red : null,
                      ),
                      tooltip: isFavorite! ? 'Remove from favourites' : 'Save to favourites',
                      onPressed: onFavoriteToggle,
                    ),
                ],
              ),
              const SizedBox(height: 12),
              // Badge + meta wrap onto their own line instead of
              // squeezing the name.
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  TierBadge(tier: provider.tier),
                  _meta(Icons.location_on, '${provider.distanceKm.toStringAsFixed(1)} km', secondary: secondary),
                  _meta(Icons.access_time, '~${provider.etaMinutes} min', secondary: secondary),
                  _meta(
                    Icons.circle,
                    provider.isOpen ? 'Open now' : 'Closed',
                    color: provider.isOpen ? AppColors.success : AppColors.danger,
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: scheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      provider.isShop ? 'SHOP' : 'INDIVIDUAL',
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Text(
                    'From ${Money.pkr(provider.startingPrice)}',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: scheme.primary,
                    ),
                  ),
                  Flexible(
                    child: Text(
                      ' · replies in ~${provider.responseSecondsAvg}s',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: secondary,
                      ),
                    ),
                  ),
                  const Spacer(),
                  SizedBox(
                    height: kMinTouch,
                    child: OutlinedButton(
                      onPressed: onRequestQuote ?? onTap,
                      child: const Text('Request quote'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _meta(IconData icon, String text, {Color? color, Color? secondary}) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: color ?? secondary ?? AppColors.secondaryText),
          const SizedBox(width: 4),
          Text(text, style: TextStyle(fontSize: 12, color: color ?? secondary)),
        ],
      );
}

/// Offer card with a depleting countdown ring (PRD p.26).
class OfferCard extends StatelessWidget {
  const OfferCard({
    super.key,
    required this.offer,
    this.onAccept,
    this.onCounter,
    this.onDecline,
    this.onChat,
  });

  final Offer offer;
  final VoidCallback? onAccept;
  final VoidCallback? onCounter;
  final VoidCallback? onDecline;
  final VoidCallback? onChat;

  int get _secondsLeft {
    if (offer.expiresAt == null) return 0;
    return offer.expiresAt!.difference(DateTime.now()).inSeconds.clamp(0, 600);
  }

  @override
  Widget build(BuildContext context) {
    final secondsLeft = _secondsLeft;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                SizedBox(
                  width: 56,
                  height: 56,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      SizedBox(
                        width: 56,
                        height: 56,
                        child: CircularProgressIndicator(
                          value: secondsLeft / 600,
                          strokeWidth: 5,
                          color: secondsLeft < 120
                              ? AppColors.danger
                              : AppColors.primary,
                          backgroundColor: AppColors.fill,
                        ),
                      ),
                      Text(
                        '${secondsLeft ~/ 60}:${(secondsLeft % 60).toString().padLeft(2, '0')}',
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        offer.providerName,
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
                      ),
                      Row(
                        children: [
                          const Icon(Icons.star, size: 14, color: AppColors.accent),
                          Text(
                            ' ${offer.providerRating.toStringAsFixed(1)} · ${offer.providerDistanceKm.toStringAsFixed(1)} km · Round ${offer.round}/3',
                            style: const TextStyle(fontSize: 12, color: AppColors.secondaryText),
                          ),
                        ],
                      ),
                      if (offer.note != null)
                        Text(offer.note!, style: const TextStyle(fontSize: 13)),
                    ],
                  ),
                ),
                Text(
                  Money.pkr(offer.price),
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                    color: AppColors.accent,
                  ),
                ),
              ],
            ),
            if (offer.breakdown.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: offer.breakdown.entries
                    .map((e) => Chip(
                          label: Text('${e.key}: ${Money.pkr(e.value)}',
                              style: const TextStyle(fontSize: 11)),
                        ))
                    .toList(),
              ),
            ],
            if (offer.etaMinutes != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'ETA ~${offer.etaMinutes} min',
                  style: const TextStyle(fontSize: 12, color: AppColors.secondaryText),
                ),
              ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton(
                    onPressed: onAccept,
                    child: const Text('Accept'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: onCounter,
                    child: const Text('Counter'),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: onChat,
                  icon: const Icon(Icons.chat_bubble_outline),
                  tooltip: 'Chat',
                ),
                IconButton(
                  onPressed: onDecline,
                  icon: const Icon(Icons.close, color: AppColors.danger),
                  tooltip: 'Decline',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Job stepper advancing with the state machine (PRD p.8).
class JobStepper extends StatelessWidget {
  const JobStepper({super.key, required this.currentState});

  final String currentState;

  @override
  Widget build(BuildContext context) {
    final currentIndex = jobStates.indexOf(currentState);
    const labels = [
      'Accepted',
      'On the way',
      'Arrived',
      'Working',
      'Completed',
      'Paid',
      'Rated',
    ];
    return Column(
      children: List.generate(jobStates.length, (i) {
        final done = currentIndex >= 0 && i <= currentIndex;
        final isCurrent = i == currentIndex;
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Column(
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: done ? AppColors.primary : AppColors.fill,
                    border: isCurrent
                        ? Border.all(color: AppColors.accent, width: 2)
                        : null,
                  ),
                  child: Icon(
                    done ? Icons.check : Icons.circle,
                    size: 14,
                    color: done ? Colors.white : AppColors.secondaryText,
                  ),
                ),
                if (i < jobStates.length - 1)
                  Container(
                    width: 2,
                    height: 24,
                    color: done ? AppColors.primary : AppColors.border,
                  ),
              ],
            ),
            const SizedBox(width: 12),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                labels[i],
                style: TextStyle(
                  fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w400,
                  color: done ? AppColors.ink : AppColors.secondaryText,
                ),
              ),
            ),
          ],
        );
      }),
    );
  }
}

/// Fair-price meter with too-low / too-high warnings (PRD p.7).
/// Never blocks posting — guidance only.
class FairPriceMeter extends StatelessWidget {
  const FairPriceMeter({
    super.key,
    required this.range,
    required this.offer,
  });

  final FairRange range;
  final int offer;

  @override
  Widget build(BuildContext context) {
    if (!range.isReliable) {
      return const Text(
        'Not enough completed jobs yet to show a fair price.',
        style: TextStyle(fontSize: 12, color: AppColors.secondaryText),
      );
    }
    final classification = range.classify(offer);
    final span = (range.max - range.min).clamp(1, 1000000000);
    final position = ((offer - range.min) / span).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text('Fair price range',
                style: TextStyle(fontWeight: FontWeight.w700)),
            Text(
              '${Money.pkr(range.min)} – ${Money.pkr(range.max)}',
              style: const TextStyle(color: AppColors.accent, fontWeight: FontWeight.w700),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Stack(
          children: [
            Container(
              height: 10,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(5),
                gradient: const LinearGradient(
                  colors: [AppColors.danger, AppColors.accent, AppColors.success, AppColors.accent, AppColors.danger],
                ),
              ),
            ),
            Positioned(
              left: position * 280,
              top: -4,
              child: Container(
                width: 18,
                height: 18,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: AppColors.primaryDark,
                  border: Border.all(color: Colors.white, width: 2),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(Money.pkr(range.min), style: const TextStyle(fontSize: 11)),
            Text('Typical ${Money.pkr(range.typical)}',
                style: const TextStyle(fontSize: 11)),
            Text(Money.pkr(range.max), style: const TextStyle(fontSize: 11)),
          ],
        ),
        if (classification == -1)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'This price is below the fair range — few providers may accept.',
              style: TextStyle(color: AppColors.danger, fontSize: 13),
            ),
          ),
        if (classification == 1)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'This price is above the fair range — you could save money.',
              style: TextStyle(color: AppColors.accent, fontSize: 13),
            ),
          ),
      ],
    );
  }
}

/// Countdown ring used on the offers screen; ticks once a second.
class CountdownRing extends StatefulWidget {
  const CountdownRing({super.key, required this.expiresAt});

  final DateTime expiresAt;

  @override
  State<CountdownRing> createState() => _CountdownRingState();
}

class _CountdownRingState extends State<CountdownRing> {
  late Timer _timer;
  int _left = 0;

  @override
  void initState() {
    super.initState();
    _tick();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
  }

  void _tick() {
    setState(() {
      _left = widget.expiresAt.difference(DateTime.now()).inSeconds.clamp(0, 600);
    });
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 48,
      height: 48,
      child: Stack(
        alignment: Alignment.center,
        children: [
          CircularProgressIndicator(
            value: _left / 600,
            color: _left < 120 ? AppColors.danger : AppColors.primary,
            backgroundColor: AppColors.fill,
          ),
          Text('${_left ~/ 60}:${(_left % 60).toString().padLeft(2, '0')}',
              style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}
