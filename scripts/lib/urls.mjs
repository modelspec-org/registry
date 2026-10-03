// URL rules for what a record publishes (CC0-1.0). Built on the OpenVaultDB
// Directory's scripts/lib/urls.mjs (github.com/openvaultdb/directory), with
// stricter character sets so that what reaches index.json is safe to write
// into a link as it stands.
//
// A homepage that passes is, in full:
//
//   https://<host><path>
//
// - at most 200 characters, ASCII only, and no character other than the
//   letters A-Z a-z, the digits, and - . _ ~ / :   (so no whitespace, quote,
//   backtick, <, >, &, backslash, %, ?, # or @, and no control character);
// - host: dot-separated labels of lower-case letters, digits and hyphens, at
//   least two labels, none starting or ending with a hyphen, no trailing dot;
//   not an IP address in any spelling, not localhost, and not a local,
//   internal or reserved name; an international name is written as the xn--
//   form the URL parser would write;
// - no port (not even :443), no userinfo, no query, no fragment;
// - path: starts with /, only A-Z a-z 0-9 . _ ~ / - , no percent escape, no
//   empty segment (//), no . or .. segment.
//
// These checks read text. Nothing here fetches a URL, and a public-looking name
// such as 127.0.0.1.nip.io can resolve to a private address, which no check of
// the text can see: whoever fetches a homepage must check the address itself.
//
// URLs are parsed with the WHATWG URL parser, which also normalises the odd
// spellings of an address (0x7f.1, 2130706433, 017700000001, [::ffff:7f00:1],
// percent-encoded host names), so the checks below see the host a client would
// connect to. The text must also be exactly what that parser writes, so there is
// one spelling of every URL that is checked and published.

// Names that are never public: local, internal and reserved naming zones.
const privateSuffixes = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'arpa', 'intranet', 'corp', 'private',
  'svc', 'home', 'test', 'example', 'invalid', 'onion',
];

export const maxHomepageLength = 200;

// Dot-separated labels of 1 to 63 lower-case letters, digits and hyphens, none
// starting or ending with a hyphen, at least two labels, at most 253 characters.
const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const pathPattern = /^[A-Za-z0-9._~/-]*$/;

// A problem with the host of `url` for a public URL, or null.
export function hostProblem(url) {
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return `${url.hostname} is an IP address; a homepage names a host`;
  if (host.endsWith('.')) return `${url.hostname} ends with a dot; write the host without it`;
  if (host.split('.').some((label) => label === '')) return `${url.hostname} has an empty label`;
  if (/^\d+(\.\d+)*$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return `${url.hostname} is an IP address; a homepage names a host`;
  if (!host.includes('.')) return `${url.hostname} is a single-label name, not a public host`;
  for (const suffix of privateSuffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `${url.hostname} is a local, internal or reserved name (.${suffix}), not a public host`;
  }
  if (host.length > 253 || !hostPattern.test(host)) return `${url.hostname} is not a host name: use dot-separated labels of letters, digits and hyphens (no label starting or ending with a hyphen)`;
  return null;
}

// A problem with `value` as a public https URL, or null. Refused: anything but
// https, userinfo, a port, a query, a fragment, a host that is not public (see
// hostProblem), a path outside A-Z a-z 0-9 . _ ~ / - or with a percent escape,
// an empty or dot segment, and any spelling the URL parser would change.
export function publicHttpsProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'is not a URL';
  if (value !== value.trim() || /[\u0000- \u007f\\]/.test(value)) return 'contains whitespace, control characters or a backslash';
  let url;
  try { url = new URL(value); } catch { return 'is not a URL'; }
  if (url.protocol !== 'https:') return `must be https, not ${url.protocol.slice(0, -1)}`;
  if (url.username || url.password) return 'must not contain credentials (userinfo)';
  if (url.search || value.includes('?')) return 'must not contain a query';
  if (url.hash || value.includes('#')) return 'must not contain a fragment';
  const problem = hostProblem(url);
  if (problem) return problem;
  // The authority is what is written before the first slash; hostProblem has
  // already refused an IPv6 address, the only host that contains a colon.
  const authority = value.slice('https://'.length).split('/')[0];
  if (url.port || authority.includes(':')) return 'must not name a port (not even :443)';
  const path = value.slice('https://'.length + authority.length);
  if (path.includes('//')) return 'has an empty path segment (//)';
  if (path.includes('%')) return 'must not contain a percent escape; write the character itself, or leave it out';
  if (!pathPattern.test(path)) return 'has a character outside A-Z a-z 0-9 . _ ~ / - in its path';
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return 'has a . or .. segment';
  // The literal text must be the URL's own spelling, so that what is checked is
  // what is published (no mixed-case host, no decoded host, no default port).
  if (url.href !== value) return `is not written canonically (it would be ${url.href})`;
  return null;
}

// A problem with a record's `homepage`, or null: a public https URL of at most
// maxHomepageLength characters.
export function homepageProblem(value) {
  if (typeof value === 'string' && value.length > maxHomepageLength) return `is longer than ${maxHomepageLength} characters`;
  return publicHttpsProblem(value);
}
