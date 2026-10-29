# 데이터 이행 검증 배포 안내

## 1. 서버용

`npm run build:server`로 `releases/data-migration-validation-server-v0.1.0.zip`을 만듭니다. Node.js·npm으로 빌드하며 Go는 필요하지 않습니다. ZIP의 내용을 내부 정적 HTTP(S) 서버에 모두 배치하고 사용자에게 URL을 전달합니다. 사용자 PC에는 브라우저만 있으면 됩니다.

- `index.html`, `assets/` 전체를 함께 배치합니다. 하위 경로 배포도 지원합니다.
- `.wasm`은 `application/wasm`으로 제공합니다.
- 인터넷 연결·외부 CDN·외부 API는 실행 중 필요하지 않습니다.
- 데이터 검증은 브라우저에서 수행하며 CSV를 웹 서버에 업로드하지 않습니다.
- 서버의 CSP가 Worker와 WASM 실행을 허용해야 합니다. 설정 예시는 README를 참고하세요.

## 2. 로컬 파일 실행용

`npm run build:local`로 `releases/data-migration-validation-local-windows-x64-v0.1.0.zip`을 만듭니다. 빌드 PC에는 Node.js·npm·Go가 필요하며 사용자 PC에는 Node.js·Python·npm 설치가 필요하지 않습니다.

1. Windows 64비트 PC로 ZIP을 옮기고 폴더에 압축을 해제합니다.
2. `DataMigrationValidation.exe`를 더블클릭합니다.
3. 자동으로 열린 Chrome·Edge에서 검증합니다. 기본 브라우저가 열리지 않으면 실행 창의 `URL:` 주소를 복사해 브라우저 주소창에 입력합니다.
4. 사용하는 동안 실행 창을 켜두고, 종료 시 실행 창을 닫거나 Ctrl+C를 누릅니다.

화면·WASM·Worker는 실행 파일에 내장되어 별도 `dist` 폴더가 필요하지 않습니다. 현재 실행 파일이 위치한 폴더나 작업 디렉터리에도 의존하지 않습니다. 실행 시 PC 내부의 `127.0.0.1`에만 서버를 열며 빈 포트를 자동 선택합니다. 외부 컴퓨터에 서버를 공개하거나 서비스를 설치하지 않습니다. CSV 데이터는 브라우저에서 처리합니다. 여러 번 실행하면 별도 포트로 열립니다.

명령줄 옵션은 다음과 같습니다.

```text
DataMigrationValidation.exe -port 5175
DataMigrationValidation.exe -no-browser
```

회사 보안 정책에 따라 전달받은 실행 파일의 사용이 허용돼야 합니다. 이 배포본은 별도의 코드 서명을 포함하지 않습니다. 대상은 Windows 10 이상 x64이며 ARM64·32비트 Windows용 실행 파일은 제공하지 않습니다. 실제 대상 PC에서 실행·브라우저 자동 열기·CSV 선택·다운로드를 확인해야 합니다.

## 3. 빌드와 검증

```sh
npm ci
npm run release -- --verify-native
npm run test:release
```

`--verify-native`는 Windows x64 배포 파일 외에 빌드 PC에서 확인할 실행 파일을 `releases/.verify/`에 생성합니다. 이 폴더는 배포 ZIP에 포함하지 않습니다. `GO_BINARY`로 Go 실행 경로를 지정할 수 있습니다. Go 빌드에는 표준 라이브러리만 사용하며 도구 체인 자동 다운로드와 외부 Go 모듈 다운로드를 하지 않습니다.

`test:release`는 임의 작업 디렉터리에서 실행해 내장 파일 제공, 두 프로세스의 포트 분리, 전체 웹 자산의 해시 일치, WASM MIME, 허용 HTTP 메서드·Host, ZIP 구성과 Windows x64 실행 파일 형식을 확인합니다. `RELEASE_LAUNCHER`로 다른 검증용 실행 파일 경로를 지정할 수 있습니다.

브라우저 통합 테스트는 검증용 실행 파일을 `-no-browser`로 실행한 뒤 출력된 주소를 `TEST_URL`로 지정하여 수행합니다. `npm test`, `npm run test:batch`, `npm run test:template`로 단일 검증·일괄 검증·템플릿을 확인합니다. Windows x64 크로스 빌드와 다른 OS의 네이티브 실행 확인은 Windows 자체의 실제 실행 확인을 대신하지 않습니다.

두 ZIP에는 사용 안내와 서드파티 라이선스 고지를 함께 포함합니다. 소스·샘플 CSV·실제 업무 데이터·개인 다운로드 파일·제안서·발표자료는 포함하지 않습니다. `releases/`는 Git에서 제외합니다.

### 확인 결과 — 2026-10-29

- 서버용 ZIP 약 16.5 MiB, 로컬 Windows x64 ZIP 약 19.0 MiB 생성.
- Go 표준 라이브러리 테스트와 Windows x64 크로스 빌드 통과. ZIP 내부의 Windows PE x64 형식 확인.
- macOS ARM64 네이티브 검증용 실행 파일을 다른 작업 폴더에서 실행하고, 두 프로세스가 서로 다른 포트를 사용하는지 확인.
- 내장 웹 자산 전체의 SHA-256 일치, WASM MIME, 로컬 Host 제한과 HTTP 메서드 제한 확인.
- 내장 서버 URL에서 단일 검증·일괄 검증·템플릿 통합 테스트 통과. 외부 요청·페이지 오류 0건.
- 실제 Windows PC, 기본 브라우저 자동 열기와 회사 실행 파일 정책은 별도 확인 대상.
