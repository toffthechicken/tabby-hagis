import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'
import { HagisDockItem } from './models'

export interface HagisTrustedCertificate {
    host: string
    fingerprint: string
    subject?: string
    addedAt: string
}

@Injectable()
export class HagisConfigProvider extends ConfigProvider {
    defaults = {
        hagis: {
            /** 저장된 고객사별 워크스페이스 (HagisWorkspace[]) */
            workspaces: [],
            /** 컴팩트 모드 */
            compactMode: false,
            /** 컴팩트 모드에서 사용할 여백 배율 (Tabby 기본 spaciness = 1) */
            compactSpaciness: 0.5,
            /** 컴팩트 모드를 켤 때 현재 워크스페이스 터미널에 적용할 글자 크기 단계 */
            compactZoom: -2,
            /** 터미널 패널의 글자 크기 컨트롤 표시 (네임태그 옆, 마우스를 올리면 표시) */
            paneControls: true,
            /** 분할 화면의 각 패널 좌측 상단 네임태그 표시 */
            paneTags: true,
            /** 가로·세로 경계가 만나는 모서리 핸들로 두 방향 동시 크기 조절 */
            cornerHandles: true,
            /** 패널 사이 경계선 — 어느 패널이 어디까지인지 구분하기 쉽게 (기본: 끔) */
            paneBorders: {
                enabled: false,
                /** #rrggbb */
                color: '#c6ff00',
                /** px (1~6) */
                width: 1,
                /** 선 진하기 % (20~100) — 낮을수록 은은하다 */
                alpha: 55,
            },
            /**
             * 터미널 이어가기 — Tabby를 껐다 켜거나 워크스페이스를 다시 열 때,
             * 그 패널에서 실행 중이던 AI CLI 를 이어가기 명령으로 다시 실행한다.
             * (프로세스 자체는 앱 종료와 함께 끝나므로, 각 CLI의 "이전 대화 이어가기" 기능을 쓴다)
             */
            resume: {
                enabled: true,
                /** 한 줄에 하나: 프로세스 이름(또는 명령줄에 포함된 단어) = 다시 실행할 명령 */
                rules: 'claude = claude --continue\nagy = agy --continue\ncodex = codex resume --last',
            },
            /** 화면 옆 실행 막대 (자주 쓰는 프로그램·프로필·워크스페이스) */
            dock: {
                enabled: true,
                /** 'left' | 'right' */
                side: 'left',
                /** 마우스를 올리면 아이콘이 커지는 효과 */
                magnify: true,
                /** 접어 두기 — 얇은 손잡이만 남는다 */
                collapsed: false,
                /** 자동 숨기기 (macOS 방식) — 가장자리에 마우스를 대면 화면 위로 나온다. 끄면 늘 자리를 차지하고 보인다 */
                autoHide: false,
                items: [] as HagisDockItem[],
            },
            /** 업데이트 확인 — GitHub 릴리스를 하루 한 번 본다 */
            update: {
                /** 'ask' 새 버전이 있으면 물어보기 | 'auto' 자동으로 설치(재시작은 직접) | 'off' 확인하지 않음 */
                mode: 'ask' as 'ask' | 'auto' | 'off',
                lastCheck: 0,
                /** "이 버전은 건너뛰기" 로 정한 버전 */
                skipVersion: '',
            },
            preview: {
                /**
                 * 메인 무대 미리보기(웹) 캡처 주기 (초)
                 * 미리보기는 실제 화면을 숨겨 두고(CPU·GPU 절약) 이 주기로 찍은 캡처를 보여 준다
                 */
                refreshSeconds: 10,
            },
            web: {
                /** http:// 또는 스킴 없는 주소는 https:// 를 먼저 시도하고 실패하면 http:// 로 (Chrome과 동일) */
                httpsFirst: true,
                /** 사용자가 직접 신뢰한 자체 서명 인증서 (호스트 + SHA-256 지문) */
                trustedCertificates: [] as HagisTrustedCertificate[],
                /**
                 * "새 탭으로 열기" 링크(target=_blank 등)를 어디에 열지
                 * 'pane' = 옆에 새 패널(이름표가 하나 더 생긴다) | 'same' = 이 패널에서
                 */
                newTabLinks: 'pane' as 'pane' | 'same',
            },
        },
    }
}
