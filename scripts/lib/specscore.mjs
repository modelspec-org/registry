// The pinned SpecScore release that lints ModelSpec sources, CC0-1.0 like
// everything else here.
//
// Nothing that is run comes from a place a pull request can write. The release
// archive is kept in the per-user cache (git.mjs defaultCacheDir), but only as
// bytes: before EVERY execution its SHA-256 is compared with the pinned one
// (a cached archive that differs is discarded and downloaded again), and the
// binary is unpacked from those verified bytes into a fresh private directory
// that is removed afterwards. A binary that is already lying in the cache is
// never executed.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const version = '0.54.2';
export const builds = {
  'linux/x64': { asset: 'linux_amd64', sha: 'e13ddf1543768bbe1f4573bc99202f6e5729b3d2b140c37bad972bdfdf8af12a' },
  'darwin/arm64': { asset: 'darwin_arm64', sha: 'ddc0861c589961b8392607473cd767f07746dad733bdd0af713aa13c69f133f8' },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function downloadArchive(archive) {
  const response = await fetch(`https://github.com/specscore/specscore-cli/releases/download/v${version}/${archive}`);
  if (!response.ok) throw new Error(`cannot download ${archive}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// The verified archive bytes for `build`: the cached archive when its hash is
// the pinned one, else a download that has to match it (and is then cached).
export async function verifiedArchive({ cacheDir, build, download = downloadArchive }) {
  const archive = `specscore_${version}_${build.asset}.tar.gz`;
  const path = join(cacheDir, archive);
  if (existsSync(path)) {
    const cached = readFileSync(path);
    if (sha256(cached) === build.sha) return cached;
    rmSync(path, { force: true });
  }
  const bytes = await download(archive);
  const actual = sha256(bytes);
  if (actual !== build.sha) throw new Error(`${archive} SHA-256 is ${actual}, expected ${build.sha}`);
  mkdirSync(cacheDir, { recursive: true });
  const partial = mkdtempSync(join(cacheDir, '.archive-'));
  writeFileSync(join(partial, archive), bytes);
  renameSync(join(partial, archive), path);
  rmSync(partial, { recursive: true, force: true });
  return bytes;
}

// Unpacks the `specscore` binary from verified archive bytes into a fresh
// directory under cacheDir. Returns { path, dispose }.
export function unpackBinary(bytes, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const dir = mkdtempSync(join(cacheDir, '.bin-'));
  try {
    execFileSync('tar', ['-xzf', '-', '-C', dir, 'specscore'], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'] });
    chmodSync(join(dir, 'specscore'), 0o700);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cannot unpack specscore: ${String(error.stderr ?? error.message).trim()}`);
  }
  return { path: join(dir, 'specscore'), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// The binary to run: SPECSCORE (a path the person running this chose) or the
// verified, freshly unpacked pinned release.
export async function specscoreBinary({ cacheDir, env = process.env, platform = `${process.platform}/${process.arch}`, table = builds, download } = {}) {
  if (env.SPECSCORE) return { path: env.SPECSCORE, dispose: () => {} };
  const build = table[platform];
  if (!build) throw new Error(`no pinned specscore build for ${platform}; set SPECSCORE to an installed binary`);
  return unpackBinary(await verifiedArchive({ cacheDir, build, download }), cacheDir);
}
