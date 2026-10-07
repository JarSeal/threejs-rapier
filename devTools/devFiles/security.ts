import { networkInterfaces } from 'os';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import { DevFilesError } from './http';
import { DEV_FILES_TOKEN_HEADER } from './protocol';

/**
 * The checks a request passes before a route runs (p342 §2.2). Two threats: another device on
 * the LAN (every `dev*` script serves with `--host`), and any website open in the developer's
 * browser. A simple cross-origin POST is sent without a preflight, and a DNS-rebinding page is
 * even same-origin, so:
 * - the token (per server start, in `index.html`) keeps out a cross-origin page: it can't read
 *   the HTML, and the custom header forces a preflight that gets no CORS answer;
 * - the Host check keeps out a rebound page, which can read the token;
 * - the remote address check keeps out the LAN unless it's allowed.
 * Vite's own host check runs after these routes (configureServer's middlewares come first), and
 * not at all under HTTPS, so it doesn't cover them.
 */

export const createDevFilesToken = () => randomBytes(32).toString('hex');

/** The header's value; under HTTP/2 (`dev:https`) the host is `:authority` */
const getHostHeader = (req: IncomingMessage) => {
  const value = req.headers.host ?? req.headers[':authority'];
  return typeof value === 'string' ? value : undefined;
};

/** `example.com:8080` → `example.com`, `[::1]:8080` → `::1` */
const toHostName = (host: string) => {
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']')).toLowerCase();
  const colon = host.indexOf(':');
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
};

const normaliseAddress = (address: string) =>
  address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;

export const isLoopbackAddress = (address: string | undefined) => {
  if (!address) return false;
  const normalised = normaliseAddress(address);
  return normalised === '::1' || normalised.startsWith('127.');
};

const isLoopbackHostName = (name: string) =>
  name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name);

/** The machine's own addresses, read per request: a DHCP lease can change them */
const isOwnAddress = (name: string) =>
  Object.values(networkInterfaces()).some((infos) =>
    infos?.some((info) => normaliseAddress(info.address).toLowerCase() === name)
  );

/** Vite's `server.allowedHosts` rules: an exact name, or `.example.com` for it and subdomains */
const isInAllowedHosts = (name: string, allowedHosts: string[] | true) => {
  if (allowedHosts === true) return true;
  return allowedHosts.some((allowed) => {
    const entry = allowed.toLowerCase();
    if (!entry.startsWith('.')) return entry === name;
    return name === entry.slice(1) || name.endsWith(entry);
  });
};

export type RequestCheckOpts = {
  allowedHosts: string[] | true;
  isHttps: boolean;
};

/** BAD_HOST and BAD_ORIGIN, for every route */
export const checkHostAndOrigin = (req: IncomingMessage, opts: RequestCheckOpts) => {
  const host = getHostHeader(req);
  const name = host ? toHostName(host) : '';
  if (
    !name ||
    !(isLoopbackHostName(name) || isOwnAddress(name) || isInAllowedHosts(name, opts.allowedHosts))
  ) {
    throw new DevFilesError(
      'BAD_HOST',
      `The Host "${host ?? ''}" isn't this machine or in server.allowedHosts`
    );
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const ownOrigin = `${opts.isHttps ? 'https' : 'http'}://${host}`.toLowerCase();
    if (origin.toLowerCase() !== ownOrigin) {
      throw new DevFilesError('BAD_ORIGIN', `The Origin "${origin}" isn't ${ownOrigin}`);
    }
  }
};

export const isLocalRequest = (req: IncomingMessage) => isLoopbackAddress(req.socket.remoteAddress);

/** NOT_LOCAL and BAD_TOKEN, for every route but `status` */
export const checkDeviceAndToken = (
  req: IncomingMessage,
  opts: { token: string; isLANAllowed: boolean }
) => {
  if (!opts.isLANAllowed && !isLocalRequest(req)) {
    throw new DevFilesError(
      'NOT_LOCAL',
      'Dev files take requests from this machine only (AEK_DEV_FILES_LAN=true allows the LAN)'
    );
  }
  const header = req.headers[DEV_FILES_TOKEN_HEADER];
  const given = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(opts.token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new DevFilesError(
      'BAD_TOKEN',
      `The ${DEV_FILES_TOKEN_HEADER} header is missing or wrong`
    );
  }
};
