/**
 * Running external CLI tools (LibreOffice, tesseract, poppler, ImageMagick…).
 *
 *   run(cmd, args, { cwd, timeoutMs, input, env })  → { code, stdout, stderr, stdoutBuffer, durationMs }
 *   withTempDir(async (dir) => …)                   → temp dir removed afterwards (even on error)
 *   sofficeConvert(inputPath, 'pdf', outDir)        → absolute path of the converted file
 *   findExecutable('tesseract')                     → absolute path or null (PATH + /opt/homebrew/bin …)
 *
 * Every `run` goes through a per-tool concurrency limiter (soffice: 2, tesseract/pdftoppm: ~cores/2,
 * magick: 2, others: cores) so a burst of requests cannot fork-bomb the machine.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Executable lookup
// ─────────────────────────────────────────────────────────────────────────────

/** Extra directories searched after $PATH (Homebrew, MacPorts, LibreOffice.app…). */
export const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
  '/Applications/LibreOffice.app/Contents/MacOS',
  '/usr/lib/libreoffice/program',
  '/snap/bin',
];

function searchDirs(): string[] {
  const fromEnv = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([...fromEnv, ...EXTRA_BIN_DIRS])];
}

/** PATH value for child processes: the server's PATH plus the extra bin dirs. */
export function childPath(): string {
  return searchDirs().join(path.delimiter);
}

function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const exeCache = new Map<string, string | null>();

/** Absolute path of an executable (searching $PATH and EXTRA_BIN_DIRS), or null. Cached. */
export function findExecutable(name: string): string | null {
  if (name.includes('/') || name.includes('\\')) return isExecutableFile(name) ? path.resolve(name) : null;
  if (exeCache.has(name)) return exeCache.get(name)!;
  let found: string | null = null;
  for (const dir of searchDirs()) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) {
      found = candidate;
      break;
    }
  }
  exeCache.set(name, found);
  return found;
}

