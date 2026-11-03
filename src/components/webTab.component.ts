import { Component, ElementRef, Injector, NgZone, ViewChild, AfterViewInit, OnDestroy, OnInit } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, GetRecoveryTokenOptions, NotificationsService, PlatformService, RecoveryToken, SplitTabComponent, TabsService } from 'tabby-core'
import { HagisCertificateProblem, HagisWebService, HAGIS_OPEN_IN_PLACE, HAGIS_WEB_PARTITION } from '../services/web.service'
import { HagisPaneService } from '../services/pane.service'
import { HagisStageService } from '../services/stage.service'
import { HagisViewSyncContext, HagisViewSyncService, rectsOverlap } from '../services/viewSync.service'
import { HagisStageRole } from '../models'

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
    <input
        class="form-control form-control-sm hagis-web-address"
        [(ngModel)]="address"
        (keyup.enter)="navigate()"
        (focus)="selectAll($event)"
        placeholder="관리 페이지 주소 (예: 192.168.1.99)"
        spellcheck="false"
    >
    <button class="btn btn-sm btn-link" (click)="changeZoom(-0.1)" title="축소"><i class="fas fa-search-minus"></i></button>
    <span class="hagis-web-zoom" (click)="resetZoom()" title="100%로">{{ zoomPercent }}%</span>
    <button class="btn btn-sm btn-link" (click)="changeZoom(0.1)" title="확대"><i class="fas fa-search-plus"></i></button>
    <button class="btn btn-sm btn-link" (click)="openExternal()" [disabled]="!currentUrl" title="기본 브라우저로 열기"><i class="fas fa-external-link-alt"></i></button>
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
.hagis-web-address { flex: auto; min-width: 40px; height: 26px; font-size: 12px; }
.hagis-web-zoom { font-size: 11px; opacity: .7; cursor: pointer; min-width: 36px; text-align: center; }
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
`],
})
export class HagisWebTabComponent extends BaseTabComponent implements OnInit, AfterViewInit, OnDestroy {
    /** 처음 열 주소 (입력값) */
    url = ''
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

    @ViewChild('viewport') viewport: ElementRef<HTMLElement>

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
        this.subscribeUntilDestroyed(this.stage.changed$, change => {
            if (change.tab === this) {
                this.zone.run(() => this.applyStage(change.promoted))
            }
        })
    }

    ngAfterViewInit (): void {
        try {
            this.web.ensureSession()
            this.createView()
        } catch (e) {
            console.error('[hagis] web view creation failed', e)
            this.lastError = `웹 패널을 만들 수 없습니다: ${e}`
            return
        }
        if (this.url) {
            this.address = this.url
            this.navigate()
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
        // 새 탭으로 열리는 링크(target=_blank 등)는 팝업 창 대신 이 패널 안에서 연다 — 진짜 팝업만 창으로
        on(HAGIS_OPEN_IN_PLACE, (url: string, _disposition: string, openable: boolean) => this.onNewTabRequest(url, openable))
        try {
            this.web.attachWindowOpenHandler(wc)
        } catch (e) {
            console.warn('[hagis] window open handler failed', e)
        }
        this.applyZoom()
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
        const covered = wanted && hasArea && !!ctx.occluder && rectsOverlap(rect, ctx.occluder)
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
        if (!this.wc || this.zoomFactor === this.appliedZoom) {
            return
        }
        this.appliedZoom = this.zoomFactor
        this.wc.setZoomFactor(this.zoomFactor)
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
        if (!this.isPreview || event.button !== 0) {
            return
        }
        event.preventDefault()
        this.stage.promote(this)
    }

    // ---------------------------------------------------------------- 탐색

    private onNavigated (url: string): void {
        this.clearFallbackTimer()
        this.pendingFallback = null
        this.connecting = ''
        this.currentUrl = url
        this.address = url
        this.lastError = ''
        this.updateNavState()
        this.recoveryStateChangedHint.next()
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
        this.address = url
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
        this.zoomFactor = Math.min(3, Math.max(0.3, Math.round((this.zoomFactor + delta) * 10) / 10))
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
    private onNewTabRequest (url: string, openable: boolean): void {
        if (this.destroyedFlag) {
            return
        }
        if (!openable || !this.web.isAllowedUrl(url)) {
            this.notifications.info(`hagis: 이 페이지가 열려던 주소는 웹 패널에서 열 수 없습니다 — ${url.slice(0, 80)}`)
            return
        }
        if ((this.hagisConfig.store?.hagis?.web?.newTabLinks ?? 'pane') === 'same') {
            this.load(url, null)
            return
        }
        const created: any = this.tabs.create({ type: HagisWebTabComponent, inputs: { url } })
        if (this.parent instanceof SplitTabComponent) {
            this.parent.addTab(created, this, 'r')
        } else {
            this.app.wrapAndAddTab(created)
        }
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
