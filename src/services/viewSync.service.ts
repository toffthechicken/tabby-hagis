import { Injectable, NgZone } from '@angular/core'
import { AppService, SplitTabComponent } from 'tabby-core'
import { HagisPaneService } from './pane.service'

export interface HagisRect {
    left: number
    top: number
    right: number
    bottom: number
}

export interface HagisViewSyncContext {
    /** 모달·드롭다운·드래그 오버레이가 떠 있음 (네이티브 웹 뷰는 숨겨야 가려지지 않는다) */
    overlayOpen: boolean
    /** Tabby 창 자체의 확대 배율 (CSS px → 창 좌표) */
    pageZoom: number
    now: number
    /**
     * Tabby 화면(HTML)이 웹 패널 위로 올라와 있는 영역 (CSS px) — 예: 자동 숨기기 독이 나와 있을 때.
     * 네이티브 웹 화면은 HTML 보다 위에 그려지므로, 겹치는 웹 패널은 그동안 캡처 그림으로 바꿔 둔다.
     */
    occluder: HagisRect|null
}

export function rectsOverlap (a: HagisRect, b: HagisRect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()))

type SyncFn = (ctx: HagisViewSyncContext) => void

/** 아무 변화가 없을 때 확인 간격 */
const IDLE_INTERVAL = 250
/** 변화가 감지되면 이 시간 동안은 매 프레임 맞춘다 */
const HOT_MS = 700

/**
 * 웹 패널(네이티브 뷰)의 위치·표시 상태를 Tabby 화면에 맞추는 공용 루프
 *
 * 예전에는 웹 패널마다 매 프레임(초당 60회) 위치를 확인했다 — 패널이 많으면 Tabby 화면 프로세스와
 * 메인 프로세스가 쉬지 못한다. 이제 루프 하나가 모든 웹 패널을 처리하고,
 * 평소에는 초당 4회만 확인하다가 화면이 바뀌는 순간(마우스 조작, 분할 배치 변경, 창 크기, 탭 전환, 대화상자)에만
 * 잠깐 매 프레임으로 올린다.
 */
@Injectable({ providedIn: 'root' })
export class HagisViewSyncService {
    private views = new Set<SyncFn>()
    private hotUntil = 0
    private pointerDown = false
    private raf = 0
    private timer: any = null
    private initialized = false
    private occluder: HagisRect|null = null
    /** 캡처 그림으로 바꾸는 중인 웹 패널 수 */
    private freezing = 0

    constructor (
        private app: AppService,
        private panes: HagisPaneService,
        private zone: NgZone,
    ) { }

    register (fn: SyncFn): () => void {
        this.init()
        this.views.add(fn)
        this.kick()
        return () => this.views.delete(fn)
    }

    /** 이 영역을 Tabby 화면이 덮는다 (null = 해제) — 겹치는 웹 패널은 그동안 캡처 그림으로 바뀐다 */
    setOccluder (rect: HagisRect|null): void {
        this.occluder = rect
        this.kick()
    }

    beginFreeze (): void {
        this.freezing++
    }

    endFreeze (): void {
        this.freezing = Math.max(0, this.freezing - 1)
    }

    /** 덮인 웹 패널이 모두 그림으로 바뀔 때까지 기다린다 (최대 maxMs) */
    async settle (maxMs = 300): Promise<void> {
        const start = performance.now()
        await nextFrame()
        await nextFrame()
        while (this.freezing > 0 && performance.now() - start < maxMs) {
            await nextFrame()
        }
    }

    /** 곧 화면이 바뀐다 — 잠깐 매 프레임으로 맞춘다 */
    kick (ms = HOT_MS): void {
        this.hotUntil = Math.max(this.hotUntil, performance.now() + ms)
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        if (!this.raf && this.views.size) {
            this.zone.runOutsideAngular(() => {
                this.raf = requestAnimationFrame(this.tick)
            })
        }
    }

    private init (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true
        this.zone.runOutsideAngular(() => {
            const capture = { capture: true, passive: true }
            window.addEventListener('resize', () => this.kick(), capture)
            window.addEventListener('pointerdown', () => {
                this.pointerDown = true
                this.kick()
            }, capture)
            window.addEventListener('pointerup', () => {
                this.pointerDown = false
                this.kick()
            }, capture)
            window.addEventListener('pointermove', e => e.buttons && this.kick(), capture)
            window.addEventListener('wheel', () => this.kick(), capture)
            window.addEventListener('keydown', () => this.kick(400), capture)
            // 대화상자·드래그 오버레이는 body 에 바로 붙는다
            new MutationObserver(() => this.kick()).observe(document.body, { childList: true })
        })
        this.app.activeTabChange$.subscribe(() => this.kick())
        this.app.tabsChanged$.subscribe(() => this.kick())
        this.app.tabDragActive$.subscribe(() => this.kick())
        this.panes.paneDrag$.subscribe(() => this.kick())

        // 분할 화면이 다시 배치될 때마다 (경계 끌기, 자리 바꾸기, 패널 추가·삭제, 미리보기 정렬)
        const proto: any = SplitTabComponent.prototype
        if (!proto.__hagisLayoutHooked) {
            const original = proto.layout
            const self = this
            proto.layout = function (...args: any[]) {
                const result = original.apply(this, args)
                self.kick()
                return result
            }
            proto.__hagisLayoutHooked = true
        }
    }

    private tick = (): void => {
        this.raf = 0
        this.timer = null
        if (!this.views.size) {
            return
        }
        const ctx: HagisViewSyncContext = {
            overlayOpen: !!document.querySelector('ngb-modal-window, .modal.show, .dropdown-menu.show, .hagis-drag-overlay'),
            pageZoom: this.pageZoom(),
            now: performance.now(),
            occluder: this.occluder,
        }
        for (const fn of this.views) {
            try {
                fn(ctx)
            } catch (e) {
                console.warn('[hagis] view sync failed', e)
            }
        }
        if (this.pointerDown || ctx.now < this.hotUntil) {
            this.raf = requestAnimationFrame(this.tick)
        } else {
            this.timer = setTimeout(this.tick, IDLE_INTERVAL)
        }
    }

    private pageZoom (): number {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require('electron').webFrame.getZoomFactor()
        } catch {
            return 1
        }
    }
}
