import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

export interface WsErrorPayload {
  code: number;
  message: string;
  details?: unknown;
}

export interface WsErrorEnvelope {
  event: 'error';
  data: WsErrorPayload;
}

/**
 * Maps HTTP and WebSocket exceptions to a stable error contract for socket
 * clients: `{ event: 'error', data: { code, message, details } }`.
 *
 * When the client supplied an ack callback, the payload is delivered through
 * it instead of (or in addition to) the `error` event.
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const data = host.switchToWs().getData<unknown>();
    const payload = this.toPayload(exception);

    if (payload.code >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `WebSocket error: ${payload.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const ack = this.extractAck(data);
    if (ack) {
      ack(payload);
      return;
    }

    if (client && typeof client.emit === 'function') {
      const envelope: WsErrorEnvelope = { event: 'error', data: payload };
      client.emit('error', envelope);
    }
  }

  private toPayload(exception: unknown): WsErrorPayload {
    if (exception instanceof WsException) {
      const error = exception.getError();
      if (typeof error === 'string') {
        return { code: HttpStatus.BAD_REQUEST, message: error };
      }
      if (error && typeof error === 'object') {
        const obj = error as Record<string, unknown>;
        return {
          code:
            typeof obj.code === 'number'
              ? obj.code
              : HttpStatus.BAD_REQUEST,
          message:
            typeof obj.message === 'string'
              ? obj.message
              : 'WebSocket error',
          details: obj.details ?? obj,
        };
      }
      return { code: HttpStatus.BAD_REQUEST, message: 'WebSocket error' };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { code: status, message: response };
      }
      if (response && typeof response === 'object') {
        const obj = response as Record<string, unknown>;
        const message = obj.message;
        return {
          code: status,
          message: Array.isArray(message)
            ? message.join(', ')
            : typeof message === 'string'
              ? message
              : exception.message,
          details: obj,
        };
      }
      return { code: status, message: exception.message };
    }

    return {
      code: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }

  private extractAck(data: unknown): ((payload: WsErrorPayload) => void) | null {
    if (typeof data === 'function') {
      return data as (payload: WsErrorPayload) => void;
    }
    if (data && typeof data === 'object') {
      const candidate = (data as Record<string, unknown>).ack;
      if (typeof candidate === 'function') {
        return candidate as (payload: WsErrorPayload) => void;
      }
    }
    return null;
  }
}
