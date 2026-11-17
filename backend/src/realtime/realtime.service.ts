import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
/** In-process bridge to the Socket.IO server. The gateway registers its
 *  Server here; services emit without depending on the gateway class. */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;
  register(server: Server) { this.server = server; }
  emitToRoom(room: string, event: string, payload: unknown) {
    if (this.server) this.server.to(room).emit(event, payload);
    else this.logger.debug(`[realtime:offline] ${event} -> ${room}`);
  }
  emitToUser(userId: string, event: string, payload: unknown) { this.emitToRoom(`user:${userId}`, event, payload); }
}
