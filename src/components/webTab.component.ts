import { Component, ElementRef, Injector, NgZone, ViewChild, AfterViewInit, OnDestroy, OnInit } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, GetRecoveryTokenOptions, NotificationsService, PlatformService, RecoveryToken, SplitTabComponent, TabsService } from 'tabby-core'
import { HagisCapturePrompt, HagisCertificateProblem, HagisPermissionPrompt, HagisWebService, HAGIS_KEY_EVENT, HAGIS_LOGIN_EVENT, HAGIS_OPEN_IN_PLACE, HAGIS_PERMISSION_LABELS, HAGIS_WEB_PARTITION } from '../services/web.service'
import { HAGIS_OPENER_SHIM, HAGIS_RELAY_PREFIX, HagisScriptOpenMode, scriptOpenShim, targetOriginMatches } from '../services/openShim'
import { HagisBrowserDataService } from '../services/browserData.service'
import { HagisDownload, HagisDownloadService } from '../services/download.service'
import { HagisViewerService } from '../services/viewer.service'
import { HagisPaneService } from '../services/pane.service'
import { HagisStageService } from '../services/stage.service'
import { HagisViewSyncContext, HagisViewSyncService, rectsOverlap } from '../services/viewSync.service'
import { HagisStageRole } from '../models'
import { HAGIS_SEARCH_ENGINES } from '../services/address'

/** 새 패널이 열어 준 페이지의 sessionStorage 를 심어 두는 시간 — 이 안에 열리는 문서에 적용된다 */
const SEED_WINDOW_MS = 12000
/** 중계 패널이 열어 준 페이지와 메시지를 주고받는 간격 */
const RELAY_POLL_MS = 250
/** https 시도가 이 시간 안에 응답하지 않으면 http 로 넘어간다 (443 포트가 막힌 장비) */
const HTTPS_FALLBACK_TIMEOUT = 6000
/** 미리보기 실제 화면을 잠깐 띄워 새 크기로 그리게 하는 시간 */
const LIVE_REFRESH_MS = 450

/**
 * 웹 GUI 패널 (방화벽·스위치 관리 페이지)
 *
 * Electron WebContentsView를 Tabby 창 위에 올리고 이 패널의 화면 영역에 맞춘다 (HagisViewSyncService).
 * 분할 패널과 같은 방식으로 배치·크기 조절·저장·복원된다.
 *
 * 메인 무대의 미리보기는 "절전 모드"로 동작한다 —
 * 실제 웹 화면은 숨겨 두고(Chromium 이 숨은 페이지의 그리기·애니메이션·타이머를 멈춘다)
 * 몇 초마다 찍은 캡처를 보여 준다. 클릭하면 메인으로 올라가 바로 실시간 화면이 된다.
 */
