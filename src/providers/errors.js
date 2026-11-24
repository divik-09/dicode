export class ProviderError extends Error {
  constructor(message, { status = 0, provider = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
  }
}
export const isAbort = (e) => e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
export const isContextOverflow = (e) => /prompt is too long|context(_| )length|too many tokens|maximum context/i.test(e?.message || '');
export const isRetryable = (e) => [408, 409, 429, 500, 502, 503, 504, 529].includes(e?.status) || /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(e?.message || '');
