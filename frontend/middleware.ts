import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import ipaddr from 'ipaddr.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 1000;
const MAX_REQUESTS_PER_WINDOW =
  Number.parseInt(process.env.NEXT_RATE_LIMIT_PER_MIN ?? '', 10) ||
  DEFAULT_MAX_REQUESTS;
const RATE_LIMITER_BUCKET_KEY = '__redgrouseRateLimiterBuckets';
const TRUSTED_CIDRS_KEY = '__redgrouseTrustedCloudfrontCidrs';
const CLOUDFRONT_IP_RANGES_URL =
  'https://ip-ranges.amazonaws.com/ip-ranges.json';
const TRUST_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

type RateBucket = {
  windowStart: number;
  count: number;
};

type BucketsMap = Map<string, RateBucket>;

type Cidr = {
  base: ipaddr.IPv4 | ipaddr.IPv6;
  prefixLength: number;
};

type TrustedCidrsState = {
  cidrs: Cidr[];
  lastFetched: number;
};

const globalScope = globalThis as typeof globalThis & {
  [RATE_LIMITER_BUCKET_KEY]?: BucketsMap;
  [TRUSTED_CIDRS_KEY]?: TrustedCidrsState;
};

const buckets: BucketsMap =
  globalScope[RATE_LIMITER_BUCKET_KEY] ?? new Map<string, RateBucket>();

if (!globalScope[RATE_LIMITER_BUCKET_KEY]) {
  globalScope[RATE_LIMITER_BUCKET_KEY] = buckets;
}

let trustedCidrsState =
  globalScope[TRUSTED_CIDRS_KEY] ??
  ({
    cidrs: [],
    lastFetched: 0,
  } as TrustedCidrsState);

if (!globalScope[TRUSTED_CIDRS_KEY]) {
  globalScope[TRUSTED_CIDRS_KEY] = trustedCidrsState;
}

async function ensureTrustedCidrsLoaded(): Promise<void> {
  const now = Date.now();
  if (
    trustedCidrsState.cidrs.length > 0 &&
    now - trustedCidrsState.lastFetched < TRUST_REFRESH_INTERVAL_MS
  ) {
    return;
  }

  const response = await fetch(CLOUDFRONT_IP_RANGES_URL, {
    headers: {
      'cache-control': 'no-cache',
    },
  });

  if (!response.ok) {
    // If we fail to fetch, keep existing data (if any).
    if (trustedCidrsState.cidrs.length === 0) {
      trustedCidrsState = {
        cidrs: [],
        lastFetched: now,
      };
    }
    return;
  }

  const json = (await response.json()) as AwsIpRanges;
  const cidrs: Cidr[] = [];

  for (const prefix of json.prefixes ?? []) {
    if (prefix.service === 'CLOUDFRONT' && prefix.ip_prefix) {
      const parsed = parseCidr(prefix.ip_prefix);
      if (parsed) {
        cidrs.push(parsed);
      }
    }
  }

  for (const prefix of json.ipv6_prefixes ?? []) {
    if (prefix.service === 'CLOUDFRONT' && prefix.ipv6_prefix) {
      const parsed = parseCidr(prefix.ipv6_prefix);
      if (parsed) {
        cidrs.push(parsed);
      }
    }
  }

  trustedCidrsState = {
    cidrs,
    lastFetched: now,
  };
  globalScope[TRUSTED_CIDRS_KEY] = trustedCidrsState;
}

export async function middleware(request: NextRequest) {
  await ensureTrustedCidrsLoaded();

  const directConnectionIp = getDirectConnectionIp(request);
  const allowForwarded =
    directConnectionIp !== null &&
    isTrustedProxy(directConnectionIp);

  const clientKey = extractClientIdentifier(request, allowForwarded);
  const path = request.nextUrl.pathname;
  const method = request.method;

  // Log request with IP and path
  console.log(`${method} ${path} from ${clientKey}`);

  if (allowRequest(clientKey)) {
    return NextResponse.next();
  }

  return new NextResponse('Too Many Requests', { status: 429 });
}

function allowRequest(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }

  if (bucket.count < MAX_REQUESTS_PER_WINDOW) {
    bucket.count += 1;
    return true;
  }

  return false;
}

function getDirectConnectionIp(request: NextRequest): string | null {
  // In Next.js middleware, we need to extract the direct connection IP from headers.
  // The last IP in x-forwarded-for is typically the direct connection IP.
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map((ip) => ip.trim());
    const lastIp = ips[ips.length - 1];
    if (lastIp) {
      return lastIp;
    }
  }

  // Fallback to x-real-ip if available
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) {
    return xRealIp.trim();
  }

  return null;
}

function extractClientIdentifier(
  request: NextRequest,
  allowForwarded: boolean,
): string {
  if (allowForwarded) {
    const viewerAddress = request.headers.get('cloudfront-viewer-address');
    if (viewerAddress) {
      const [ip] = viewerAddress.split(':');
      if (ip?.trim()) {
        return ip.trim();
      }
    }

    const cfConnectingIp = request.headers.get('cf-connecting-ip');
    if (cfConnectingIp) {
      return cfConnectingIp.trim();
    }

    const forwarded = request.headers.get('forwarded');
    if (forwarded) {
      for (const part of forwarded.split(';')) {
        const trimmed = part.trim();
        if (trimmed.toLowerCase().startsWith('for=')) {
          const value = trimmed.slice(4).trim().replaceAll('"', '');
          if (value) {
            return value;
          }
        }
      }
      return forwarded.trim();
    }

    const xForwardedFor = request.headers.get('x-forwarded-for');
    if (xForwardedFor) {
      const [ip] = xForwardedFor.split(',');
      if (ip?.trim()) {
        return ip.trim();
      }
    }
  }

  // Fallback: try to get direct connection IP
  const directIp = getDirectConnectionIp(request);
  if (directIp) {
    return directIp;
  }

  return 'unknown';
}

function isTrustedProxy(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }

  try {
    const parsedIp = ipaddr.parse(ip);
    return trustedCidrsState.cidrs.some(({ base, prefixLength }) => {
      if (base.kind() !== parsedIp.kind()) {
        return false;
      }
      return parsedIp.match(base, prefixLength);
    });
  } catch {
    return false;
  }
}

function parseCidr(cidr: string): Cidr | null {
  const [ip, prefix] = cidr.split('/');
  if (!ip || !prefix) {
    return null;
  }

  const prefixNum = Number.parseInt(prefix, 10);
  if (Number.isNaN(prefixNum)) {
    return null;
  }

  try {
    const base = ipaddr.parse(ip);
    return { base, prefixLength: prefixNum };
  } catch {
    return null;
  }
}

type AwsIpRanges = {
  prefixes?: Array<{ ip_prefix?: string; service?: string }>;
  ipv6_prefixes?: Array<{ ipv6_prefix?: string; service?: string }>;
};

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
