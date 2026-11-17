import { Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { FavouritesService } from './favourites.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

@Controller()
export class FavouritesController {
  constructor(private svc: FavouritesService) {}

  /** Favourite a provider. Always 201; a repeat favourite returns the same
   *  row with already=true (idempotent, no duplicate row). Unknown provider -> 404. */
  @Post('providers/:id/favourite') async add(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    const res = await this.svc.add(u.id, id);
    return res;
  }

  /** Unfavourite. Always 204, even when the provider was not favourited. */
  @Delete('providers/:id/favourite') @HttpCode(204) async remove(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    await this.svc.remove(u.id, id);
  }

  @Get('favourites') list(@CurrentUser() u: AuthUser, @Query() q: CursorQueryDto) {
    return this.svc.list(u.id, q.cursor, q.limit ?? 20);
  }
}
