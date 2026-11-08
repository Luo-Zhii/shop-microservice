export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.statusCode = STATUS[code];
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError('VALIDATION_ERROR', m, d);
export const unauthorized = (m = 'Chưa đăng nhập') => new AppError('UNAUTHORIZED', m);
export const forbidden = (m = 'Không có quyền') => new AppError('FORBIDDEN', m);
export const notFound = (m = 'Không tìm thấy') => new AppError('NOT_FOUND', m);
export const conflict = (m: string, d?: unknown) => new AppError('CONFLICT', m, d);
export const upstream = (m: string, d?: unknown) => new AppError('UPSTREAM_ERROR', m, d);
