/** Domain errors the HTTP layer maps to status codes. Services throw these; routes never build responses for them by hand. */
export class HttpError extends Error {
  /** `extra` adds fields to the error body, e.g. the existing feed's id on a duplicate subscription. */
  constructor(readonly status: number, message: string, readonly code: string = "error", readonly extra: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
  }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`, "not_found");
export const conflict = (message: string, extra?: Record<string, string>) => new HttpError(409, message, "conflict", extra);
export const badRequest = (message: string) => new HttpError(400, message, "bad_request");
export const unauthorized = (message = "authentication required") => new HttpError(401, message, "unauthorized");
export const gone = (what: string) => new HttpError(410, `${what} is no longer available`, "gone");
export const tooManyRequests = (message: string) => new HttpError(429, message, "rate_limited");
