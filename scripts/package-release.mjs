import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = join(root, 'releases');
const serverOnly = process.argv.includes('--server-only');
const localOnly = process.argv.includes('--local-only');
const verifyNative = process.argv.includes('--verify-native');
if (serverOnly && localOnly) throw new Error('Choose either --server-only or --local-only.');
const go = process.env.GO_BINARY || 'go';
if (!serverOnly) {
  try { execFileSync(go, ['version'], { stdio: 'inherit' }); }
  catch { throw new Error('로컬 실행 파일을 빌드하려면 Go가 필요합니다. Go를 설치하거나 GO_BINARY에 실행 파일 경로를 지정하세요. 서버용만 만들려면 npm run build:server를 사용하세요.'); }
}
await readFile(join(root, 'dist/index.html'));
await mkdir(output, { recursive: true });

// Include the installed production packages' license texts in both distributions.
const visited = new Set();
const notices = [`Data Migration Validation ${pkg.version}`, 'Third-party software notices', ''];
async function licenses(name, from) {
  const require = createRequire(join(from, 'package.json'));
  let directory;
  for (const base of require.resolve.paths(name) || require.resolve.paths('__license_lookup__') || []) {
    try { await readFile(join(base, name, 'package.json')); directory = join(base, name); break; } catch {}
  }
  if (!directory || visited.has(directory)) return;
  visited.add(directory);
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  notices.push(`${metadata.name}@${metadata.version} — ${JSON.stringify(metadata.license || metadata.licenses || 'See package documentation')}`);
  for (const file of (await readdir(directory)).filter(file => /^(license|licence|copying|notice)(\.|$)/i.test(file))) {
    try { notices.push(await readFile(join(directory, file), 'utf8')); } catch {}
  }
  notices.push('');
  for (const dependency of Object.keys(metadata.dependencies || {})) await licenses(dependency, directory);
}
for (const dependency of Object.keys(pkg.dependencies)) await licenses(dependency, root);
const noticeText = notices.join('\n');

async function zipDirectory(folder, filename) {
  const zip = new JSZip();
  async function add(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await add(path, prefix + entry.name + '/');
      else zip.file(prefix + entry.name, await readFile(path));
    }
  }
  await add(folder);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const path = join(output, filename);
  await writeFile(path, bytes);
  console.log(`${path} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
}

if (!localOnly) {
  const directory = join(output, 'server');
  await rm(directory, { recursive: true, force: true });
  await cp(join(root, 'dist'), directory, { recursive: true });
  await writeFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), noticeText);
  await writeFile(join(directory, 'README.txt'), `데이터 이행 검증 ${pkg.version} — 서버 배포용\n\n이 폴더 전체를 내부 정적 HTTP(S) 서버에 배치하세요.\n사용자는 배포된 주소에 Chrome 또는 Edge로 접속합니다.\n.wasm MIME 형식: application/wasm\n인터넷 연결, 사용자 PC의 Node.js·Python 설치는 필요하지 않습니다.\nCSV 데이터는 브라우저에서 처리하며 서버에 업로드하지 않습니다.\nindex.html을 더블클릭해서 실행하는 배포본이 아닙니다.\n`);
  await zipDirectory(directory, `data-migration-validation-server-v${pkg.version}.zip`);
}

if (!serverOnly) {
  const stage = await mkdtemp(join(tmpdir(), 'datacompare-launcher-'));
  const environment = { ...process.env, CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOCACHE: process.env.GOCACHE || join(tmpdir(), 'datacompare-go-build-cache') };
  try {
    for (const file of ['main.go', 'main_test.go', 'go.mod']) await cp(join(root, 'tools/launcher', file), join(stage, file));
    await cp(join(root, 'dist'), join(stage, 'web'), { recursive: true });
    execFileSync(go, ['test', './...'], { cwd: stage, env: environment, stdio: 'inherit' });
    const directory = join(output, 'local-windows-x64');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const flags = `-s -w -X main.version=${pkg.version}`;
    execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags', flags, '-o', join(directory, 'DataMigrationValidation.exe'), '.'], { cwd: stage, env: { ...environment, GOOS: 'windows', GOARCH: 'amd64' }, stdio: 'inherit' });
    const goroot = execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8', env: environment }).trim();
    await writeFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), noticeText + '\nGo standard library\n' + await readFile(join(goroot, 'LICENSE'), 'utf8'));
    await writeFile(join(directory, 'README.txt'), `데이터 이행 검증 ${pkg.version} — 로컬 실행용 (Windows x64)\r\n\r\n1. ZIP 파일을 폴더에 모두 압축 해제합니다.\r\n2. DataMigrationValidation.exe를 더블클릭합니다.\r\n3. 자동으로 열린 브라우저에서 사용합니다. 브라우저가 열리지 않으면 실행 창의 URL을 복사하세요.\r\n4. 사용 중에는 실행 창을 켜두세요. 종료하려면 창을 닫거나 Ctrl+C를 누르세요.\r\n\r\nNode.js·Python·npm 설치 및 인터넷 연결은 필요하지 않습니다.\r\n최신 Chrome 또는 Edge와 Windows 10 이상 64비트 환경을 대상으로 합니다.\r\n실행 파일 안에 화면·WASM·Worker가 포함되어 있어 dist 폴더가 별도로 필요하지 않습니다.\r\n127.0.0.1의 빈 포트만 사용하며 외부 PC에는 서버를 공개하지 않습니다.\r\n설치·서비스 등록·방화벽 설정 변경을 수행하지 않습니다.\r\n사내 정책상 실행 파일 사용이 허용되어야 합니다.\r\n옵션: -port 5175 (포트 지정), -no-browser (자동 브라우저 열기 생략)\r\n`);
    await zipDirectory(directory, `data-migration-validation-local-windows-x64-v${pkg.version}.zip`);
    if (verifyNative) {
      const verify = join(output, '.verify');
      await mkdir(verify, { recursive: true });
      execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags', flags, '-o', join(verify, process.platform === 'win32' ? 'launcher.exe' : 'launcher'), '.'], { cwd: stage, env: environment, stdio: 'inherit' });
      console.log('Native verification launcher ready.');
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
}
