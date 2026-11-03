# Security policy / 보안 정책

## Reporting a vulnerability / 취약점 신고

Please **do not open a public issue** for security problems.
Use GitHub's private reporting: **Security → Report a vulnerability** on this repository.
Include the hagis and Tabby versions and steps to reproduce.

보안 문제는 **공개 이슈로 올리지 말고**, 이 저장소의 **Security → Report a vulnerability** (비공개 신고)로 알려 주세요.
hagis·Tabby 버전과 재현 방법을 함께 적어 주시면 됩니다.

## Scope / 범위

In scope: hagis code (web panes and certificate handling, file drop → terminal paste quoting, Markdown rendering, installer scripts).
Out of scope: vulnerabilities in Tabby itself (report them to [Eugeny/tabby](https://github.com/Eugeny/tabby/security)) and in sites or devices opened inside web panes.

hagis 코드(웹 패널·인증서 처리, 파일 끌어다 놓기 → 터미널 붙여넣기 인용, Markdown 렌더링, 설치 스크립트)가 대상입니다.
Tabby 자체의 취약점은 [Eugeny/tabby](https://github.com/Eugeny/tabby/security) 로, 웹 패널에서 연 사이트·장비의 취약점은 해당 제조사로 알려 주세요.

## Design notes / 설계 메모

- No telemetry. The only request hagis makes on its own is the update check (GitHub releases API, once a day, sends no data; can be turned off). Updates are verified with SHA-256 and limited to GitHub hosts. / 원격 수집 없음. hagis 가 직접 보내는 요청은 업데이트 확인(GitHub 릴리스 API, 하루 한 번, 보내는 정보 없음, 끌 수 있음)뿐이며, 업데이트는 SHA-256 으로 검증하고 GitHub 도메인으로 제한합니다.
- Certificate checks are never disabled globally; self-signed certificates are trusted per host + SHA-256 fingerprint, only after the user confirms. / 인증서 검증을 전역으로 끄지 않고, 호스트 + 지문 단위로 사용자가 확인한 경우에만 신뢰합니다.
- Release zips ship with a `.sha256` file. / 릴리스 zip 에는 `.sha256` 파일이 함께 올라갑니다.