@Component({
    selector: 'hagis-web-tab',
    template: `
<div class="hagis-web-bar">
    <span class="hagis-tag-slot"></span>
    <button class="btn btn-sm btn-link" (click)="goBack()" [disabled]="!canGoBack" title="뒤로"><i class="fas fa-arrow-left"></i></button>
    <button class="btn btn-sm btn-link" (click)="goForward()" [disabled]="!canGoForward" title="앞으로"><i class="fas fa-arrow-right"></i></button>
    <button class="btn btn-sm btn-link" (click)="loading ? stop() : reload()" [title]="loading ? '중지' : '새로고침'">
        <i class="fas" [class.fa-redo]="!loading" [class.fa-times]="loading"></i>
    </button>
    <div class="hagis-web-addrwrap">
        <input
            #addressInput
            class="form-control form-control-sm hagis-web-address"
            [(ngModel)]="address"
            (input)="onAddressInput($any($event.target).value)"
            (keydown)="onAddressKey($event)"
            (focus)="selectAll($event)"
            (blur)="onAddressBlur()"
            placeholder="주소 또는 검색어 (예: 192.168.1.99)"
            spellcheck="false"
            autocomplete="off"
        >
        <div class="hagis-web-suggest" *ngIf="suggestReady">
            <div class="hagis-web-suggest-row" *ngFor="let row of suggestRows; let i = index"
                [class.active]="i === suggestIndex"
                (mousedown)="pickSuggestion(row, $event)" (mousemove)="suggestIndex = i" [title]="row.url">
                <i class="fas" [ngClass]="row.icon"></i>
                <span class="hagis-web-suggest-title">{{ row.title }}</span>
                <span class="hagis-web-suggest-sub">{{ row.sub }}</span>
            </div>
        </div>
    </div>
    <button class="btn btn-sm btn-link" (click)="changeZoom(-0.1)" title="축소"><i class="fas fa-search-minus"></i></button>
    <span class="hagis-web-zoom" (click)="resetZoom()" title="100%로">{{ zoomPercent }}%</span>
    <button class="btn btn-sm btn-link" (click)="changeZoom(0.1)" title="확대"><i class="fas fa-search-plus"></i></button>
    <button class="btn btn-sm btn-link" (click)="openExternal()" [disabled]="!currentUrl" title="기본 브라우저로 열기"><i class="fas fa-external-link-alt"></i></button>
    <div class="hagis-dl-wrap" *ngIf="paneDownloads.length">
        <button class="btn btn-sm btn-link hagis-dl-btn" (click)="toggleDownloads()" [title]="downloadTitle" [class.hagis-dl-open]="downloadsOpen">
            <svg width="20" height="20" viewBox="0 0 20 20" [class.hagis-dl-done]="!dlActive" [class.hagis-dl-fail]="dlFailed">
                <circle cx="10" cy="10" r="8" class="hagis-dl-track"></circle>
                <circle cx="10" cy="10" r="8" class="hagis-dl-ring" [class.hagis-dl-spin]="dlActive && dlProgress < 0"
                    [attr.stroke-dasharray]="dlDash" transform="rotate(-90 10 10)"></circle>
                <path d="M10 5.5v6.2m0 0l-2.6-2.6m2.6 2.6l2.6-2.6M6.5 14.2h7" class="hagis-dl-arrow"></path>
            </svg>
        </button>
        <div class="hagis-dl-pop" *ngIf="downloadsOpen && (coverShot || !lastShown || isPreview)">
            <div class="hagis-dl-head">
                <b>다운로드</b>
                <button class="btn btn-sm btn-link" (click)="downloads.clearFinished()" title="끝난 항목을 목록에서 지우기">끝난 항목 지우기</button>
            </div>
            <div class="hagis-dl-item" *ngFor="let d of paneDownloads">
                <i class="fas hagis-dl-icon" [ngClass]="fileIcon(d)"></i>
                <div class="hagis-dl-info">
                    <div class="hagis-dl-name" [title]="d.path || d.name">{{ d.name }}</div>
                    <div class="hagis-dl-track-bar" *ngIf="isActive(d)"><div [class.hagis-dl-indet]="d.total <= 0" [style.width.%]="d.total > 0 ? percentOf(d) : 100"></div></div>
                    <div class="hagis-dl-sub" [class.text-danger]="d.state === 'interrupted'">{{ statusText(d) }}</div>
                </div>
                <div class="hagis-dl-actions">
                    <button class="btn btn-sm btn-link" *ngIf="isActive(d)" (click)="downloads.togglePause(d)" [title]="d.state === 'paused' ? '계속' : '일시정지'"><i class="fas" [class.fa-pause]="d.state === 'progressing'" [class.fa-play]="d.state === 'paused'"></i></button>
                    <button class="btn btn-sm btn-link" *ngIf="isActive(d)" (click)="downloads.cancel(d)" title="취소"><i class="fas fa-times"></i></button>
                    <button class="btn btn-sm btn-link" *ngIf="canView(d)" (click)="openInViewer(d)" title="hagis 문서 뷰어로 열기"><i class="fas fa-file-alt"></i></button>
                    <button class="btn btn-sm btn-link" *ngIf="downloads.canOpen(d)" (click)="downloads.open(d)" title="기본 프로그램으로 열기"><i class="fas fa-external-link-alt"></i></button>
                    <button class="btn btn-sm btn-link" *ngIf="d.path && !isActive(d)" (click)="downloads.showInFolder(d)" title="폴더에서 보기"><i class="fas fa-folder-open"></i></button>
                    <button class="btn btn-sm btn-link" *ngIf="!isActive(d)" (click)="downloads.remove(d)" title="목록에서 지우기"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        </div>
    </div>
</div>

<div class="hagis-web-find" *ngIf="findOpen">
    <input #findInput class="form-control form-control-sm" [(ngModel)]="findText" (input)="runFind(true)" (keydown)="onFindKey($event)" placeholder="페이지에서 찾기" spellcheck="false" autocomplete="off">
    <span class="hagis-web-find-count">{{ findCount }}</span>
    <button class="btn btn-sm btn-link" (click)="runFind(false, false)" title="이전 (Shift+Enter)"><i class="fas fa-chevron-up"></i></button>
    <button class="btn btn-sm btn-link" (click)="runFind(false, true)" title="다음 (Enter)"><i class="fas fa-chevron-down"></i></button>
    <button class="btn btn-sm btn-link" (click)="closeFind()" title="닫기 (Esc)"><i class="fas fa-times"></i></button>
</div>

<div class="hagis-web-cert hagis-web-perm" *ngIf="permPrompt" [class.hagis-web-cert-compact]="hagisStage === 'preview'">
    <div class="hagis-web-cert-title"><i class="fas fa-shield-alt"></i> {{ permPrompt.origin }} 이(가) {{ permLabel(permPrompt) }} 사용을 요청합니다</div>
    <div class="hagis-web-cert-actions">
        <button class="btn btn-sm btn-info" (click)="answerPermission(true, true)" title="이 사이트에서 항상 허용 (설정에서 취소할 수 있습니다)">허용</button>
        <button class="btn btn-sm btn-secondary" (click)="answerPermission(true, false)">이번만 허용</button>
        <button class="btn btn-sm btn-secondary" (click)="answerPermission(false, true)" title="이 사이트에서 항상 차단">차단</button>
        <button class="btn btn-sm btn-link" (click)="answerPermission(false, false)">닫기</button>
    </div>
</div>

<div class="hagis-web-cert hagis-web-capture" *ngIf="capturePrompt" [class.hagis-web-cert-compact]="hagisStage === 'preview'">
    <div class="hagis-web-cert-title"><i class="fas fa-desktop"></i> {{ capturePrompt.origin }} 에 공유할 화면 또는 창을 고르세요</div>
    <div class="hagis-capture-list" *ngIf="hagisStage !== 'preview'">
        <button class="hagis-capture-item" *ngFor="let src of capturePrompt.sources" (click)="chooseCapture(src.id)" [title]="src.name">
            <img [src]="src.thumbnail" alt="">
            <span><i class="fas" [ngClass]="src.isScreen ? 'fa-desktop' : 'fa-window-maximize'"></i> {{ src.name }}</span>
        </button>
    </div>
    <div class="hagis-web-cert-actions">
        <button class="btn btn-sm btn-info" *ngIf="hagisStage === 'preview'" (click)="promoteSelf()">메인에서 선택</button>
        <label class="hagis-capture-audio" *ngIf="capturePrompt.audio && hagisStage !== 'preview'"><input type="checkbox" [(ngModel)]="captureAudio"> 시스템 소리도 공유</label>
        <button class="btn btn-sm btn-secondary" (click)="chooseCapture(null)">취소</button>
    </div>
</div>

<div class="hagis-web-cert hagis-web-auth" *ngIf="authRequest" [class.hagis-web-cert-compact]="hagisStage === 'preview'">
    <div class="hagis-web-cert-title"><i class="fas fa-lock"></i> 로그인 필요 — {{ authRequest.host }}{{ authRequest.port ? ':' + authRequest.port : '' }}</div>
    <div class="hagis-web-cert-detail">
        <div>{{ authRequest.isProxy ? '프록시 서버' : '이 사이트' }}가 사용자 이름과 비밀번호를 요구합니다{{ authRequest.realm ? ' — ' + authRequest.realm : '' }}</div>
        <div class="text-danger" *ngIf="authRequest.retry">아이디 또는 비밀번호가 맞지 않습니다. 다시 입력하세요.</div>
        <div class="text-warning" *ngIf="authInsecure">암호화되지 않은 연결(HTTP)이라 입력한 비밀번호가 네트워크에 그대로 실릴 수 있습니다.</div>
    </div>
    <div class="hagis-web-cert-actions" *ngIf="hagisStage !== 'preview'">
        <input #authUser class="form-control form-control-sm hagis-auth-input" [(ngModel)]="authUsername" (keydown.enter)="submitAuth()" (keydown.escape)="cancelAuth()" placeholder="사용자 이름" spellcheck="false" autocomplete="off">
        <input class="form-control form-control-sm hagis-auth-input" type="password" [(ngModel)]="authPassword" (keydown.enter)="submitAuth()" (keydown.escape)="cancelAuth()" placeholder="비밀번호" autocomplete="off">
        <button class="btn btn-sm btn-info" (click)="submitAuth()">로그인</button>
        <button class="btn btn-sm btn-secondary" (click)="cancelAuth()">취소</button>
    </div>
    <div class="hagis-web-cert-actions" *ngIf="hagisStage === 'preview'">
        <button class="btn btn-sm btn-info" (click)="promoteSelf()" title="메인 화면으로 올려 로그인">메인에서 로그인</button>
        <button class="btn btn-sm btn-secondary" (click)="cancelAuth()">취소</button>
    </div>
</div>

<div class="hagis-web-cert" *ngIf="certProblem" [class.hagis-web-cert-compact]="hagisStage === 'preview'">
    <div class="hagis-web-cert-title"><i class="fas fa-exclamation-triangle"></i> 인증서를 확인할 수 없습니다 — {{ certProblem.host }}</div>
    <div class="hagis-web-cert-detail" [title]="'지문: ' + certProblem.fingerprint">
        <div>오류: {{ certProblem.verificationResult }}</div>
        <div>주체: {{ certProblem.subject || '-' }} / 발급자: {{ certProblem.issuer || '-' }}</div>
        <div>지문: <code>{{ certProblem.fingerprint }}</code></div>
    </div>
    <div class="hagis-web-cert-actions">
        <button class="btn btn-sm btn-info" *ngIf="hagisStage === 'preview'" (click)="promoteSelf()" title="메인 화면으로 올려 지문을 확인하고 처리">메인에서 확인</button>
        <button class="btn btn-sm btn-warning" (click)="trustCertificate()" title="이 호스트의 이 인증서만 신뢰">신뢰</button>
        <button class="btn btn-sm btn-secondary" *ngIf="pendingFallback" (click)="useFallback()">HTTP로 열기</button>
        <button class="btn btn-sm btn-secondary" (click)="dismissCertificate()">신뢰하지 않음</button>
    </div>
    <div class="hagis-web-cert-hint">
        IP로 접속하면 정상 인증서도 이름이 맞지 않아 이 경고가 납니다. 지문을 확인한 뒤 신뢰하세요.
        신뢰 목록은 설정 → hagis 에서 삭제할 수 있습니다.
    </div>
</div>

<div class="hagis-web-notice" *ngIf="httpNotice">
    <i class="fas fa-exclamation-circle"></i>
    <span>{{ httpNotice }}</span>
    <button class="btn btn-sm btn-link" (click)="dismissHttpNotice()" title="닫기"><i class="fas fa-times"></i></button>
</div>

<div class="hagis-web-viewport" #viewport [class.hagis-web-previewing]="isPreview" (mousedown)="onViewportMouseDown($event)">
    <img class="hagis-web-snapshot" *ngIf="coverShot || (isPreview && snapshot)" [src]="coverShot || snapshot" draggable="false" alt="">
    <div class="hagis-web-preview-wait" *ngIf="isPreview && !snapshot && !connecting && !certProblem"><span>미리보기 준비 중…</span></div>
    <div class="hagis-web-promote-hint" *ngIf="isPreview"><span>클릭 → 메인으로</span></div>
    <div class="hagis-web-placeholder" *ngIf="!currentUrl || lastError || connecting">
        <div class="hagis-brand">hagis <span>by tabby</span></div>
        <div *ngIf="!currentUrl">위 주소창에 장비 관리 페이지 주소를 입력하세요.</div>
        <div *ngIf="connecting && !lastError" class="text-muted">{{ connecting }}</div>
        <div *ngIf="lastError" class="text-danger">{{ lastError }}</div>
    </div>
</div>
`,
    styles: [`
:host { display: flex; flex-direction: column; flex: auto; min-height: 0; overflow: hidden; }
.hagis-web-bar { display: flex; align-items: center; gap: 2px; padding: 3px 4px; flex: none; background: rgba(0,0,0,.2); min-width: 0; }
.hagis-web-bar .btn { padding: 2px 6px; }
.hagis-web-addrwrap { position: relative; flex: auto; min-width: 40px; display: flex; }
.hagis-web-address { flex: auto; min-width: 40px; height: 26px; font-size: 12px; }
.hagis-web-suggest {
    position: absolute; left: 0; right: 0; top: calc(100% + 2px); min-width: 280px; max-height: min(60vh, 340px); overflow-y: auto; z-index: 50;
    background: var(--theme-bg-more-2, #1f2227); border: 1px solid rgba(255, 255, 255, .18); border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .5); padding: 3px 0; font-size: 12px;
}
.hagis-web-suggest-row { display: flex; align-items: center; gap: 8px; padding: 4px 10px; cursor: pointer; min-width: 0; }
.hagis-web-suggest-row.active { background: rgba(198, 255, 0, .16); }
.hagis-web-suggest-row > i { flex: none; width: 14px; text-align: center; opacity: .75; font-size: 11px; }
.hagis-web-suggest-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hagis-web-suggest-sub { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .55; font-size: 11px; text-align: right; }
.hagis-web-zoom { font-size: 11px; opacity: .7; cursor: pointer; min-width: 36px; text-align: center; }
.hagis-dl-wrap { position: relative; flex: none; display: flex; }
.hagis-dl-btn { padding: 1px 4px !important; line-height: 1; }
.hagis-dl-btn svg { display: block; }
.hagis-dl-track { fill: none; stroke: rgba(255, 255, 255, .22); stroke-width: 2; }
.hagis-dl-ring { fill: none; stroke: #c6ff00; stroke-width: 2.2; stroke-linecap: round; transform-origin: 10px 10px; }
.hagis-dl-arrow { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.hagis-dl-done .hagis-dl-ring { stroke: #4cd964; }
.hagis-dl-fail .hagis-dl-ring { stroke: #ff5f5f; }
.hagis-dl-spin { animation: hagis-dl-rot 1s linear infinite; }
@keyframes hagis-dl-rot { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.hagis-dl-open { background: rgba(255, 255, 255, .12); border-radius: 50%; }
.hagis-dl-pop {
    position: absolute; right: 0; top: calc(100% + 4px); width: 340px; max-width: 94vw; max-height: min(60vh, 380px); overflow-y: auto; z-index: 60;
    background: var(--theme-bg-more-2, #1f2227); border: 1px solid rgba(255, 255, 255, .18); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .5); font-size: 12px;
}
.hagis-dl-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; border-bottom: 1px solid rgba(255, 255, 255, .1); }
.hagis-dl-head .btn { font-size: 11px; padding: 0 4px; }
.hagis-dl-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.hagis-dl-item + .hagis-dl-item { border-top: 1px solid rgba(255, 255, 255, .06); }
.hagis-dl-icon { flex: none; width: 18px; text-align: center; opacity: .8; }
.hagis-dl-info { flex: auto; min-width: 0; }
.hagis-dl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hagis-dl-sub { font-size: 11px; opacity: .6; }
.hagis-dl-track-bar { height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .15); margin: 3px 0; overflow: hidden; }
.hagis-dl-track-bar > div { height: 100%; background: #c6ff00; }
.hagis-dl-indet { animation: hagis-dl-slide 1.2s ease-in-out infinite; transform-origin: left; }
@keyframes hagis-dl-slide { 0% { transform: scaleX(.1) translateX(0); } 50% { transform: scaleX(.4) translateX(80%); } 100% { transform: scaleX(.1) translateX(900%); } }
.hagis-dl-actions { flex: none; display: flex; }
.hagis-dl-actions .btn { padding: 2px 5px; }
.hagis-web-viewport { flex: auto; position: relative; min-height: 0; overflow: hidden; }
.hagis-web-previewing { cursor: pointer; }
.hagis-web-snapshot { position: absolute; left: 0; top: 0; width: 100%; height: auto; display: block; user-select: none; pointer-events: none; }
/* 미리보기 안내 글자는 패널 크기에 비례해 줄어든다 (cqw/cqh = 이 오버레이 크기의 %) */
.hagis-web-preview-wait { position: absolute; inset: 0; container-type: size; display: flex; align-items: center; justify-content: center; opacity: .6; pointer-events: none; }
.hagis-web-preview-wait > span { font-size: clamp(6px, min(4cqw, 10cqh), 12px); white-space: nowrap; }
.hagis-web-promote-hint {
    position: absolute; inset: 0; container-type: size; display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .12s; pointer-events: none;
}
.hagis-web-promote-hint > span {
    padding: .25em .8em; border-radius: .35em; border: 1px solid #c6ff00; background: rgba(0, 0, 0, .75);
    color: #c6ff00; font-family: system-ui, sans-serif; font-weight: 700; line-height: 1.5; white-space: nowrap;
    font-size: clamp(6px, min(4cqw, 9cqh), 13px);
}
.hagis-web-previewing:hover { box-shadow: inset 0 0 0 1px rgba(198, 255, 0, .6); }
.hagis-web-previewing:hover .hagis-web-promote-hint { opacity: 1; }
.hagis-web-notice {
    flex: none; display: flex; align-items: flex-start; gap: 6px; padding: 5px 8px; font-size: 12px; line-height: 1.45;
    background: rgba(255, 95, 95, .12); border-bottom: 1px solid rgba(255, 95, 95, .4);
}
.hagis-web-notice > i { margin-top: 3px; color: #ff6b6b; }
.hagis-web-notice > span { flex: auto; }
.hagis-web-notice .btn { padding: 0 4px; }
.hagis-web-placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; opacity: .8; padding: 16px; text-align: center; }
.hagis-web-placeholder .text-danger { max-width: 620px; line-height: 1.5; }
.hagis-brand { font-size: 22px; font-weight: 600; letter-spacing: .5px; }
.hagis-brand span { font-size: 13px; font-weight: 400; opacity: .6; }
/* 작은 미리보기 칸: 세부 내용은 접고 버튼이 항상 보이게 (넘치면 스크롤) */
.hagis-web-cert { overflow: auto; flex: 0 1 auto; min-height: 0; }
.hagis-web-cert-compact { padding: 4px 6px !important; font-size: 11px !important; }
.hagis-web-cert-compact .hagis-web-cert-title { margin-bottom: 2px; word-break: break-all; }
.hagis-web-cert-compact .hagis-web-cert-detail, .hagis-web-cert-compact .hagis-web-cert-hint { display: none; }
.hagis-web-cert-compact .hagis-web-cert-actions { margin: 2px 0 0; gap: 3px; }
.hagis-web-cert-compact .btn { padding: 1px 6px; font-size: 11px; }
.hagis-web-cert { padding: 8px 10px; background: rgba(255, 170, 0, .12); border-bottom: 1px solid rgba(255, 170, 0, .4); font-size: 12px; }
.hagis-web-cert-title { font-weight: 600; margin-bottom: 4px; }
.hagis-web-cert-detail code { word-break: break-all; }
.hagis-web-cert-actions { margin: 6px 0 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.hagis-web-cert-hint { opacity: .7; }
.hagis-capture-list { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0 6px; }
.hagis-capture-item { flex: none; width: 168px; padding: 4px; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; background: rgba(0,0,0,.25); color: inherit; text-align: left; cursor: pointer; }
.hagis-capture-item:hover { border-color: #c6ff00; background: rgba(198,255,0,.1); }
.hagis-capture-item img { display: block; width: 100%; height: 96px; object-fit: contain; background: #000; border-radius: 3px; }
.hagis-capture-item span { display: block; margin-top: 3px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hagis-capture-audio { display: flex; align-items: center; gap: 4px; margin: 0 8px 0 0; font-size: 12px; }
.hagis-auth-input { width: 170px; flex: 0 1 170px; min-width: 90px; }
.hagis-web-find { display: flex; align-items: center; gap: 2px; padding: 3px 6px; flex: none; background: rgba(0,0,0,.3); border-bottom: 1px solid rgba(255,255,255,.1); }
.hagis-web-find input { width: 240px; max-width: 50%; height: 24px; font-size: 12px; }
.hagis-web-find .btn { padding: 1px 6px; }
.hagis-web-find-count { font-size: 11px; opacity: .65; min-width: 50px; padding: 0 4px; }
`],
})
export class HagisWebTabComponent extends BaseTabComponent implements OnInit, AfterViewInit, OnDestroy {
    /** 처음 열 주소 (입력값) */
    url = ''
    /**
     * 새 탭 요청으로 열린 패널이 이어받을 세션 정보 — 열어 준 페이지의 sessionStorage·window.name.
     * 브라우저는 새 창을 열 때 sessionStorage 를 복사해 주는데, 주소만 따로 여는 패널은 비어 있어
     * 로그인 토큰을 sessionStorage 에 두는 사이트(원격 콘솔 등)가 흰 화면이 된다.
     */
    seedSession: { origin: string, name: string, storage: Record<string, string> }|null = null
    /** 스크립트의 window.open 으로 열린 패널이면 열어 준 패널과 중계 번호 (설정 '패널로 열고 중계') */
    relayHost: HagisWebTabComponent|null = null
    relayId = ''
    /** 고정 이름 — 지정되면 페이지 제목 대신 표시 */
    paneTitle = ''
    zoomFactor = 1
    /** 메인 무대 역할 (입력값 — 탭 복원·워크스페이스에서 넘어온다) */
    hagisStage?: HagisStageRole

