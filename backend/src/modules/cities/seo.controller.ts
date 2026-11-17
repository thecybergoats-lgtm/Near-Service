// Public SEO pages (Phase 4, item 3) — server-rendered HTML, no auth.
// Served under the API prefix, e.g. GET /api/v1/services/ac-repair/
// satellite-town-quetta (PRD p.30: "landing pages per service + area").
// A reverse proxy can expose these at the site root later; the path
// shape after the prefix already matches the PRD format.
// Shop pages: GET /api/v1/shops/:providerId — real review summaries
// on public shop pages (indexable local SEO content).
import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../../common/guards/public.decorator';
import { Errors } from '../../common/errors/api-error';
import { SeoService } from './seo.service';
import { renderLandingIndex, renderLandingPage, renderShopPage } from './seo-render';

const SLUG = /^[a-z0-9-]+$/;

@Public()
@Controller()
export class SeoController {
  constructor(private seo: SeoService) {}

  @Get('services')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async index(): Promise<string> {
    return renderLandingIndex(await this.seo.landingIndex());
  }

  @Get('services/:categorySlug/:areaSlug')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async landing(
    @Param('categorySlug') categorySlug: string,
    @Param('areaSlug') areaSlug: string,
  ): Promise<string> {
    // Malformed slugs are a bad request, not a missing page.
    if (!SLUG.test(categorySlug) || !SLUG.test(areaSlug)) {
      throw Errors.badRequest('INVALID_SLUG', 'Slugs must be lowercase letters, digits and hyphens');
    }
    const data = await this.seo.landingPageData(categorySlug, areaSlug);
    return renderLandingPage(data);
  }

  @Get('shops/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async shop(@Param('id') id: string): Promise<string> {
    const data = await this.seo.shopPageData(id);
    return renderShopPage(data);
  }
}
