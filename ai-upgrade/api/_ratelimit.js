// Sliding-window rate limit, keyed by IP. Falls open if Redis isn't configured,
// so local dev works without it — but DO configure it before going public.
//
//   npm install @upstash/redis
//   env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const WINDOW_SECONDS = 600;   // 10 minutes
const MAX_REQUESTS  = 20;

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL) {
  const { Redis } = await import('@upstash/redis');
  redis = Redis.fromEnv();
}

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
}

/** @returns {Promise<boolean>} true = allowed */
export async function rateLimit(req, max = MAX_REQUESTS) {
  if (!redis) return true;                       // not configured — allow
  const key = `rl:${ipOf(req)}`;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, WINDOW_SECONDS);
    return n <= max;
  } catch {
    return true;                                 // Redis down — don't break the site
  }
}

/** Reject oversized bodies before they cost you anything. */
export function tooBig(body, limit = 4000) {
  try { return JSON.stringify(body || {}).length > limit; }
  catch { return true; }
}
