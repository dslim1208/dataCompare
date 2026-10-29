import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import JSZip from 'jszip';

const root = resolve('.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const launcher = process.env.RELEASE_LAUNCHER || join(root, 'releases/.verify', process.platform === 'win32' ? 'launcher.exe' : 'launcher');
const children = [];
async function start() {
  const child = spawn(launcher, ['-no-browser'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Launcher startup timed out')); }, 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Launcher exited: ${code} ${output}`)); });
    child.stderr.on('data', bytes => { output += bytes; });
    child.stdout.on('data', bytes => {
      output += bytes;
      const match = output.match(/URL: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}
try {
  const address = await start();
  const other = await start();
  assert.notEqual(address, other);
  const serverFiles = join(root, 'releases/server');
  const html = await fetch(address);
  assert.equal(html.status, 200);
  assert.equal(await html.text(), await readFile(join(serverFiles, 'index.html'), 'utf8'));
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  const assets = await readdir(join(serverFiles, 'assets'));
  for (const file of assets) {
    const response = await fetch(address + 'assets/' + file);
    assert.equal(response.status, 200, file);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = await readFile(join(serverFiles, 'assets', file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(expected).digest('hex'), file);
    if (file.endsWith('.wasm')) assert.equal(response.headers.get('content-type'), 'application/wasm');
  }
  assert.equal((await fetch(address, { method: 'POST' })).status, 405);
  assert.equal((await fetch(address + 'assets/')).status, 404);
  const forbidden = await new Promise((resolve, reject) => {
    const target = new URL(address);
    http.get({ hostname: target.hostname, port: target.port, headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forbidden, 403);
  for (const edition of ['server', 'local-windows-x64']) {
    const zip = await JSZip.loadAsync(await readFile(`releases/data-migration-validation-${edition}-v${pkg.version}.zip`));
    assert.ok(zip.file('README.txt'));
    assert.ok(zip.file('THIRD_PARTY_NOTICES.txt'));
    assert.equal(zip.file(/\.csv$/).length, 0);
    if (edition === 'server') {
      assert.ok(zip.file('index.html'));
      assert.equal(zip.file(/\.wasm$/).length, 2);
    } else {
      const exe = await zip.file('DataMigrationValidation.exe').async('nodebuffer');
      assert.equal(exe.toString('ascii', 0, 2), 'MZ');
      const pe = exe.readUInt32LE(0x3c);
      assert.equal(exe.toString('ascii', pe, pe + 4), 'PE\0\0');
      assert.equal(exe.readUInt16LE(pe + 4), 0x8664);
      assert.ok((await stat('releases/local-windows-x64/DataMigrationValidation.exe')).size > 70_000_000);
    }
  }
  console.log(`PASS: 독립 실행·동시 실행 포트 분리·전체 자산 일치·WASM MIME·로컬 접근 제한·서버/Windows x64 ZIP 구조\nURL: ${address}`);
} finally { for (const child of children) child.kill(); }