    address = ''
    currentUrl = ''
    loading = false
    canGoBack = false
    canGoForward = false
    lastError = ''
    /** "https://… 연결 중" 안내 */
    connecting = ''
    certProblem: HagisCertificateProblem|null = null
    /** https 실패 시 시도할 http 주소 */
    pendingFallback: string|null = null
    /** 미리보기 캡처 (data URL) */
    snapshot = ''
    /** HTTP 오류 응답 안내 (내용이 있는 오류 페이지일 때 위에 띠로 보여 준다) */
    httpNotice = ''
    /**
     * 독(자동 숨기기)이 화면 위로 나와 있는 동안 보여 줄 캡처 —
     * 네이티브 웹 화면은 Tabby 화면보다 위에 그려져 독을 가리므로 그동안 그림으로 바꿔 둔다
     */
    coverShot = ''
    /** 주소창 자동완성 목록 (입력 중에만 — 네이티브 웹 화면이 위에 그려지므로 열려 있는 동안 캡처 그림으로 바꿔 둔다) */
    suggestRows: HagisSuggestRow[] = []
    suggestIndex = -1
    suggestOpen = false
    private suggestBlurTimer: any = null
    /** 다운로드 목록 팝업 */
    downloadsOpen = false
    /** 이 패널 웹 페이지의 webContents 번호 — 어느 패널에서 받은 파일인지 가린다 */
    private wcId = 0

    /** 목록을 보여도 되는 때 — 웹 화면이 캡처 그림으로 바뀐 뒤에(안 그러면 목록이 웹 화면 아래에 가려진다) */
    get suggestReady (): boolean {
        return this.suggestOpen && this.suggestRows.length > 0 && (!!this.coverShot || !this.lastShown || this.isPreview)
    }

    /** 이 패널의 다운로드 */
    get paneDownloads (): HagisDownload[] {
        return this.downloads.forPane(this.wcId, knownWcIds)
    }

    get dlActive (): boolean {
        return this.downloads.active(this.paneDownloads).length > 0
    }

    get dlFailed (): boolean {
        const list = this.paneDownloads
        return !this.dlActive && list.length > 0 && list[0].state === 'interrupted'
    }

    /** 진행률 0~1, 크기를 모르면 -1 */
    get dlProgress (): number {
        return this.downloads.progress(this.paneDownloads)
    }

    /** 원형 진행 표시 (둘레 = 2π·8 ≈ 50.3) */
    get dlDash (): string {
        const circumference = 2 * Math.PI * 8
        const progress = this.dlProgress
        return progress < 0 ? `${circumference * 0.28} ${circumference}` : `${circumference * progress} ${circumference}`
    }

    get downloadTitle (): string {
        const list = this.paneDownloads
        const active = this.downloads.active(list)
        return active.length ? `다운로드 중 ${active.length}개` : `다운로드 ${list.length}개`
    }

    @ViewChild('viewport') viewport: ElementRef<HTMLElement>
    @ViewChild('addressInput') addressInput?: ElementRef<HTMLInputElement>
    @ViewChild('findInput') findInput?: ElementRef<HTMLInputElement>
    @ViewChild('authUser') authUser?: ElementRef<HTMLInputElement>

    // ---- 페이지에서 찾기 (Ctrl+F)
    findOpen = false
    findText = ''
    findCount = ''
    private findRequestId = 0

    // ---- 사이트 권한 (마이크·카메라·위치·알림) · 화면 공유
    permPrompts: HagisPermissionPrompt[] = []
    capturePrompt: HagisCapturePrompt|null = null
    captureAudio = false

    get permPrompt (): HagisPermissionPrompt|null {
        return this.permPrompts[0] ?? null
    }

    permLabel (prompt: HagisPermissionPrompt): string {
        return prompt.keys.map(k => HAGIS_PERMISSION_LABELS[k] ?? k).join('·')
    }

    // ---- HTTP 인증 (장비 웹 GUI 의 기본 인증 로그인)
    authRequest: HagisAuthRequest|null = null
    authQueue: HagisAuthRequest[] = []
    authUsername = ''
    authPassword = ''

    /** 지금 연 주소가 http:// 인가 (비밀번호가 암호화 없이 실린다) */
    get authInsecure (): boolean {
        return /^http:/i.test(this.currentUrl || this.web.normalizeUrl(this.address))
    }

    private view: any = null
    /** 메인 프로세스의 webContents (remote 객체 — 매번 view.webContents 로 꺼내면 그때마다 동기 IPC) */
    private wc: any = null
    private listeners: [string, (...args: any[]) => void][] = []
    private unregisterSync: (() => void)|null = null
    private isVisible = false
    private dragging = false
    private lastShown: boolean|null = null
    private lastBounds = ''
    private lastBoundsSize: { width: number, height: number }|null = null
    private destroyedFlag = false
    private fallbackTimer: any = null
    private hostElement: HTMLElement
    /** 실제로 적용한 페이지 배율 (사용자가 정한 배율) */
    private appliedZoom: number|null = null
    /** 미리보기 축소 설정 ('' = 없음, '?' = 다시 적용 필요) */
    private emulation = ''
    private lastScaleCheck = 0
    /** 미리보기 실제 화면을 잠깐 띄워 두는 중 (새 크기로 그리기·첫 캡처) */
    private liveRefresh = false
    private refreshBusy = false
    private liveRefreshTimer: any = null
    private snapshotTimer: any = null
    /** 마지막 문서의 HTTP 상태 코드 */
    private httpStatus = 0
    private httpStatusText = ''
    /** 독 같은 Tabby 화면이 이 패널 위로 올라와 있음 */
    private covered = false
    private coverBusy = false
    private coverClearTimer: any = null

    get zoomPercent (): number { return Math.round(this.zoomFactor * 100) }

    /** 보기 전용 미리보기 — 주소가 비었거나 열지 못했으면 주소를 입력할 수 있게 일반 모드로 둔다 */
    get isPreview (): boolean {
        return this.hagisStage === 'preview' && !!this.currentUrl && !this.lastError
    }

    /** 미리보기 캡처 주기 (초) */
    private get refreshSeconds (): number {
        const value = Number(this.hagisConfig.store?.hagis?.preview?.refreshSeconds ?? 10)
        return value > 0 ? Math.max(2, value) : 10
    }

    constructor (
        injector: Injector,
        private web: HagisWebService,
        private browserData: HagisBrowserDataService,
        public downloads: HagisDownloadService,
        private viewer: HagisViewerService,
        private panes: HagisPaneService,
        private stage: HagisStageService,
        private viewSync: HagisViewSyncService,
        private hagisConfig: ConfigService,
        private zone: NgZone,
        private platform: PlatformService,
        private app: AppService,
        private tabs: TabsService,
        private notifications: NotificationsService,
        element: ElementRef,
    ) {
        super(injector)
        this.hostElement = element.nativeElement
        this.icon = 'fas fa-globe'
    }

    ngOnInit (): void {
        this.setTitle(this.paneTitle || 'Web')
        this.subscribeUntilDestroyed(this.visibility$, visible => {
            this.isVisible = visible
            this.viewSync.kick()
            if (visible && this.isPreview) {
                this.refreshSnapshot(!this.snapshot) // 다른 탭에 있는 동안 지난 캡처를 새로 고친다
            }
        })
        this.subscribeUntilDestroyed(this.app.tabDragActive$, t => this.dragging = !!t)
        this.subscribeUntilDestroyed(this.panes.paneDrag$, t => this.dragging = !!t)
        this.subscribeUntilDestroyed(this.web.certificateProblem$, problem => {
            if (this.currentHost() === problem.host) {
                this.zone.run(() => {
                    this.clearFallbackTimer()
                    this.connecting = ''
                    this.lastError = ''
                    this.certProblem = problem
                })
            }
        })
        this.subscribeUntilDestroyed(this.web.certificateDecided$, ({ problem, trusted }) => {
            const waiting = this.certProblem?.host === problem.host && this.certProblem.fingerprint === problem.fingerprint
            if (!waiting) {
                return
            }
            this.zone.run(() => trusted ? this.reloadAfterTrust() : this.certProblem = null)
        })
        this.subscribeUntilDestroyed(this.web.permissionPrompt$, prompt => {
            if (prompt.wcId && prompt.wcId === this.wcId) {
                prompt.claimed = true
                this.zone.run(() => {
                    this.permPrompts.push(prompt)
                    this.viewSync.kick()
                })
            }
        })
        this.subscribeUntilDestroyed(this.web.capturePrompt$, prompt => {
            // 요청한 화면을 알아내지 못했을 때는 같은 사이트를 보여 주는 패널이 맡는다
            const mine = prompt.wcId ? prompt.wcId === this.wcId : !!this.currentUrl && this.currentUrl.startsWith(prompt.origin) && this.isVisible
            if (!mine || prompt.claimed || this.capturePrompt) {
                return
            }
            prompt.claimed = true
            this.zone.run(() => {
                this.captureAudio = false
                this.capturePrompt = prompt
                this.viewSync.kick()
            })
        })
        this.subscribeUntilDestroyed(this.stage.changed$, change => {
            if (change.tab === this) {
                this.zone.run(() => this.applyStage(change.promoted))
            }
        })
    }