/** Forget cached lookups (e.g. after installing a tool while the server runs). */
export function clearExecutableCache(): void {
  exeCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency limiting
// ─────────────────────────────────────────────────────────────────────────────

export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(public readonly max: number) {}

  get pending(): number {
    return this.queue.length;
  }
  get running(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const cores = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
const DEFAULT_LIMITS: Record<string, number> = {
  soffice: 2,
  tesseract: Math.max(1, Math.floor(cores / 2)),
  pdftoppm: Math.max(2, Math.floor(cores / 2)),
  pdftotext: 4,
  pdfinfo: 4,
  magick: 2,
};
const limiters = new Map<string, Limiter>();

/** Normalize a command to its limiter group ('/opt/homebrew/bin/soffice' → 'soffice'). */
export function toolKey(cmd: string): string {
  let base = path.basename(cmd).toLowerCase().replace(/\.(exe|bin|com)$/, '');
  if (base === 'convert' || base === 'mogrify' || base === 'identify') base = 'magick';
  if (base === 'libreoffice' || base === 'soffice') base = 'soffice';
  return base;
}

/** The shared limiter for a tool (created on first use). */
export function limiter(tool: string): Limiter {
  const key = toolKey(tool);
  let l = limiters.get(key);
  if (!l) {
    l = new Limiter(DEFAULT_LIMITS[key] ?? cores);
    limiters.set(key, l);
  }
  return l;
}

/** Run fn while holding a slot of the tool's limiter. */
export function withLimit<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  return limiter(tool).run(fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// run()
// ─────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  cwd?: string;
  /** Kill the process (group) after this many ms. Default 120 000. 0 = no timeout. */
  timeoutMs?: number;
  /** Written to stdin (stdin is closed afterwards). */
  input?: string | Uint8Array;
  /** Extra environment variables (merged over process.env; PATH is extended with EXTRA_BIN_DIRS). */
  env?: Record<string, string | undefined>;
  /** Exit codes treated as success. Default [0]. */
  okCodes?: number[];
  /** Max bytes collected from stdout (default 1 GiB) / stderr (keeps the last 64 KiB). */
  maxStdoutBytes?: number;
  /** Concurrency group; defaults to the tool name. `false` = no limiting. */
  limit?: string | false;
  /** Abort (kills the process). */
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  durationMs: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly cmd: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly reason: 'exit' | 'timeout' | 'not-found' | 'aborted' | 'spawn' | 'output-limit',
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

const activeChildren = new Set<ChildProcess>();

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    // detached → the child leads its own process group; kill the group (soffice forks soffice.bin)
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Kill every running child process (used on shutdown). */
export function killAllChildren(): void {
  for (const c of activeChildren) killTree(c, 'SIGKILL');
  activeChildren.clear();
}

function tail(s: string, lines = 12): string {
  const t = s.trim().split(/\r?\n/).filter(Boolean);
  return t.slice(-lines).join('\n');
}

/**
 * Spawn `cmd args…`, collect stdout/stderr, resolve on success, reject with ExecError otherwise.
 * `cmd` may be a bare tool name (resolved with findExecutable) or a path.
 */
export function run(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const exe = findExecutable(cmd);
  const name = path.basename(cmd);
  if (!exe) {
    return Promise.reject(
      new ExecError(`${name} is not installed (not found on PATH)`, cmd, args, null, '', '', 'not-found'),
    );
  }
  const exec = () => spawnCollect(exe, name, args, opts);
  if (opts.limit === false) return exec();
  return withLimit(opts.limit ?? cmd, exec);
}

function spawnCollect(exe: string, name: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const okCodes = opts.okCodes ?? [0];
  const maxStdout = opts.maxStdoutBytes ?? 1024 * 1024 * 1024;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ExecError(`${name} aborted`, exe, args, null, '', '', 'aborted'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: childPath(), ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      reject(new ExecError(`${name} could not be started: ${(e as Error).message}`, exe, args, null, '', '', 'spawn'));
      return;
    }
    activeChildren.add(child);

    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let settled = false;
    let reason: ExecError['reason'] | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      activeChildren.delete(child);
      fn();
    };
    const kill = (why: ExecError['reason']) => {
      reason = why;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref();
    };
    const onAbort = () => kill('aborted');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => kill('timeout'), timeoutMs) : undefined;
    timer?.unref?.();

    child.stdout!.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxStdout) {
        if (!reason) kill('output-limit');
        return;
      }
      out.push(d);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      err += d;
      if (err.length > 65536) err = err.slice(-65536);
    });
    child.stdin!.on('error', () => {
      /* EPIPE when the tool exits before reading stdin — reported via exit code */
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new ExecError(
            e.code === 'ENOENT' ? `${name} is not installed (not found on PATH)` : `${name} failed to start: ${e.message}`,
            exe,
            args,
            null,
            '',
            err,
            e.code === 'ENOENT' ? 'not-found' : 'spawn',
          ),
        ),
      );
    });

    child.on('close', (code, signal) => {
      finish(() => {
        const stdoutBuffer = Buffer.concat(out);
        const stdout = stdoutBuffer.toString('utf8');
        const durationMs = Date.now() - started;
        if (reason === 'timeout') {
          reject(new ExecError(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`, exe, args, code, stdout, err, 'timeout'));
        } else if (reason === 'aborted') {
          reject(new ExecError(`${name} was cancelled`, exe, args, code, stdout, err, 'aborted'));
        } else if (reason === 'output-limit') {
          reject(new ExecError(`${name} produced too much output`, exe, args, code, stdout, err, 'output-limit'));
        } else if (code !== null && okCodes.includes(code)) {
          resolve({ code, stdout, stderr: err, stdoutBuffer, durationMs });
        } else {
          const detail = tail(err) || tail(stdout);
          const how = code !== null ? `exited with code ${code}` : `was killed (${signal})`;
          reject(new ExecError(`${name} ${how}${detail ? `: ${detail}` : ''}`, exe, args, code, stdout, err, 'exit'));
        }
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Temp dirs
// ─────────────────────────────────────────────────────────────────────────────

/** Create a fresh temp dir, run fn(dir), always remove the dir afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>, prefix = 'pdfwizard-'): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LibreOffice
// ─────────────────────────────────────────────────────────────────────────────

export interface SofficeOptions {
  /** Default 180 000 ms. */
  timeoutMs?: number;
  /** Import filter, e.g. 'writer_pdf_import' (PDF → editable Writer doc) or 'calc_pdf_import'. */
  infilter?: string;
  /** Extra args inserted before --convert-to. */
  extraArgs?: string[];
  signal?: AbortSignal;
}

let baseProfile: Promise<string | null> | null = null;

/**
 * A pre-initialized LibreOffice user profile. Creating a profile takes a few seconds, so we build
 * one once and copy it for every conversion (each conversion needs its own profile to run in
 * parallel with others).
 */
function getBaseProfile(): Promise<string | null> {
  if (!baseProfile) {
    baseProfile = (async () => {
      const dir = path.join(os.tmpdir(), `pdfwizard-soffice-base-${process.pid}`);
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.mkdir(dir, { recursive: true });
        await withTempDir(async (tmp) => {
          const src = path.join(tmp, 'warmup.txt');
          await fsp.writeFile(src, 'warm-up');
          await run(
            'soffice',
            [`-env:UserInstallation=${pathToFileURL(dir).href}`, '--headless', '--norestore', '--nologo', '--nodefault',
              '--nolockcheck', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', tmp, src],
            { timeoutMs: 120_000 },
          );
        });
        return dir;
      } catch {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        return null;
      }
    })();
    process.once('exit', () => {
      try {
        fs.rmSync(path.join(os.tmpdir(), `pdfwizard-soffice-base-${process.pid}`), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
  }
  return baseProfile;
}

/**
 * Convert a file with LibreOffice (headless). `outFormat` is a --convert-to spec such as 'pdf',
 * 'docx', 'xlsx', 'pptx', 'pdf:writer_pdf_Export', 'docx:MS Word 2007 XML' (no shell quoting: args are passed verbatim), 'txt:Text (encoded):UTF8'.
 * `outDir` must differ from the input's directory when the extension would not change.
 * Resolves with the absolute path of the output file.
 */
export async function sofficeConvert(
  inputPath: string,
  outFormat: string,
  outDir: string,
  opts: SofficeOptions = {},
): Promise<string> {
  const ext = outFormat.split(':')[0].trim().toLowerCase();
  const input = path.resolve(inputPath);
  const outDirAbs = path.resolve(outDir);
  await fsp.mkdir(outDirAbs, { recursive: true });
  const expected = path.join(outDirAbs, `${path.basename(input, path.extname(input))}.${ext}`);

  const profile = path.join(os.tmpdir(), `pdfwizard-soffice-${process.pid}-${randomBytes(6).toString('hex')}`);
  const base = await getBaseProfile();
  if (base) await fsp.cp(base, profile, { recursive: true }).catch(() => {});
  try {
    const args = [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--norestore',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--nofirststartwizard',
      ...(opts.infilter ? [`--infilter=${opts.infilter}`] : []),
      ...(opts.extraArgs ?? []),
      '--convert-to',
      outFormat,
      '--outdir',
      outDirAbs,
      input,
    ];
    const res = await run('soffice', args, { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal, cwd: outDirAbs });
    try {
      const st = await fsp.stat(expected);
      if (st.size === 0) throw new Error('empty output');
    } catch {
      const detail = tail(res.stderr, 6) || tail(res.stdout, 6);
      throw new ExecError(
        `LibreOffice could not convert ${path.basename(input)} to ${ext}${detail ? `: ${detail}` : ''}`,
        'soffice',
        args,
        res.code,
        res.stdout,
        res.stderr,
        'exit',
      );
    }
    return expected;
  } finally {
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
