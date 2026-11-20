export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'limit_reached' | 'platform_error' | 'too_large' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409,
  limit_reached: 403, platform_error: 400, too_large: 413, internal: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}