    ngAfterViewInit (): void {
        try {
            this.web.ensureSession()
            this.downloads.ensureHooked()
            this.createView()
        } catch (e) {
            console.error('[hagis] web view creation failed', e)
            this.lastError = `웹 패널을 만들 수 없습니다: ${e}`
            return
        }
        if (this.url && this.viewer.isViewerUrl(this.url)) {
            // 문서 뷰어 패널 복원 — 뷰어 주소의 토큰은 hagis 를 켤 때마다 바뀌므로 원래 파일로 새 주소를 만든다
            const file = this.viewer.originalPath(this.url)
            this.address = file
            this.viewer.prepare(file)
                .then(fresh => this.zone.run(() => {
                    this.url = fresh
                    this.load(fresh, null)
                }))
                .catch(e => this.zone.run(() => {
                    this.lastError = `문서를 다시 열 수 없습니다: ${e?.message ?? e}`
                }))
        } else if (this.url) {
            this.address = this.url
            if (this.seedSession || this.relayHost) {
                // 세션 정보·가짜 opener 를 먼저 심은 뒤에 연다 — 응답이 없어도 3초 뒤에는 그냥 연다
                Promise.race([this.installSessionSeed(), new Promise(resolve => setTimeout(resolve, 3000))])
                    .catch(() => null)
                    .finally(() => {
                        this.seeding = false
                        this.address = this.url // 빈 페이지 이동이 주소창 값을 바꿔 놓았을 수 있다
                        this.navigate()
                        this.startRelay()
                    })
            } else {
                this.navigate()
            }
        }
        this.unregisterSync = this.viewSync.register(this.syncView)
    }

