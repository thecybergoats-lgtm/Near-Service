// Server-rendered SEO pages — pure HTML builders (Phase 4, item 3).
// The data comes from SeoService (real providers, real reviews, real
// fair-price seed); these functions only turn it into indexable HTML
// with proper <title> / meta description / JSON-LD. All user-derived
// text is escaped — provider names and review comments are untrusted
// input and must never break out of the markup.

export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ReviewSummary {
  reviewCount: number;
  avgStars: number | null;
  /** stars -> count, keys '1'..'5' (only keys with count > 0). */
  distribution: Record<string, number>;
  recentComments: { stars: number; comment: string; createdAt: string }[];
}

export interface LandingProvider {
  id: string;
  displayName: string;
  shopName: string | null;
  providerType: string;
  tier: number;
  ratingAvg: number;
  jobsCompleted: number;
  startingPricePkr: number | null;
  reviewSummary: ReviewSummary;
}

export interface FairPrice {
  minPrice: number;
  typicalPrice: number;
  maxPrice: number;
  sampleSize: number;
  source: 'city' | 'global';
}

export interface LandingPageData {
  categorySlug: string;
  categoryName: string;
  areaSlug: string;
  areaName: string;
  cityName: string;
  citySlug: string;
  providers: LandingProvider[];
  fairPrice: FairPrice | null;
}

export interface ShopPageData {
  providerId: string;
  displayName: string;
  shopName: string | null;
  providerType: string;
  tier: number;
  ratingAvg: number;
  jobsCompleted: number;
  completionRate: number | null;
  cityName: string | null;
  services: { categorySlug: string; categoryName: string; startingPricePkr: number | null }[];
  reviewSummary: ReviewSummary;
}

export interface LandingIndexEntry {
  categorySlug: string;
  categoryName: string;
  areaSlug: string;
  areaName: string;
  cityName: string;
  providerCount: number;
}

function reviewSummaryHtml(summary: ReviewSummary, heading: string): string {
  if (summary.reviewCount === 0) {
    return `<p>${escapeHtml(heading)}: no verified reviews yet.</p>`;
  }
  const avg = summary.avgStars != null ? summary.avgStars.toFixed(1) : '—';
  const dist = ['5', '4', '3', '2', '1']
    .map((s) => `${s}★: ${summary.distribution[s] ?? 0}`)
    .join(' · ');
  const comments = summary.recentComments
    .map(
      (c) =>
        `<blockquote><p>${escapeHtml(c.comment)}</p><footer>${c.stars} out of 5 — ${escapeHtml(c.createdAt.slice(0, 10))}</footer></blockquote>`,
    )
    .join('\n');
  return `<section>
<h3>${escapeHtml(heading)}</h3>
<p>Average rating ${avg} out of 5 from ${summary.reviewCount} verified review${summary.reviewCount === 1 ? '' : 's'} (${dist}).</p>
${comments}
</section>`;
}

