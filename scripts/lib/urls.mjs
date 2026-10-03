// URL rules for what a record publishes (CC0-1.0). The same rules as the OpenVaultDB
// Directory's scripts/lib/urls.mjs (github.com/openvaultdb/directory), which
// checks the URLs of a manifest; this copy carries what a registry needs.
//
// A homepage is a public https URL: no userinfo, query or fragment, no IP
// address, no localhost, and no local, internal or reserved name. It is not
// fetched: the checks read the text only, so they cannot see what a name
// resolves to (a public-looking name such as 127.0.0.1.nip.io can resolve to a
// private address). Whoever fetches a homepage must check the address itself.
//
// URLs are parsed with the WHATWG URL parser, which also normalises the odd
// spellings of an address (0x7f.1, 2130706433, 017700000001, [::ffff:7f00:1],
// percent-encoded host names), so the checks below see the host a client would
// connect to. Each URL must also be written the way that parser would write it,
// so there is exactly one spelling of every URL that is checked and published:
// no trailing dot or empty label in the host, no empty path segment, no
// percent-encoded character that stands for an unreserved one, no dot segment.

// Names that are never public: local, internal and reserved naming zones.
const privateSuffixes = [
  'localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'arpa', 'intranet', 'corp', 'private',
  'svc', 'home', 'test', 'example', 'invalid', 'onion',
];

export const maxHomepageLength = 200;

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
  return null;
}

// A problem with `value` as a public https URL, or null. Refused: anything but
// https, userinfo, a query, a fragment, a host that is not public (see
// hostProblem), a malformed or non-canonical spelling.
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
  if (url.pathname.includes('//')) return 'has an empty path segment (//)';
  for (const match of url.pathname.matchAll(/%([0-9a-fA-F]{2})/g)) {
    const character = String.fromCharCode(Number.parseInt(match[1], 16));
    if (/[A-Za-z0-9\-._~]/.test(character)) return `writes ${match[0]} for ${character}; write the character itself (one spelling per URL)`;
  }
  // The literal text must be the URL's own spelling, so that what is checked is
  // what is published (no %2e dot segments, no mixed-case host, no decoded host).
  if (url.href !== value) return `is not written canonically (it would be ${url.href})`;
  return null;
}

// A problem with a record's `homepage`, or null: a public https URL of at most
// maxHomepageLength characters.
export function homepageProblem(value) {
  if (typeof value === 'string' && value.length > maxHomepageLength) return `is longer than ${maxHomepageLength} characters`;
  return publicHttpsProblem(value);
}