    private createView (): void {
        const WebContentsView = this.web.getBuiltin('WebContentsView')
        this.view = new WebContentsView({
            webPreferences: {
                partition: HAGIS_WEB_PARTITION,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webviewTag: false,
            },
        })
        this.view.setVisible(false)
        this.lastShown = false
        this.web.remote.getCurrentWindow().contentView.addChildView(this.view)

        const wc = this.wc = this.view.webContents
        try {
            this.wcId = Number(wc.id) || 0
            knownWcIds.add(this.wcId)
        } catch { }
        const on = (event: string, fn: (...args: any[]) => void) => {
            const handler = (...args: any[]) => this.zone.run(() => fn(...args))
            wc.on(event, handler)
            this.listeners.push([event, handler])
        }
        on('did-start-loading', () => {
            this.loading = true
        })
        on('did-stop-loading', () => {
            this.loading = false
            this.updateNavState()
            if (this.viewer.isViewerUrl(this.currentUrl)) {
                this.pushViewerZoom()
            }
            if (this.httpStatus >= 400) {
                this.inspectHttpError()
            }
            if (this.isPreview) {
                setTimeout(() => this.refreshSnapshot(false), 800) // 다 그려진 화면으로 캡처 갱신
            }
        })
        on('did-navigate', (_e, url, httpResponseCode, httpStatusText) => {
            this.httpStatus = Number(httpResponseCode) || 0
            this.httpStatusText = httpStatusText ?? ''
            this.httpNotice = ''
            if (this.httpStatus > 0 && this.httpStatus < 400) {
                this.lastAuthKey = '' // 로그인에 성공했으니 다음 요청은 "틀렸음" 표시 없이
            }
            this.onNavigated(url)
            // 다른 사이트로 넘어가면 렌더러가 바뀌어 배율·축소 설정이 풀릴 수 있다
            this.appliedZoom = null
            this.emulation = '?'
            this.applyStage()
        })
        on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && this.onNavigated(url))
        on('page-title-updated', (_e, title) => {
            if (!this.paneTitle) {
                this.setTitle(title)
            }
            this.browserData.recordTitle(this.currentUrl, title)
        })
        on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame || errorCode === -3) {
                return // -3 = 중지·리다이렉트
            }
            // 인증서 거부(-2)는 검증 결과 이벤트가 조금 늦게 올 수 있어 잠시 기다린 뒤 판단
            setTimeout(() => this.zone.run(() => {
                if (this.certProblem) {
                    return
                }
                if (this.pendingFallback) {
                    this.useFallback()
                    return
                }
                this.connecting = ''
                this.lastError = `${validatedURL} 를 열 수 없습니다 (${errorDescription}, ${errorCode})`
            }), 300)
        })
        on('focus', () => {
            if (this.isPreview) {
                // 미리보기를 잠깐 띄운 사이 페이지가 스스로 포커스를 가져갈 수 있다 — 키보드는 Tabby 로 돌려준다
                try {
                    this.web.remote.getCurrentWebContents().focus()
                } catch { }
                return
            }
            if (this.parent instanceof SplitTabComponent) {
                this.parent.focus(this)
            }
        })
        // 스크립트가 window.open(주소) 로 여는 창은 열어 준 창 핸들이 필요한 사이트가 많아 진짜 창으로 열도록 표시해 둔다
        on('dom-ready', () => {
            // 사이트(ChatGPT 등)가 헤더에 지정한 -webkit-app-region: drag 는 Electron 앱용이다. Tabby 창에서는 그 영역이 "창 끌기"가 되어
            // 클릭이 페이지에 전달되지 않고(좌측 상단 홈·검색 버튼) 더블클릭하면 창이 최대화/복원된다 → 웹 패널에서는 무력화한다
            Promise.resolve(wc.insertCSS('*,*::before,*::after{-webkit-app-region:no-drag !important}')).catch(() => null)
            const mode: HagisScriptOpenMode = this.hagisConfig.store?.hagis?.web?.scriptOpen ?? 'relay'
            if (mode === 'window' || mode === 'relay') {
                Promise.resolve(wc.executeJavaScript(scriptOpenShim(mode))).catch(() => null)
            }
        })
        // 새 탭으로 열리는 링크(target=_blank 등)는 팝업 창 대신 이 패널 안에서 연다 — 진짜 팝업만 창으로
        on(HAGIS_OPEN_IN_PLACE, (url: string, _disposition: string, openable: boolean, frameName?: string) => this.onNewTabRequest(url, openable, frameName ?? ''))
        try {
            this.web.attachWindowOpenHandler(wc)
        } catch (e) {
            console.warn('[hagis] window open handler failed', e)
        }
        // HTTP 인증 로그인 창
        on(HAGIS_LOGIN_EVENT, (isProxy: boolean, scheme: string, host: string, port: number, realm: string, callback: (user?: string, pass?: string) => void) => {
            this.onLoginRequest({ isProxy, scheme, host, port, realm, callback, retry: false })
        })
        try {
            this.web.attachLoginHandler(wc)
        } catch (e) {
            console.warn('[hagis] login handler failed', e)
        }
        // 브라우저 단축키 (찾기·인쇄·뒤로·새로고침·확대·개발자 도구)
        on(HAGIS_KEY_EVENT, (command: string) => this.onShortcut(command))
        try {
            this.web.attachKeyHandler(wc)
        } catch (e) {
            console.warn('[hagis] key handler failed', e)
        }
        on('found-in-page', (_e, result: any) => {
            if (result && typeof result.matches === 'number') {
                this.findCount = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : '없음'
            }
        })
        on('context-menu', (_e, params: any) => this.showContextMenu(params))
        // Ctrl+휠 확대·축소
        on('zoom-changed', (_e, direction: string) => this.changeZoom(direction === 'in' ? 0.1 : -0.1))
        this.applyZoom()
    }

    // ---------------------------------------------------------------- 사이트 권한·화면 공유

    answerPermission (allow: boolean, remember: boolean): void {
        const prompt = this.permPrompts.shift()
        if (prompt) {
            prompt.answer(allow, remember)
        }
        this.viewSync.kick()
    }

    chooseCapture (sourceId: string|null): void {
        const prompt = this.capturePrompt
        this.capturePrompt = null
        prompt?.choose(sourceId, this.captureAudio)
        this.viewSync.kick()
    }

    /** 닫힐 때 답을 기다리는 요청은 거부로 돌려준다 */
    private cancelAllPrompts (): void {
        for (const prompt of this.permPrompts) {
            try { prompt.answer(false, false) } catch { }
        }
        this.permPrompts = []
        try { this.capturePrompt?.choose(null, false) } catch { }
        this.capturePrompt = null
    }

    // ---------------------------------------------------------------- HTTP 인증

    private lastAuthKey = ''

    /** 장비·사이트가 HTTP 인증(로그인)을 요구했다 → 입력 줄을 띄운다 (여러 개가 겹치면 순서대로) */
    private onLoginRequest (request: HagisAuthRequest): void {
        if (this.destroyedFlag) {
            try { request.callback() } catch { }
            return
        }
        request.retry = this.lastAuthKey === `${request.host}:${request.port}|${request.realm}`
        // 로그인을 기다리는 동안 https→http 자동 전환이 끼어들어 로그인을 끊지 않게 한다
        this.clearFallbackTimer()
        this.connecting = ''
        this.lastError = ''
        if (this.authRequest) {
            this.authQueue.push(request)
            return
        }
        this.showAuth(request)
    }

    private showAuth (request: HagisAuthRequest): void {
        this.authRequest = request
        this.authUsername = ''
        this.authPassword = ''
        this.viewSync.kick()
        if (this.hagisStage !== 'preview') {
            try {
                this.web.remote.getCurrentWebContents().focus() // 키보드를 웹 화면에서 Tabby 로 가져온다
            } catch { }
            setTimeout(() => this.authUser?.nativeElement.focus(), 50)
        }
    }

    private nextAuth (): void {
        this.authRequest = null
        const next = this.authQueue.shift()
        if (next) {
            this.showAuth(next)
        }
        this.viewSync.kick()
    }

    submitAuth (): void {
        const request = this.authRequest
        if (!request) {
            return
        }
        this.lastAuthKey = `${request.host}:${request.port}|${request.realm}`
        const username = this.authUsername
        const password = this.authPassword
        this.authPassword = ''
        try {
            request.callback(username, password)
        } catch (e) {
            console.warn('[hagis] login callback failed', e)
        }
        this.nextAuth()
    }

    cancelAuth (): void {
        const request = this.authRequest
        if (!request) {
            return
        }
        try {
            request.callback()
        } catch { }
        this.nextAuth()
    }

    /** 닫힐 때 답을 기다리는 로그인 요청은 취소로 돌려준다 (안 그러면 요청이 영원히 멈춘다) */
    private cancelAllAuth (): void {
        for (const request of [this.authRequest, ...this.authQueue]) {
            try { request?.callback() } catch { }
        }
        this.authRequest = null
        this.authQueue = []
    }

    // ---------------------------------------------------------------- 단축키·찾기·우클릭 메뉴

    /** 웹 화면에서 누른 브라우저 단축키 */
    private onShortcut (command: string): void {
        switch (command) {
            case 'find': this.openFind(); break
            case 'find-next': this.runFind(false, true); break
            case 'find-prev': this.runFind(false, false); break
            case 'print': this.print(); break
            case 'devtools': this.openDevTools(); break
            case 'back': this.goBack(); break
            case 'forward': this.goForward(); break
            case 'reload': this.reload(); break
            case 'hard-reload': this.wc?.reloadIgnoringCache(); break
            case 'address': this.focusAddress(); break
            case 'zoom-in': this.changeZoom(0.1); break
            case 'zoom-out': this.changeZoom(-0.1); break
            case 'zoom-reset': this.resetZoom(); break
        }
    }

    private focusAddress (): void {
        try {
            this.web.remote.getCurrentWebContents().focus()
        } catch { }
        setTimeout(() => this.addressInput?.nativeElement.focus(), 30)
    }

    openFind (): void {
        if (!this.currentUrl) {
            return
        }
        this.findOpen = true
        try {
            this.web.remote.getCurrentWebContents().focus()
        } catch { }
        setTimeout(() => {
            const input = this.findInput?.nativeElement
            input?.focus()
            input?.select()
        }, 30)
        if (this.findText) {
            this.runFind(true)
        }
    }

    /** 찾기 — 새로 찾기(입력이 바뀜)면 처음부터, 아니면 다음/이전 결과로 */
    runFind (fresh: boolean, forward = true): void {
        const text = this.findText
        if (!text) {
            this.findCount = ''
            try {
                this.wc?.stopFindInPage('clearSelection')
            } catch { }
            return
        }
        try {
            if (fresh) {
                this.findCount = ''
            }
            const requestId = this.wc?.findInPage(text, { findNext: !fresh, forward })
            if (typeof requestId === 'number') {
                this.findRequestId = requestId
            }
            if (fresh) {
                // 찾은 것이 없으면 결과 이벤트가 오지 않는 경우가 있다 — 잠시 기다려도 없으면 "없음"
                const id = this.findRequestId
                setTimeout(() => this.zone.run(() => {
                    if (this.findOpen && this.findRequestId === id && !this.findCount && this.findText === text) {
                        this.findCount = '없음'
                    }
                }), 700)
            }
        } catch (e) {
            console.warn('[hagis] find failed', e)
        }
    }

    onFindKey (event: KeyboardEvent): void {
        if (event.key === 'Enter') {
            event.preventDefault()
            this.runFind(false, !event.shiftKey)
        } else if (event.key === 'Escape') {
            event.preventDefault()
            this.closeFind()
        }
    }

    closeFind (): void {
        this.findOpen = false
        this.findCount = ''
        try {
            this.wc?.stopFindInPage('clearSelection')
            this.wc?.focus()
        } catch { }
    }

    print (): void {
        try {
            this.wc?.print({ printBackground: true })
        } catch (e) {
            console.warn('[hagis] print failed', e)
        }
    }

    openDevTools (): void {
        try {
            this.wc?.openDevTools({ mode: 'detach' })
        } catch (e) {
            console.warn('[hagis] devtools failed', e)
        }
    }

    /** 웹 화면 우클릭 메뉴 (Electron 은 기본 메뉴를 주지 않는다) */
    private showContextMenu (params: any): void {
        const items = this.buildContextMenu(params)
        if (!items) {
            return
        }
        const remote = this.web.remote
        try {
            remote.Menu.buildFromTemplate(items).popup({ window: remote.getCurrentWindow() })
        } catch (e) {
            console.warn('[hagis] context menu failed', e)
        }
    }

    private buildContextMenu (params: any): any[]|null {
        const wc = this.wc
        if (!wc || !params || this.isPreview) {
            return null
        }
        const copy = (text: string) => this.platform.setClipboard({ text })
        const flags = params.editFlags ?? {}
        const items: any[] = []
        const sep = () => {
            if (items.length && items[items.length - 1].type !== 'separator') {
                items.push({ type: 'separator' })
            }
        }
        const link = String(params.linkURL ?? '')
        const image = params.mediaType === 'image' ? String(params.srcURL ?? '') : ''
        const selection = String(params.selectionText ?? '').trim()

        if (link) {
            if (this.web.isAllowedUrl(link)) {
                items.push({ label: '링크를 새 패널에서 열기', click: () => this.onNewTabRequest(link, true) })
                items.push({ label: '링크를 기본 브라우저에서 열기', click: () => this.platform.openExternal(link) })
            }
            items.push({ label: '링크 주소 복사', click: () => copy(link) })
            sep()
        }
        if (image) {
            if (this.web.isAllowedUrl(image)) {
                items.push({ label: '이미지를 새 패널에서 열기', click: () => this.onNewTabRequest(image, true) })
            }
            items.push({ label: '이미지 복사', click: () => wc.copyImageAt(params.x, params.y) })
            items.push({ label: '이미지 주소 복사', click: () => copy(image) })
            if (/^https?:/i.test(image)) {
                items.push({ label: '이미지 저장', click: () => wc.downloadURL(image) })
            }
            sep()
        }
        if (params.isEditable) {
            items.push({ label: '실행 취소', enabled: !!flags.canUndo, click: () => wc.undo() })
            items.push({ label: '다시 실행', enabled: !!flags.canRedo, click: () => wc.redo() })
            sep()
            items.push({ label: '잘라내기', enabled: !!flags.canCut, click: () => wc.cut() })
            items.push({ label: '복사', enabled: !!flags.canCopy, click: () => wc.copy() })
            items.push({ label: '붙여넣기', enabled: !!flags.canPaste, click: () => wc.paste() })
            items.push({ label: '전체 선택', enabled: !!flags.canSelectAll, click: () => wc.selectAll() })
        } else {
            if (selection) {
                items.push({ label: '복사', click: () => wc.copy() })
                if (this.web.searchEngine !== 'off') {
                    const shown = selection.length > 24 ? selection.slice(0, 24) + '…' : selection
                    items.push({ label: `${this.searchLabel()} 에서 "${shown}" 검색`, click: () => this.onNewTabRequest(this.web.searchUrl(selection), true) })
                }
                sep()
            }
            // 링크·이미지·선택 글자 위에서는 Chrome 처럼 그 항목만 보여 준다
            if (!link && !image && !selection) {
                items.push({ label: '뒤로', enabled: this.canGoBack, click: () => this.goBack() })
                items.push({ label: '앞으로', enabled: this.canGoForward, click: () => this.goForward() })
                items.push({ label: '새로고침', click: () => this.reload() })
                sep()
                items.push({ label: '전체 선택', click: () => wc.selectAll() })
                items.push({ label: '페이지에서 찾기…', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: () => this.zone.run(() => this.openFind()) })
                items.push({ label: '인쇄…', accelerator: 'CmdOrCtrl+P', registerAccelerator: false, click: () => this.print() })
            }
        }
        sep()
        items.push({ label: '검사', accelerator: 'F12', registerAccelerator: false, click: () => wc.inspectElement(params.x, params.y) })
        return items
    }

    // ---------------------------------------------------------------- 화면 위치 맞추기

    /** 패널 화면 영역을 따라 네이티브 뷰의 위치·표시 상태를 맞춘다 (공용 루프가 부른다) */
    private syncView = (ctx: HagisViewSyncContext): void => {
        if (this.destroyedFlag || !this.view) {
            return
        }
        const wanted = this.isVisible
            && !this.dragging
            && !ctx.overlayOpen
            && !this.hostElement.classList.contains('minimized')
            && !!this.currentUrl
            && !this.lastError
            && !this.connecting
            && !this.certProblem
        if (!wanted && this.lastShown === false) {
            return // 숨긴 채로 둔다 — 레이아웃 계산도 하지 않음
        }
        const rect = this.viewport.nativeElement.getBoundingClientRect()
        const hasArea = rect.width > 4 && rect.height > 4
        const preview = this.isPreview
        // 독(자동 숨기기)이 이 패널 위로 나와 있으면 캡처 그림으로 바꿔 둔다
        const covered = wanted && hasArea && (this.suggestOpen || this.downloadsOpen || (!!ctx.occluder && rectsOverlap(rect, ctx.occluder)))
        this.syncCover(covered, preview)
        // 미리보기는 캡처를 보여 주고 실제 화면은 숨긴다 (새 크기로 그릴 때만 잠깐 띄운다)
        const show = wanted && hasArea && (!preview || this.liveRefresh) && !(covered && (preview || !!this.coverShot))
        try {
            if (show !== this.lastShown) {
                this.view.setVisible(show)
                this.lastShown = show
            }
            if (!wanted || !hasArea) {
                return
            }
            const inset = ctx.inset
            const bounds = {
                x: Math.round((rect.left + inset) * ctx.pageZoom),
                y: Math.round((rect.top + inset) * ctx.pageZoom),
                width: Math.max(1, Math.round((rect.width - inset * 2) * ctx.pageZoom)),
                height: Math.max(1, Math.round((rect.height - inset * 2) * ctx.pageZoom)),
            }
            const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
            const resized = key !== this.lastBounds
            if (resized) {
                const sizeChanged = !this.lastBoundsSize
                    || this.lastBoundsSize.width !== bounds.width
                    || this.lastBoundsSize.height !== bounds.height
                this.view.setBounds(bounds)
                this.lastBounds = key
                this.lastBoundsSize = { width: bounds.width, height: bounds.height }
                if (preview && sizeChanged) {
                    this.scheduleLiveRefresh() // 숨긴 화면은 크기가 바뀌어도 다시 그리지 않으므로 잠깐 띄워 새로 그린다
                }
            }
            // 메인 패널 크기가 바뀌어도 축소 비율이 바뀐다 (1초마다 확인)
            if (preview && (resized || ctx.now - this.lastScaleCheck > 1000 || this.emulation === '?')) {
                this.lastScaleCheck = ctx.now
                if (this.applyPreviewScale()) {
                    this.scheduleLiveRefresh()
                }
            }
        } catch (e) {
            console.warn('[hagis] web view sync failed', e)
        }
    }

    /** 덮임 상태가 바뀌면 캡처를 찍거나(덮임) 치운다(풀림) */
    private syncCover (covered: boolean, preview: boolean): void {
        this.covered = covered
        if (covered) {
            clearTimeout(this.coverClearTimer)
            this.coverClearTimer = null
            if (!preview && !this.coverShot && !this.coverBusy && this.lastShown) {
                this.captureCover()
            }
            return
        }
        if (this.coverShot && !this.coverClearTimer) {
            // 실제 화면이 다시 뜬 뒤에 그림을 치운다 (빈 화면 깜빡임 방지)
            this.coverClearTimer = setTimeout(() => {
                this.coverClearTimer = null
                if (!this.covered) {
                    this.zone.run(() => this.coverShot = '')
                }
            }, 200)
        }
    }

    private async captureCover (): Promise<void> {
        if (!this.wc) {
            return
        }
        this.coverBusy = true
        this.viewSync.beginFreeze()
        try {
            let data = ''
            try {
                const image = await this.wc.capturePage()
                if (image && !image.isEmpty()) {
                    data = 'data:image/jpeg;base64,' + Buffer.from(image.toJPEG(85)).toString('base64')
                    const img = new Image()
                    img.src = data
                    await img.decode().catch(() => null)
                }
            } catch (e) {
                console.warn('[hagis] cover capture failed', e)
            }
            if (!this.covered || this.destroyedFlag) {
                return
            }
            if (data) {
                this.zone.run(() => this.coverShot = data)
                await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
            }
            // 캡처가 실패해도 숨긴다 — 독이 웹 화면에 가려 쓸 수 없게 되는 것보다 낫다
            if (this.covered && this.view && !this.destroyedFlag) {
                this.view.setVisible(false)
                this.lastShown = false
                this.zone.run(() => undefined) // 자동완성 목록이 이제 보여도 된다
            }
        } finally {
            this.coverBusy = false
            this.viewSync.endFreeze()
        }
    }

    // ---------------------------------------------------------------- 메인 무대

    /** 역할(메인/미리보기)에 맞춰 배율·캡처·포커스를 맞춘다 */
    private applyStage (focus = false): void {
        if (!this.wc) {
            return
        }
        const preview = this.isPreview
        this.applyZoom()
        this.applyPreviewScale()
        if (preview) {
            if (!this.snapshot) {
                this.liveRefresh = true // 첫 캡처가 나올 때까지는 실제 화면을 보여 준다
            }
            this.startSnapshotTimer()
            this.scheduleLiveRefresh(150)
        } else {
            this.stopSnapshotTimer()
            this.liveRefresh = false
            this.snapshot = ''
            if (focus) {
                try {
                    this.wc.focus()
                } catch { }
            }
        }
        this.viewSync.kick()
    }

    /**
     * 사용자가 정한 페이지 배율 (주소창 옆 %)
     * Chromium 배율은 같은 사이트끼리 공유되므로 미리보기 축소에는 쓰지 않는다 (applyPreviewScale)
     */
    private applyZoom (): void {
        if (!this.wc) {
            return
        }
        if (this.viewer.isViewerUrl(this.currentUrl)) {
            // 문서 뷰어는 Chromium 페이지 배율 대신 뷰어가 직접 배율을 적용한다 —
            // 문서를 창 폭에 맞춰 그리기 때문에, 페이지 배율을 올리면 창 폭이 줄어든 만큼 다시 맞춰져 커지지 않는다.
            if (this.appliedZoom !== 1) {
                this.appliedZoom = 1
                this.wc.setZoomFactor(1)
            }
            this.pushViewerZoom()
            return
        }
        if (this.zoomFactor === this.appliedZoom) {
            return
        }
        this.appliedZoom = this.zoomFactor
        this.wc.setZoomFactor(this.zoomFactor)
    }

    /** 뷰어 페이지에 현재 배율을 알린다 (페이지가 아직 준비 전이면 무시 — 다 열린 뒤 다시 알린다) */
    private pushViewerZoom (): void {
        Promise.resolve(this.wc?.executeJavaScript(`window.__hagisZoom && window.__hagisZoom(${Number(this.zoomFactor) || 1})`)).catch(() => null)
    }

    /**
     * 미리보기 축소 — 메인 자리에서 보이는 모습을 이 패널 크기로 줄인다.
     * 화면 에뮬레이션(이 패널에만 적용)을 써서 같은 사이트를 연 다른 패널의 배율에 영향을 주지 않는다.
     * @returns 설정이 바뀌었으면 true
     */
    private applyPreviewScale (): boolean {
        const size = this.lastBoundsSize
        if (!this.wc) {
            return false
        }
        let key = ''
        let params: any = null
        if (this.isPreview && size && size.width > 4 && size.height > 4) {
            const scale = Math.max(0.1, Math.min(1, Math.round(this.stage.previewScale(this) * 100) / 100))
            if (scale < 0.98) {
                const width = Math.round(size.width / scale)
                const height = Math.round(size.height / scale)
                key = `${width}x${height}@${scale}`
                params = {
                    screenPosition: 'desktop',
                    screenSize: { width, height },
                    viewPosition: { x: 0, y: 0 },
                    deviceScaleFactor: 0,
                    viewSize: { width, height },
                    scale,
                }
            }
        }
        if (key === this.emulation) {
            return false
        }
        this.emulation = key
        try {
            if (params) {
                this.wc.enableDeviceEmulation(params)
            } else {
                this.wc.disableDeviceEmulation()
            }
        } catch (e) {
            console.warn('[hagis] preview scale failed', e)
        }
        return true
    }

    private scheduleLiveRefresh (delay = 300): void {
        clearTimeout(this.liveRefreshTimer)
        this.zone.runOutsideAngular(() => {
            this.liveRefreshTimer = setTimeout(() => this.refreshSnapshot(true), delay)
        })
    }

    private startSnapshotTimer (): void {
        if (this.snapshotTimer) {
            return
        }
        // 여러 미리보기가 한꺼번에 캡처하지 않도록 시작 시점을 흩는다
        const next = (delay: number) => {
            this.snapshotTimer = setTimeout(() => {
                this.refreshSnapshot(false)
                next(this.refreshSeconds * 1000)
            }, delay)
        }
        this.zone.runOutsideAngular(() => next(Math.random() * this.refreshSeconds * 1000))
    }

    private stopSnapshotTimer (): void {
        clearTimeout(this.snapshotTimer)
        clearTimeout(this.liveRefreshTimer)
        this.snapshotTimer = null
        this.liveRefreshTimer = null
    }

    /**
     * 미리보기 캡처를 새로 찍는다.
     * live = 실제 화면을 잠깐 띄워서 새 크기로 그린 뒤 찍는다 (크기 변경·첫 캡처)
     *        아니면 숨긴 채로 찍는다 (Chromium 이 이때만 그린다)
     */
    private async refreshSnapshot (live: boolean): Promise<void> {
        if (!this.isPreview || !this.wc || this.destroyedFlag || !this.isVisible) {
            return
        }
        if (this.refreshBusy) {
            if (live) {
                this.scheduleLiveRefresh(LIVE_REFRESH_MS)
            }
            return
        }
        this.refreshBusy = true
        try {
            if (live) {
                this.liveRefresh = true
                this.viewSync.kick()
                await new Promise(r => setTimeout(r, LIVE_REFRESH_MS))
            }
            if (!this.isPreview || this.destroyedFlag) {
                return
            }
            const image = await this.wc.capturePage(undefined, live ? undefined : { stayHidden: true })
            if (image && !image.isEmpty() && this.isPreview) {
                const width = Math.round((this.lastBoundsSize?.width ?? 0) * (window.devicePixelRatio || 1))
                const size = image.getSize()
                const fitted = width && size.width > width * 1.15 ? image.resize({ width, quality: 'good' }) : image
                const data = 'data:image/jpeg;base64,' + Buffer.from(fitted.toJPEG(80)).toString('base64')
                this.zone.run(() => this.snapshot = data)
            }
        } catch (e) {
            console.warn('[hagis] preview capture failed', e)
        } finally {
            this.refreshBusy = false
            if (live && this.liveRefresh) {
                this.liveRefresh = false
                this.viewSync.kick()
            }
        }
    }

    /** 미리보기 화면 클릭 → 메인으로 (주소창은 그대로 입력할 수 있다) */
    onViewportMouseDown (event: MouseEvent): void {
        if (this.downloadsOpen) {
            this.closeDownloads()
        }
        if (!this.isPreview || event.button !== 0) {
            return
        }
        event.preventDefault()
        this.stage.promote(this)
    }

    // ---------------------------------------------------------------- 탐색

    private onNavigated (url: string): void {
        if (this.seeding && url === 'about:blank') {
            return
        }
        this.clearFallbackTimer()
        this.pendingFallback = null
        this.connecting = ''
        this.currentUrl = url
        const viewing = this.viewer.isViewerUrl(url)
        this.address = viewing ? this.viewer.originalPath(url) || url : url
        this.lastError = ''
        this.updateNavState()
        this.recoveryStateChangedHint.next()
        if (!viewing) {
            this.browserData.recordVisit(url, this.wc?.getTitle?.() ?? '')
        }
    }

    private updateNavState (): void {
        if (!this.wc) {
            return
        }
        const history = this.wc.navigationHistory
        this.canGoBack = history ? history.canGoBack() : this.wc.canGoBack()
        this.canGoForward = history ? history.canGoForward() : this.wc.canGoForward()
    }

    private currentHost (): string {
        try {
            return new URL(this.currentUrl || this.web.normalizeUrl(this.address)).hostname
        } catch {
            return ''
        }
    }

    navigate (): void {
        if (this.currentUrl && this.viewer.isViewerUrl(this.currentUrl) && this.address === this.viewer.originalPath(this.currentUrl)) {
            this.wc?.reload() // 문서 뷰어: 주소창에 보이는 건 파일 경로 — 그대로 Enter 면 다시 불러온다
            return
        }
        const { url, fallback } = this.web.resolveNavigation(this.address)
        if (!url) {
            return
        }
        if (!this.web.isAllowedUrl(url)) {
            this.lastError = 'http(s) 주소만 열 수 있습니다.'
            return
        }
        this.load(url, fallback)
    }

    private load (url: string, fallback: string|null): void {
        this.clearFallbackTimer()
        this.certProblem = null
        this.lastError = ''
        this.httpNotice = ''
        this.pendingFallback = fallback
        this.currentUrl = url
        this.address = this.viewer.isViewerUrl(url) ? this.viewer.originalPath(url) || url : url
        this.connecting = fallback ? `${url} 연결 중… (응답이 없으면 ${fallback} 로 다시 시도)` : ''
        this.wc?.loadURL(url).catch(() => null)
        this.viewSync.kick()
        // 같은 호스트의 인증서가 이미 확인을 기다리고 있으면 배너를 바로 다시 띄운다
        const pending = this.web.pendingProblemFor(this.currentHost())
        if (pending) {
            this.connecting = ''
            this.certProblem = pending
            return
        }
        if (fallback) {
            this.fallbackTimer = setTimeout(() => this.zone.run(() => this.useFallback()), HTTPS_FALLBACK_TIMEOUT)
        }
    }

    /** https 시도를 멈추고 http 주소로 다시 연다 */
    useFallback (): void {
        const fallback = this.pendingFallback
        if (!fallback) {
            return
        }
        this.pendingFallback = null
        this.certProblem = null
        try {
            this.wc?.stop()
        } catch { }
        this.load(fallback, null)
    }

    private clearFallbackTimer (): void {
        if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer)
            this.fallbackTimer = null
        }
    }

    // ---------------------------------------------------------------- 다운로드

    toggleDownloads (): void {
        if (this.downloadsOpen) {
            this.closeDownloads()
            return
        }
        this.closeSuggest()
        this.downloadsOpen = true
        this.viewSync.kick()
    }

    private closeDownloads (): void {
        if (!this.downloadsOpen) {
            return
        }
        this.downloadsOpen = false
        this.viewSync.kick()
    }

    isActive (d: HagisDownload): boolean {
        return d.state === 'progressing' || d.state === 'paused'
    }

    percentOf (d: HagisDownload): number {
        return d.total > 0 ? Math.min(100, Math.round(d.received / d.total * 100)) : 0
    }

    canView (d: HagisDownload): boolean {
        return d.state === 'completed' && this.downloads.exists(d) && this.viewer.canView(d.path)
    }

    openInViewer (d: HagisDownload): void {
        this.closeDownloads()
        this.openViewerPane(d.path).catch(e => this.notifications.error('hagis: 문서를 열지 못했습니다', String(e?.message ?? e)))
    }

    /** 문서(HWP·Word·Excel·PowerPoint·PDF 등)를 옆에 새 패널의 뷰어로 연다 */
    async openViewerPane (filePath: string): Promise<void> {
        const url = await this.viewer.prepare(filePath)
        // await 뒤의 코드는 Angular 영역 밖이라, 안에서 만들어야 새 패널 화면이 바로 그려진다
        this.zone.run(() => {
            const created: any = this.tabs.create({ type: HagisWebTabComponent, inputs: { url } })
            if (this.parent instanceof SplitTabComponent) {
                this.parent.addTab(created, this, 'r')
            } else {
                this.app.wrapAndAddTab(created)
            }
        })
    }

    fileIcon (d: HagisDownload): string {
        const ext = this.downloads.ext(d)
        if (['pdf'].includes(ext)) { return 'fa-file-pdf' }
        if (['doc', 'docx', 'hwp', 'hwpx', 'rtf', 'odt'].includes(ext)) { return 'fa-file-word' }
        if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) { return 'fa-file-excel' }
        if (['ppt', 'pptx', 'odp'].includes(ext)) { return 'fa-file-powerpoint' }
        if (['zip', '7z', 'rar', 'gz', 'tar', 'tgz'].includes(ext)) { return 'fa-file-archive' }
        if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) { return 'fa-file-image' }
        if (['txt', 'log', 'md', 'cfg', 'conf', 'json', 'xml'].includes(ext)) { return 'fa-file-alt' }
        return 'fa-file'
    }

    statusText (d: HagisDownload): string {
        const size = formatBytes(d.total > 0 ? d.total : d.received)
        switch (d.state) {
            case 'progressing':
                return d.total > 0 ? `${formatBytes(d.received)} / ${size} · ${this.percentOf(d)}%` : `${formatBytes(d.received)} 받는 중…`
            case 'paused':
                return `일시정지 · ${formatBytes(d.received)}${d.total > 0 ? ' / ' + size : ''}`
            case 'completed':
                return this.downloads.exists(d) ? `${size} · 완료` : '파일이 이동되었거나 삭제되었습니다'
            case 'cancelled':
                return '취소됨'
            default:
                return '받지 못했습니다 — 링크를 다시 눌러 보세요'
        }
    }

    // ---------------------------------------------------------------- 주소창 자동완성

    /** 입력할 때마다 후보를 다시 찾는다 (직접 입력한 경우에만 — 탐색으로 바뀐 주소에는 띄우지 않는다) */
    onAddressInput (value: string): void {
        clearTimeout(this.suggestBlurTimer)
        const opts = this.hagisConfig.store?.hagis?.browser?.suggest
        const typed = value.trim()
        const rows: HagisSuggestRow[] = []
        let searching = false
        if (typed && !/^(about|file):/i.test(typed)) {
            if (this.web.isSearch(typed)) {
                searching = true
                rows.push({ icon: 'fa-search', title: typed, sub: `${this.searchLabel()} 검색`, url: '' })
            } else {
                rows.push({ icon: 'fa-arrow-right', title: typed, sub: '이동', url: '' })
            }
        }
        if (opts?.enabled !== false) {
            const max = Math.min(12, Math.max(3, Number(opts?.max) || 8))
            for (const s of this.browserData.suggest(typed, max)) {
                rows.push({
                    icon: s.kind === 'bookmark' ? 'fa-star' : 'fa-history',
                    title: s.title,
                    sub: displayUrl(s.url),
                    url: s.url,
                })
            }
        }
        // 입력한 주소로 가는 줄만 있으면 띄우지 않는다 (검색어는 "검색" 줄 하나라도 보여 준다)
        this.suggestRows = rows.length > (typed ? 1 : 0) || searching ? rows : []
        this.suggestIndex = -1
        this.suggestOpen = this.suggestRows.length > 0
        this.viewSync.kick()
    }

    onAddressKey (event: KeyboardEvent): void {
        if (event.key === 'Enter') {
            const row = this.suggestOpen ? this.suggestRows[this.suggestIndex] : null
            this.closeSuggest()
            if (row?.url) {
                this.address = row.url
            }
            this.navigate()
            return
        }
        if (event.key === 'Escape') {
            if (this.suggestOpen) {
                event.preventDefault()
                this.closeSuggest()
            }
            return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!this.suggestOpen) {
                if (event.key === 'ArrowDown') {
                    this.onAddressInput(this.address === this.currentUrl ? '' : this.address) // 빈 입력: 자주 가는 곳
                }
                return
            }
            const count = this.suggestRows.length
            const next = this.suggestIndex + (event.key === 'ArrowDown' ? 1 : -1)
            this.suggestIndex = next < -1 ? count - 1 : next >= count ? -1 : next
            const row = this.suggestRows[this.suggestIndex]
            if (row?.url) {
                this.address = row.url
            }
        }
    }

    pickSuggestion (row: HagisSuggestRow, event: MouseEvent): void {
        event.preventDefault() // 입력칸이 포커스를 잃어 목록이 닫히지 않게
        if (row.url) {
            this.address = row.url
        }
        this.closeSuggest()
        this.navigate()
    }

    onAddressBlur (): void {
        // 목록을 클릭하는 동안 잠깐 포커스가 빠질 수 있어 조금 늦게 닫는다
        clearTimeout(this.suggestBlurTimer)
        this.suggestBlurTimer = setTimeout(() => this.zone.run(() => this.closeSuggest()), 120)
    }

    private closeSuggest (): void {
        clearTimeout(this.suggestBlurTimer)
        if (!this.suggestOpen && !this.suggestRows.length) {
            return
        }
        this.suggestOpen = false
        this.suggestRows = []
        this.suggestIndex = -1
        this.viewSync.kick()
    }

    private searchLabel (): string {
        const engine = this.web.searchEngine
        return engine === 'off' ? '' : HAGIS_SEARCH_ENGINES[engine]?.label ?? 'Google'
    }

    selectAll (event: FocusEvent): void {
        (event.target as HTMLInputElement).select()
    }

    goBack (): void {
        const wc = this.wc
        wc?.navigationHistory ? wc.navigationHistory.goBack() : wc?.goBack()
    }

    goForward (): void {
        const wc = this.wc
        wc?.navigationHistory ? wc.navigationHistory.goForward() : wc?.goForward()
    }

    reload (): void {
        if (!this.currentUrl || this.lastError) {
            this.navigate()
            return
        }
        this.wc?.reload()
    }

    stop (): void {
        this.clearFallbackTimer()
        this.connecting = ''
        this.wc?.stop()
    }

    changeZoom (delta: number): void {
        if (this.viewer.isViewerUrl(this.currentUrl)) {
            // 뷰어 안에서 Ctrl+휠로 바꾼 배율이 있으면 그 값에서 이어서 키운다
            Promise.resolve(this.wc?.executeJavaScript('window.__hagisScale ? window.__hagisScale() : 1'))
                .catch(() => null)
                .then(current => this.zone.run(() => this.setZoomFactor((Number(current) || this.zoomFactor) + delta)))
            return
        }
        this.setZoomFactor(this.zoomFactor + delta)
    }

    private setZoomFactor (value: number): void {
        this.zoomFactor = Math.min(3, Math.max(0.3, Math.round(value * 10) / 10))
        this.applyZoom()
        this.recoveryStateChangedHint.next()
        if (this.isPreview) {
            this.scheduleLiveRefresh()
        }
    }

    resetZoom (): void {
        this.zoomFactor = 1
        this.applyZoom()
        this.recoveryStateChangedHint.next()
        if (this.isPreview) {
            this.scheduleLiveRefresh()
        }
    }

    openExternal (): void {
        if (this.currentUrl) {
            this.platform.openExternal(this.currentUrl)
        }
    }

    /** 외부에서 주소를 지정해 연다 (링크 끌어다 놓기 등) */
    openUrl (url: string): void {
        this.address = url
        this.navigate()
    }

    /**
     * 페이지가 "새 탭으로" 열려던 링크
     *  - 설정 'pane' (기본): 옆에 새 웹 패널을 만든다 — 이름표(페이지 제목)가 하나 더 생기고 원래 화면은 그대로
     *  - 설정 'same': 이 패널에서 연다
     */
    private async onNewTabRequest (url: string, openable: boolean, frameName = ''): Promise<void> {
        if (this.destroyedFlag) {
            return
        }
        if (!openable || !this.web.isAllowedUrl(url)) {
            this.notifications.info(`hagis: 이 페이지가 열려던 주소는 웹 패널에서 열 수 없습니다 — ${url.slice(0, 80)}`)
            return
        }
        // 스크립트의 window.open 을 패널로 열고 중계하는 경우 (설정 'relay')
        const relayId = frameName.startsWith(HAGIS_RELAY_PREFIX) ? frameName.slice(HAGIS_RELAY_PREFIX.length) : ''
        if (!relayId && (this.hagisConfig.store?.hagis?.web?.newTabLinks ?? 'pane') === 'same') {
            this.load(url, null)
            return
        }
        // 브라우저가 새 창을 열 때 해 주는 것처럼 같은 사이트의 sessionStorage 를 복사해 넘긴다
        let seed: HagisWebTabComponent['seedSession'] = null
        try {
            const snapshot = await this.wc?.executeJavaScript(
                `(() => ({ origin: location.origin, name: window.name, storage: Object.fromEntries(Object.entries(sessionStorage)) }))()`,
            )
            if (snapshot && new URL(url).origin === snapshot.origin && Object.keys(snapshot.storage ?? {}).length + (snapshot.name ? 1 : 0) > 0) {
                seed = { origin: snapshot.origin, name: snapshot.name ?? '', storage: snapshot.storage ?? {} }
            }
        } catch { }
        if (this.destroyedFlag) {
            return
        }
        // await 뒤의 코드는 Angular 영역 밖이라, 안에서 만들어야 새 패널 화면이 바로 그려진다
        this.zone.run(() => {
            const inputs: any = { url, seedSession: seed }
            if (relayId) {
                inputs.relayHost = this
                inputs.relayId = relayId
            }
            const created: any = this.tabs.create({ type: HagisWebTabComponent, inputs })
            if (this.parent instanceof SplitTabComponent) {
                this.parent.addTab(created, this, 'r')
            } else {
                this.app.wrapAndAddTab(created)
            }
        })
    }

    private seedDebuggerAttached = false
    /** 세션 정보를 심는 동안 — 이때의 빈 페이지 이동은 사용자에게 보이지 않게 한다 */
    private seeding = false

    /**
     * 페이지 스크립트가 돌기 전에 sessionStorage 를 채운다 (같은 사이트일 때만, 이미 있는 값은 건드리지 않음).
     * 새 문서가 열릴 때마다 실행되는 스크립트를 디버깅 프로토콜로 등록하고, 첫 로드가 끝나면 디버거를 뗀다.
     */
    private async installSessionSeed (): Promise<void> {
        const seed = this.seedSession
        const wc = this.wc
        if ((!seed && !this.relayHost) || !wc) {
            return
        }
        this.seeding = true
        try {
            // 세션 값은 정해진 시간 안에 열리는 문서에만 넣는다 (그 뒤에 앱이 지운 값을 되살리지 않도록)
            let source = ''
            if (seed) {
                source += `(function () { try {
                    if (Date.now() > ${Date.now() + SEED_WINDOW_MS}) { return }
                    if (location.origin !== ${JSON.stringify(seed.origin)}) { return }
                    var data = ${JSON.stringify(seed.storage)};
                    for (var key in data) { if (sessionStorage.getItem(key) === null) { sessionStorage.setItem(key, data[key]) } }
                    if (!window.name) { window.name = ${JSON.stringify(seed.name)} }
                } catch (e) { } })();\n`
            }
            if (this.relayHost) {
                source += HAGIS_OPENER_SHIM
            }
            // 아직 한 번도 열리지 않은 화면은 디버거 명령에 답하지 않으므로 빈 페이지를 먼저 연다
            await wc.loadURL('about:blank').catch(() => null)
            wc.debugger.attach('1.3')
            this.seedDebuggerAttached = true
            await wc.debugger.sendCommand('Page.enable')
            await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })
            // "로드 끝" 이벤트는 https 실패 뒤 http 재시도처럼 중간 단계에서도 오므로 기대지 않고, 정해진 시간 뒤에 거둔다
            // (중계 패널의 가짜 opener 는 패널이 닫힐 때까지 둔다)
            if (!this.relayHost) {
                setTimeout(() => this.releaseSessionSeed(true), SEED_WINDOW_MS)
            }
        } catch (e) {
            console.warn('[hagis] session seed failed', e)
            this.releaseSessionSeed()
        }
    }

    /**
     * 심어 둔 스크립트를 거둔다.
     * 빈 페이지의 "로드 끝" 이벤트가 실제 주소의 이동이 시작된 뒤에 늦게 도착할 수 있으므로,
     * 실제 주소가 아직 불러오는 중이거나 빈 페이지인 동안에는 거두지 않는다 (force: 닫을 때).
     */
    private releaseSessionSeed (force = false): void {
        if (!this.seedDebuggerAttached) {
            return
        }
        if (!force) {
            let busy = true
            try {
                busy = !this.currentUrl || this.wc.getURL() === 'about:blank' || !!this.wc.isLoading()
            } catch { }
            if (busy) {
                return
            }
        }
        this.seedDebuggerAttached = false
        this.seedSession = null // 메모리에서도 지운다 (토큰이 들어 있을 수 있다)
        try {
            this.wc?.debugger.detach()
        } catch { }
    }

    // ---------------------------------------------------------------- window.open 중계

    private relayTimer: any = null
    private relayBusy = false
    /** 열어 준 페이지의 핸들(r.onload)에 "불러옴"을 아직 알리지 않았다 */
    private relayLoadPending = true

    private originOf (wc: any): string {
        try {
            const origin = new URL(wc.getURL()).origin
            return origin === 'null' ? '' : origin
        } catch {
            return ''
        }
    }

    /** 페이지 안의 중계 함수에 메시지 묶음을 넘긴다 (JSON 문자열을 한 번 더 문자열로 감싸 코드가 아니라 값으로만 들어가게 한다) */
    private relayDeliver (wc: any, fn: '__hagisRelay' | '__hagisOpener', list: any[]): Promise<any> {
        const payload = JSON.stringify(JSON.stringify(list))
        return Promise.resolve(wc.executeJavaScript(`window.${fn} && window.${fn}.deliver(${payload})`)).catch(() => null)
    }

    /**
     * 열어 준 페이지가 window.open 으로 받은 핸들(r)과 이 패널의 window.opener 를 잇는다.
     * 양쪽 페이지의 보관함을 몇 번씩 비워 상대에게 전달한다 — postMessage 의 대상 출처 규칙은 브라우저와 같게 지킨다.
     */
    private startRelay (): void {
        if (!this.relayHost || this.relayTimer) {
            return
        }
        this.relayTimer = setInterval(() => {
            this.relayTick().catch(() => null)
        }, RELAY_POLL_MS)
    }

    private async relayTick (): Promise<void> {
        const host = this.relayHost
        const wc = this.wc
        if (!host || !wc || this.relayBusy || this.destroyedFlag) {
            return
        }
        this.relayBusy = true
        try {
            const hostWc = !host.destroyedFlag ? host.wc : null
            const kidOrigin = this.originOf(wc)
            const hostOrigin = hostWc ? this.originOf(hostWc) : ''
            const id = JSON.stringify(this.relayId)

            // 새 패널이 열렸다 → 핸들의 onload
            if (hostWc && this.relayLoadPending && kidOrigin && !this.seeding && !this.connecting && !this.lastError && !wc.isLoading()) {
                this.relayLoadPending = false
                await this.relayDeliver(hostWc, '__hagisRelay', [{ id: this.relayId, type: 'load' }])
            }

            // 열어 준 페이지 → 이 패널
            if (hostWc) {
                const raw = await Promise.resolve(hostWc.executeJavaScript(`window.__hagisRelay ? window.__hagisRelay.drain(${id}) : '[]'`)).catch(() => '[]')
                const outgoing: any[] = this.parseList(raw)
                const toKid: any[] = []
                for (const m of outgoing) {
                    if (m.type === 'close') {
                        this.closeSelf()
                        return
                    }
                    if (m.type === 'msg' && targetOriginMatches(String(m.target ?? '/'), hostOrigin, kidOrigin)) {
                        toKid.push({ type: 'msg', data: m.data, from: hostOrigin })
                    }
                }
                if (toKid.length) {
                    await this.relayDeliver(wc, '__hagisOpener', toKid)
                }
            }

            // 이 패널 → 열어 준 페이지
            const rawKid = await Promise.resolve(wc.executeJavaScript(`window.__hagisOpener ? window.__hagisOpener.drain() : '[]'`)).catch(() => '[]')
            const toHost: any[] = []
            for (const m of this.parseList(rawKid)) {
                if (m.type === 'close') {
                    this.closeSelf()
                    return
                }
                if (hostWc && m.type === 'msg' && targetOriginMatches(String(m.target ?? '/'), kidOrigin, hostOrigin)) {
                    toHost.push({ id: this.relayId, type: 'msg', data: m.data, from: kidOrigin })
                }
            }
            if (toHost.length && hostWc) {
                await this.relayDeliver(hostWc, '__hagisRelay', toHost)
            }
        } finally {
            this.relayBusy = false
        }
    }

    private parseList (raw: any): any[] {
        try {
            const list = JSON.parse(String(raw))
            return Array.isArray(list) ? list : []
        } catch {
            return []
        }
    }

    /** 페이지가 window.close() / r.close() 를 불렀다 */
    private closeSelf (): void {
        this.zone.run(() => this.destroy())
    }

    private stopRelay (): void {
        if (this.relayTimer) {
            clearInterval(this.relayTimer)
            this.relayTimer = null
        }
        const host = this.relayHost
        this.relayHost = null
        // 열어 준 페이지의 핸들에 r.closed = true
        try {
            if (host && !host.destroyedFlag && host.wc) {
                this.relayDeliver(host.wc, '__hagisRelay', [{ id: this.relayId, type: 'closed' }])
            }
        } catch { }
    }

    /**
     * HTTP 오류(400 이상)로 끝난 문서 —
     * 장비가 빈 403 페이지를 돌려주면 화면이 그냥 비어 보이므로, 비어 있으면 이유를 화면에, 내용이 있으면 위 띠에 보여 준다.
     */
    private async inspectHttpError (): Promise<void> {
        const code = this.httpStatus
        const url = this.currentUrl
        let blank = false
        try {
            const size = await this.wc?.executeJavaScript(
                `(() => { const b = document.body; if (!b) return 0;
                    return (b.innerText || '').trim().length + b.querySelectorAll('img,svg,canvas,iframe,video,input,form').length * 100 })()`,
            )
            blank = Number(size) < 3
        } catch { }
        const message = await this.web.describeHttpProblem(url, code, this.httpStatusText)
        if (this.destroyedFlag || this.httpStatus !== code || this.currentUrl !== url) {
            return // 그 사이 다른 페이지로 이동
        }
        this.zone.run(() => {
            if (blank) {
                this.lastError = message
            } else {
                this.httpNotice = message
            }
        })
        this.viewSync.kick()
    }

    /** 웹 화면 캡처 (화면 캡처 기능이 부른다 — Electron NativeImage) */
    async captureImage (): Promise<any|null> {
        if (!this.wc) {
            return null
        }
        return this.wc.capturePage(undefined, this.lastShown ? undefined : { stayHidden: true })
    }

    /** 작은 미리보기에서 처리하기 어려운 일(인증서 확인 등) → 메인 자리로 올린다 */
    promoteSelf (): void {
        this.stage.promote(this)
    }

    dismissHttpNotice (): void {
        this.httpNotice = ''
        this.viewSync.kick()
    }

    /**
     * 신뢰 — 보류돼 있던 검증에 "허용"을 답하고 새로 접속한다.
     * (기다리는 동안 합쳐진 접속은 Chromium 기본 결과로 실패할 수 있어, 허용 결과가 캐시된 뒤 다시 연다)
     */
    async trustCertificate (): Promise<void> {
        const problem = this.certProblem
        if (!problem) {
            return
        }
        await this.web.trust(problem)
    }

    private reloadAfterTrust (): void {
        this.certProblem = null
        this.lastError = ''
        this.pendingFallback = null
        this.connecting = ''
        setTimeout(() => this.wc?.loadURL(this.currentUrl).catch(() => null), 300)
    }

    /** 신뢰하지 않음 — 접속을 멈춘다 (거부를 확정하지 않으므로 다시 열면 배너가 다시 나온다) */
    dismissCertificate (): void {
        if (!this.certProblem) {
            return
        }
        this.certProblem = null
        this.pendingFallback = null
        this.stop()
        this.lastError = '인증서를 신뢰하지 않아 열지 않았습니다. 새로고침하면 다시 확인합니다.'
    }

    getCurrentUrl (): string {
        return this.currentUrl || this.url
    }

    async getRecoveryToken (_options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        return {
            type: 'hagis:web-tab',
            url: this.getCurrentUrl(),
            paneTitle: this.paneTitle,
            zoomFactor: this.zoomFactor,
        }
    }

    private disposeView (): void {
        if (this.destroyedFlag) {
            return
        }
        this.destroyedFlag = true
        knownWcIds.delete(this.wcId)
        this.cancelAllAuth()
        this.cancelAllPrompts()
        this.stopRelay()
        this.releaseSessionSeed(true)
        this.clearFallbackTimer()
        this.stopSnapshotTimer()
        clearTimeout(this.coverClearTimer)
        this.unregisterSync?.()
        this.unregisterSync = null
        if (!this.view) {
            return
        }
        try {
            const wc = this.wc
            for (const [event, handler] of this.listeners) {
                wc.removeListener(event, handler)
            }
            this.web.remote.getCurrentWindow().contentView.removeChildView(this.view)
            wc.close()
        } catch (e) {
            console.warn('[hagis] web view dispose failed', e)
        }
        this.view = null
        this.wc = null
    }

    destroy (skipDestroyedEvent = false): void {
        this.disposeView()
        super.destroy(skipDestroyedEvent)
    }

    ngOnDestroy (): void {
        this.disposeView()
        super.ngOnDestroy()
    }
}

/** 웹 패널들의 webContents 번호 (다운로드가 어느 패널 것인지 가리는 데 쓴다) */
const knownWcIds = new Set<number>()

function formatBytes (bytes: number): string {
    if (!(bytes >= 0)) {
        return '-'
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** HTTP 인증(로그인) 요청 — callback(아이디, 비밀번호) 로그인 · callback() 취소 */
interface HagisAuthRequest {
    isProxy: boolean
    scheme: string
    host: string
    port: number
    realm: string
    callback: (user?: string, pass?: string) => void
    /** 같은 곳에 방금 입력했는데 또 묻는다 = 아이디·비밀번호가 틀림 */
    retry: boolean
}

/** 자동완성 목록의 한 줄 */
interface HagisSuggestRow {
    icon: string
    title: string
    sub: string
    /** 고르면 이 주소로 (입력한 내용 그대로 가는 줄은 빈 값) */
    url: string
}

/** 목록에 보일 주소 — 스킴·www 와 끝의 / 를 뗀다 */
function displayUrl (url: string): string {
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
}
