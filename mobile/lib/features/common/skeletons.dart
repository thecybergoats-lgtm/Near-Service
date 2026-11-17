import 'package:flutter/material.dart';

import '../../core/theme.dart';

/// Skeleton loaders matching each list (PRD p.26).
class ProviderCardSkeleton extends StatelessWidget {
  const ProviderCardSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Row(
              children: [
                const CircleAvatar(radius: 24, backgroundColor: AppColors.fill),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _bar(140),
                      const SizedBox(height: 8),
                      _bar(90),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _bar(double.infinity),
          ],
        ),
      ),
    );
  }

  Widget _bar(double width) => Container(
        width: width,
        height: 14,
        decoration: BoxDecoration(
          color: AppColors.fill,
          borderRadius: BorderRadius.circular(7),
        ),
      );
}

class ListSkeleton extends StatelessWidget {
  const ListSkeleton({super.key, this.count = 3});

  final int count;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: count,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (_, __) => const ProviderCardSkeleton(),
    );
  }
}
