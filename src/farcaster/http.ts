// HTTP for the Farcaster adapters. Adapters take an injectable HttpFn, so the
// tests drive them with fakes that answer garbage, error or never answer at
// all; farcasterHttp below is the production one.
//
// Every request goes through the Studio's outbound destination check, the
// same one the importer and the mention sender use, because the hub URL is a
// setting and a setting must not be a way to reach a private address.

import { checkDestination, privateFetchAllowed } from "../outbound-policy.ts";
import { GENERATOR } from "../types.ts";
import type { Env } from "../types.ts";
import { FarcasterError } from "./types.ts";

export interface HttpRequest {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type HttpFn = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

export const FARCASTER_USER_AGENT = `${GENERATOR} (farcaster)`;
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The production HttpFn: destination-checked, no redirects, bounded body. */
export function farcasterHttp(env: Pick<Env, "ALLOW_PRIVATE_FETCH">): HttpFn {
  const allowPrivate = privateFetchAllowed(env);
  return async (url, request = {}) => {
    await checkDestination(url, allowPrivate, request.signal);
    const res = await fetch(url, {
      method: request.method ?? "GET",
      headers: { "User-Agent": FARCASTER_USER_AGENT, ...(request.headers ?? {}) },
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    });
    return {
      status: res.status,
      async text() {
        if (!res.body) return "";
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return text + decoder.decode();
            bytes += value.byteLength;
            if (bytes > MAX_BODY_BYTES) {
              await reader.cancel();
              throw new FarcasterError("malformed", "response body exceeds 2 MiB");
            }
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  };
}

/**
 * One request, mapped onto FarcasterError, with a timeout that holds even
 * when the HttpFn ignores its abort signal. Returns the parsed JSON body, or
 * null for an empty 2xx body.
 */
export async function requestJson(http: HttpFn, url: string, request: HttpRequest = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FarcasterError("timeout", `no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([send(http, url, { ...request, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function send(http: HttpFn, url: string, request: HttpRequest): Promise<unknown> {
  let res: HttpResponse;
  try {
    res = await http(url, request);
  } catch (e) {
    if (e instanceof FarcasterError) throw e;
    const name = (e as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") throw new FarcasterError("timeout", "request aborted");
    throw new FarcasterError("network", e instanceof Error ? e.message : "request failed");
  }
  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    if (e instanceof FarcasterError) throw e;
    throw new FarcasterError("network", "response body could not be read", res.status);
  }
  if (res.status < 200 || res.status >= 300) throw statusError(res.status, body);
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new FarcasterError("malformed", "response is not JSON", res.status);
  }
}

function statusError(status: number, body: string): FarcasterError {
  // The body is the backend's, so only a short, single-line excerpt of it is
  // kept: it ends up in a status row the owner reads, and nowhere else.
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 160);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) return new FarcasterError("auth", `HTTP ${status}${suffix}`, status);
  if (status === 404) return new FarcasterError("not_found", `HTTP ${status}${suffix}`, status);
  if (status === 429) return new FarcasterError("rate_limited", `HTTP ${status}${suffix}`, status);
  return new FarcasterError("http", `HTTP ${status}${suffix}`, status);
}

/** `base` + `path`, with query parameters; undefined values are left out. */
export function buildUrl(base: string, path: string, query: Record<string, string | number | boolean | undefined | null> = {}): string {
  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  return url.toString();
}
