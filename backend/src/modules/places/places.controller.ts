import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Public } from '../../common/guards/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { IsLat, IsLng, ToNumber } from '../../common/validation/validators';
import { LAUNCH_CATEGORY_SLUGS, PlacesService } from './places.service';

export class PlacesNearbyQueryDto {
  @IsLat() @ToNumber() lat!: number;
  @IsLng() @ToNumber() lng!: number;
  /** Only the 5 launch categories are mapped to OSM tags; anything else
   *  is a 422 VALIDATION_FAILED (same rule as every other query DTO). */
  @IsString() @IsIn([...LAUNCH_CATEGORY_SLUGS]) category_slug!: string;
  @IsOptional() @ToNumber() @IsNumber() @Min(0.5) @Max(50) radius_km?: number;
}

@Controller('places')
export class PlacesController {
  constructor(private svc: PlacesService) {}

  /** Real-world shops near the user, from OpenStreetMap (free, no key).
   *  Public and rate-limited like GET /providers/nearby. Never 500s on an
   *  upstream problem — the service answers {items: [], degraded: true}. */
  @Public() @RateLimit('nearby') @Get('nearby') nearby(@Query() q: PlacesNearbyQueryDto) {
    return this.svc.nearby({
      lat: q.lat,
      lng: q.lng,
      category_slug: q.category_slug,
      radius_km: q.radius_km,
    });
  }
}
