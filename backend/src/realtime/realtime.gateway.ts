import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { RealtimeService } from './realtime.service';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../database/redis.service';
import { evaluateLocationPoint } from '../modules/jobs/jobs-query.service';

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/' })
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  constructor(private realtime: RealtimeService, private db: DatabaseService, private redis: RedisService) {}
  afterInit(server: Server) { this.realtime.register(server); this.logger.log('Socket.IO gateway ready'); }
  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? (client.handshake.query?.token as string);
      if (!token) { client.disconnect(); return; }
      const payload = jwt.verify(token, env.jwtAccessSecret) as Record<string, unknown>;
      (client as unknown as { userId: string }).userId = String(payload.sub);
      client.join(`user:${payload.sub}`);
      this.logger.debug(`socket connected user=${payload.sub}`);
    } catch { client.disconnect(); }
  }
  @SubscribeMessage('join')
  join(@ConnectedSocket() client: Socket, @MessageBody() room: string) {
    if (typeof room === 'string' && /^(request|job):[0-9a-f-]+$/.test(room)) client.join(room);
    return { ok: true };
  }
  @SubscribeMessage('presence.heartbeat')
  heartbeat(@ConnectedSocket() client: Socket, @MessageBody() body: { lat: number; lng: number }) {
    const userId = (client as unknown as { userId: string }).userId;
    this.server.to(`user:${userId}`).emit('presence.ack', { at: new Date().toISOString(), ...body });
    return { ok: true };
  }
  @SubscribeMessage('typing')
  typing(@ConnectedSocket() client: Socket, @MessageBody() body: { chat_id: string }) {
    client.to(`chat:${body.chat_id}`).emit('typing', { userId: (client as unknown as { userId: string }).userId });
  }
  @SubscribeMessage('message.read')
  read(@ConnectedSocket() client: Socket, @MessageBody() body: { chat_id: string; message_id: string }) {
    client.to(`chat:${body.chat_id}`).emit('message.read', body);
  }
  /** Live tracking: provider -> server -> customer (room job:{jobId}).
   *  Accepts only the job's own provider, only while PROVIDER_EN_ROUTE /
   *  ITEM_PICKED_UP (once ARRIVED or later, tracking stops and points are
   *  rejected). A point implying >200 km/h from the last stored point is a
   *  teleport: ignored, flagged in fraud_signals, never emitted. Accepted
   *  points are persisted to provider_locations and the latest point is
   *  cached in Redis (provider:loc:{jobId}, 48h TTL) for fast reads.
   *  ETA uses distance / 30 km/h urban assumption, minimum 1 minute. */
  @SubscribeMessage('provider.location')
  async location(@ConnectedSocket() client: Socket, @MessageBody() body: { job_id: string; lat: number; lng: number; at?: string }) {
    const userId = (client as unknown as { userId: string }).userId;
    if (!body || typeof body.job_id !== 'string' || typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return { ok: false, error: 'INVALID_LOCATION' };
    }
    const job = (await this.db.query(
      `SELECT j.state, p.user_id AS provider_user_id,
              ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng
       FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id
       JOIN service_requests r ON r.id=j.request_id WHERE j.id=$1`, [body.job_id])).rows[0] as unknown as
      { state: string; provider_user_id: string; lat: string; lng: string } | undefined;
    if (!job) return { ok: false, error: 'JOB_NOT_FOUND' };
    if (job.provider_user_id !== userId) return { ok: false, error: 'NOT_JOB_PROVIDER' };
    const at = body.at ? new Date(body.at) : new Date();
    if (Number.isNaN(at.getTime())) return { ok: false, error: 'INVALID_LOCATION' };
    const prevRow = (await this.db.query<{ lat: string; lng: string; created_at: string }>(
      `SELECT ST_Y(point::geometry)::text AS lat, ST_X(point::geometry)::text AS lng, created_at
       FROM provider_locations WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1`, [body.job_id])).rows[0];
    const verdict = evaluateLocationPoint({
      state: job.state,
      prev: prevRow ? { lat: Number(prevRow.lat), lng: Number(prevRow.lng), at: new Date(prevRow.created_at) } : null,
      curr: { lat: body.lat, lng: body.lng, at },
      jobLat: Number(job.lat), jobLng: Number(job.lng),
    });
    if (!verdict.ok) {
      if (verdict.error === 'IMPLAUSIBLE_SPEED') {
        await this.db.query(`INSERT INTO fraud_signals (user_id, job_id, signal, detail) VALUES ($1,$2,'teleport_location',$3)`,
          [userId, body.job_id, JSON.stringify({ lat: body.lat, lng: body.lng, speed_kmh: verdict.speed_kmh })]);
      }
      return { ok: false, error: verdict.error };
    }
    await this.db.query(
      `INSERT INTO provider_locations (job_id, provider_id, point, speed_kmh)
       VALUES ($1, (SELECT id FROM provider_profiles WHERE user_id=$2), ST_SetSRID(ST_MakePoint($4,$3),4326)::geography, $5)`,
      [body.job_id, userId, body.lat, body.lng, verdict.speed_kmh]);
    await this.redis.set(`provider:loc:${body.job_id}`, JSON.stringify({ lat: body.lat, lng: body.lng, at: at.toISOString() }), 48 * 3600);
    const payload = { job_id: body.job_id, lat: body.lat, lng: body.lng, at: at.toISOString(), distance_km: verdict.distance_km, eta_minutes: verdict.eta_minutes };
    this.server.to(`job:${body.job_id}`).emit('provider.location', payload);
    return { ok: true, ...payload };
  }
}
