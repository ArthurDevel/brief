type RateLimitRecord = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Map<string, RateLimitRecord>>();

function getBucket(name: string): Map<string, RateLimitRecord> {
  let bucket = buckets.get(name);
  if (!bucket) {
    bucket = new Map<string, RateLimitRecord>();
    buckets.set(name, bucket);
  }

  return bucket;
}

export function checkRateLimit(
  bucketName: string,
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const bucket = getBucket(bucketName);
  const now = Date.now();

  for (const [entryKey, entry] of bucket.entries()) {
    if (entry.resetAt <= now) {
      bucket.delete(entryKey);
    }
  }

  const current = bucket.get(key);
  if (!current || current.resetAt <= now) {
    bucket.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return { allowed: true };
  }

  if (current.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return { allowed: true };
}