function pageShell(title: string, description: string, jsonLd: unknown, body: string): string {
  // JSON-LD sits inside a <script> block: a provider name containing
  // '</script>' would break out of it, so < > & are unicode-escaped
  // AFTER stringify (JSON.parse still reads the same values).
  const safeJson = JSON.stringify(jsonLd)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<script type="application/ld+json">${safeJson}</script>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderLandingPage(d: LandingPageData): string {
  const title = `${d.categoryName} in ${d.areaName}, ${d.cityName} | Near Service`;
  const description =
    d.providers.length > 0
      ? `Find trusted ${d.categoryName.toLowerCase()} providers in ${d.areaName}, ${d.cityName} on Near Service. ` +
        `${d.providers.length} verified provider${d.providers.length === 1 ? '' : 's'} with real customer reviews` +
        (d.fairPrice ? ` — typical price PKR ${d.fairPrice.typicalPrice}.` : '.')
      : `Looking for ${d.categoryName.toLowerCase()} in ${d.areaName}, ${d.cityName}? Near Service is coming soon — join the waitlist.`;
  const priceLine = d.fairPrice
    ? `<p>Fair price in ${escapeHtml(d.cityName)}: PKR ${d.fairPrice.minPrice} – ${d.fairPrice.maxPrice} (typical PKR ${d.fairPrice.typicalPrice}, based on ${d.fairPrice.sampleSize} quotes).</p>`
    : `<p>No local price data yet for ${escapeHtml(d.categoryName)} in ${escapeHtml(d.cityName)}.</p>`;
  const providerCards = d.providers
    .map(
      (p) => `<article>
<h2>${escapeHtml(p.shopName ?? p.displayName)}</h2>
<p>${escapeHtml(p.displayName)} · ${escapeHtml(p.providerType === 'SHOP' ? 'Shop' : 'Individual')} · Tier ${p.tier} · ${p.jobsCompleted} jobs completed${p.startingPricePkr != null ? ` · from PKR ${p.startingPricePkr}` : ''}</p>
${reviewSummaryHtml(p.reviewSummary, `What customers say about ${p.shopName ?? p.displayName}`)}
<p><a href="/shops/${escapeHtml(p.id)}">View ${escapeHtml(p.shopName ?? p.displayName)}’s shop page</a></p>
</article>`,
    )
    .join('\n');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: `${d.categoryName} in ${d.areaName}, ${d.cityName}`,
    serviceType: d.categoryName,
    areaServed: { '@type': 'City', name: `${d.areaName}, ${d.cityName}` },
    provider: d.providers.map((p) => ({
      '@type': 'LocalBusiness',
      name: p.shopName ?? p.displayName,
      aggregateRating:
        p.reviewSummary.reviewCount > 0
          ? { '@type': 'AggregateRating', ratingValue: p.reviewSummary.avgStars, reviewCount: p.reviewSummary.reviewCount }
          : undefined,
    })),
  };
  return pageShell(
    title,
    description,
    jsonLd,
    `<main>
<h1>${escapeHtml(d.categoryName)} in ${escapeHtml(d.areaName)}, ${escapeHtml(d.cityName)}</h1>
${priceLine}
${d.providers.length > 0 ? providerCards : '<p>No verified providers in this area yet — Near Service is onboarding supply.</p>'}
</main>`,
  );
}

export function renderShopPage(d: ShopPageData): string {
  const name = d.shopName ?? d.displayName;
  const title = `${name} — ${d.cityName ?? 'Near Service'} | Near Service`;
  const description = `${name} on Near Service: ${d.jobsCompleted} jobs completed` +
    (d.reviewSummary.reviewCount > 0 && d.reviewSummary.avgStars != null
      ? `, rated ${d.reviewSummary.avgStars.toFixed(1)} out of 5 from ${d.reviewSummary.reviewCount} verified reviews.`
      : ', no verified reviews yet.');
  const services = d.services
    .map(
      (s) =>
        `<li>${escapeHtml(s.categoryName)}${s.startingPricePkr != null ? ` — from PKR ${s.startingPricePkr}` : ''}</li>`,
    )
    .join('\n');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name,
    aggregateRating:
      d.reviewSummary.reviewCount > 0
        ? { '@type': 'AggregateRating', ratingValue: d.reviewSummary.avgStars, reviewCount: d.reviewSummary.reviewCount }
        : undefined,
  };
  return pageShell(
    title,
    description,
    jsonLd,
    `<main>
<h1>${escapeHtml(name)}</h1>
<p>${escapeHtml(d.displayName)} · ${escapeHtml(d.providerType === 'SHOP' ? 'Shop' : 'Individual')} · Tier ${d.tier} · ${d.jobsCompleted} jobs completed${d.completionRate != null ? ` · ${(d.completionRate * 100).toFixed(0)}% completion rate` : ''}${d.cityName ? ` · ${escapeHtml(d.cityName)}` : ''}</p>
<h2>Services</h2>
<ul>
${services}
</ul>
${reviewSummaryHtml(d.reviewSummary, `Customer reviews for ${name}`)}
</main>`,
  );
}

export function renderLandingIndex(entries: LandingIndexEntry[]): string {
  const title = 'Local services by area | Near Service';
  const description = 'Find trusted local service providers by service and area — book binding, AC repair, electricians, plumbers and mobile repair across Pakistan.';
  const links = entries
    .map(
      (e) =>
        `<li><a href="/services/${escapeHtml(e.categorySlug)}/${escapeHtml(e.areaSlug)}">${escapeHtml(e.categoryName)} in ${escapeHtml(e.areaName)}, ${escapeHtml(e.cityName)}</a> (${e.providerCount} provider${e.providerCount === 1 ? '' : 's'})</li>`,
    )
    .join('\n');
  return pageShell(
    title,
    description,
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title },
    `<main>
<h1>Local services by area</h1>
<ul>
${links}
</ul>
</main>`,
  );
}
