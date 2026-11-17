// Multi-city ops — unit tests for the SEO HTML builders (Phase 4, item 3).
// Pure rendering: no database. The integration spec covers the same
// builders fed with real provider/review rows.
import {
  escapeHtml,
  renderLandingPage,
  renderShopPage,
  renderLandingIndex,
  LandingPageData,
} from '../../src/modules/cities/seo-render';

const PAGE: LandingPageData = {
  categorySlug: 'ac-repair',
  categoryName: 'AC Repair',
  areaSlug: 'satellite-town-quetta',
  areaName: 'Satellite Town',
  cityName: 'Quetta',
  citySlug: 'quetta',
  providers: [
    {
      id: '20000000-0104-4000-8000-000000000004',
      displayName: 'Quetta Cool Air',
      shopName: 'Quetta Cool Air',
      providerType: 'SHOP',
      tier: 2,
      ratingAvg: 4.7,
      jobsCompleted: 178,
      startingPricePkr: 2500,
      reviewSummary: {
        reviewCount: 2,
        avgStars: 4.5,
        distribution: { '5': 1, '4': 1 },
        recentComments: [
          { stars: 5, comment: 'AC fixed the same day, great work.', createdAt: '2026-11-10T10:00:00.000Z' },
          { stars: 4, comment: 'Good service, fair price.', createdAt: '2026-11-09T10:00:00.000Z' },
        ],
      },
    },
  ],
  fairPrice: { minPrice: 1500, typicalPrice: 2500, maxPrice: 4500, sampleSize: 38, source: 'city' },
};

describe('escapeHtml', () => {
  it('escapes markup so provider names / review comments cannot break out', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml("it's & <that>")).toBe('it&#39;s &amp; &lt;that&gt;');
  });
});

describe('renderLandingPage', () => {
  it('has the PRD title/description format and real provider + review content', () => {
    const html = renderLandingPage(PAGE);
    expect(html).toContain('<title>AC Repair in Satellite Town, Quetta | Near Service</title>');
    expect(html).toContain('<meta name="description" content="Find trusted ac repair providers in Satellite Town, Quetta on Near Service. 1 verified provider with real customer reviews — typical price PKR 2500."');
    expect(html).toContain('<h1>AC Repair in Satellite Town, Quetta</h1>');
    expect(html).toContain('Quetta Cool Air');
    expect(html).toContain('178 jobs completed');
    expect(html).toContain('from PKR 2500');
    expect(html).toContain('Average rating 4.5 out of 5 from 2 verified reviews');
    expect(html).toContain('AC fixed the same day, great work.');
    expect(html).toContain('Fair price in Quetta: PKR 1500 – 4500 (typical PKR 2500, based on 38 quotes).');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"Service"');
  });

  it('escapes a hostile provider name and review comment', () => {
    const evil: LandingPageData = {
      ...PAGE,
      providers: [{
        ...PAGE.providers[0],
        displayName: '<img src=x onerror=alert(1)>',
        shopName: '<img src=x onerror=alert(1)>',
        reviewSummary: {
          reviewCount: 1, avgStars: 5, distribution: { '5': 1 },
          recentComments: [{ stars: 5, comment: '</blockquote><script>evil()</script>', createdAt: '2026-11-10T10:00:00.000Z' }],
        },
      }],
    };
    const html = renderLandingPage(evil);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('says plainly when an area has no providers yet', () => {
    const html = renderLandingPage({ ...PAGE, providers: [], fairPrice: null });
    expect(html).toContain('No verified providers in this area yet');
    expect(html).toContain('No local price data yet');
  });
});

describe('renderShopPage', () => {
  it('shows the shop name, stats and the real review summary', () => {
    const html = renderShopPage({
      providerId: '20000000-0104-4000-8000-000000000004',
      displayName: 'Quetta Cool Air',
      shopName: 'Quetta Cool Air',
      providerType: 'SHOP',
      tier: 2,
      ratingAvg: 4.7,
      jobsCompleted: 178,
      completionRate: 0.96,
      cityName: 'Quetta',
      services: [{ categorySlug: 'ac-repair', categoryName: 'AC Repair', startingPricePkr: 2500 }],
      reviewSummary: PAGE.providers[0].reviewSummary,
    });
    expect(html).toContain('<title>Quetta Cool Air — Quetta | Near Service</title>');
    expect(html).toContain('178 jobs completed');
    expect(html).toContain('96% completion rate');
    expect(html).toContain('Average rating 4.5 out of 5 from 2 verified reviews');
    expect(html).toContain('AC Repair — from PKR 2500');
  });

  it('says plainly when a shop has no reviews yet', () => {
    const html = renderShopPage({
      providerId: 'x', displayName: 'New Shop', shopName: 'New Shop', providerType: 'SHOP', tier: 0,
      ratingAvg: 0, jobsCompleted: 0, completionRate: null, cityName: null, services: [],
      reviewSummary: { reviewCount: 0, avgStars: null, distribution: {}, recentComments: [] },
    });
    expect(html).toContain('no verified reviews yet');
  });
});

describe('renderLandingIndex', () => {
  it('links every enabled landing page', () => {
    const html = renderLandingIndex([
      { categorySlug: 'ac-repair', categoryName: 'AC Repair', areaSlug: 'satellite-town-quetta', areaName: 'Satellite Town', cityName: 'Quetta', providerCount: 3 },
      { categorySlug: 'plumber', categoryName: 'Plumber', areaSlug: 'sariab-road-quetta', areaName: 'Sariab Road', cityName: 'Quetta', providerCount: 0 },
    ]);
    expect(html).toContain('<a href="/services/ac-repair/satellite-town-quetta">AC Repair in Satellite Town, Quetta</a> (3 providers)');
    expect(html).toContain('<a href="/services/plumber/sariab-road-quetta">Plumber in Sariab Road, Quetta</a> (0 providers)');
  });
});
