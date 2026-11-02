import { Injectable } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { BaseTabComponent, NotificationsService, SplitContainer, SplitTabComponent } from 'tabby-core'
import { HagisStageRole } from '../models'
import { HagisPaneService } from './pane.service'

/** 한 화면의 미리보기 최대 개수 */
export const MAX_PREVIEWS = 20

/** 미리보기 개수 → 열 수 (한 열에 8개 정도까지) */
function previewColumns (count: number): number {
    return count <= 8 ? 1 : count <= 16 ? 2 : 3
}

export interface HagisStageChange {
    tab: BaseTabComponent
    role: HagisStageRole|null
    /** 미리보기를 클릭해 메인으로 올라온 경우 */
    promoted: boolean
}

/**
 * 메인 무대 — 큰 메인 패널 하나 + 보기 전용 미리보기 패널 여러 개
 *
 * 미리보기를 클릭하면 메인과 자리를 맞바꾼다. 패널을 새로 만들지 않고 자리만 바꾸므로
 * 웹 로그인·스크롤·터미널 세션이 그대로 유지된다. 역할은 패널(tab.hagisStage)에 붙어 다니고,
 * 탭 복원·워크스페이스 저장에 함께 기록된다.
 *
 * 컴포넌트 클래스를 import 하지 않는다 (컴포넌트가 이 서비스를 주입받기 때문)
 */
@Injectable({ providedIn: 'root' })
export class HagisStageService {
    private changed = new Subject<HagisStageChange>()

    get changed$ (): Observable<HagisStageChange> { return this.changed }

    constructor (
        private panes: HagisPaneService,
        private notifications: NotificationsService,
    ) { }

    role (tab: BaseTabComponent|null|undefined): HagisStageRole|null {
        const role = (tab as any)?.hagisStage
        return role === 'main' || role === 'preview' ? role : null
    }

    /** 역할 지정 — 메인은 분할 화면마다 하나 (기존 메인은 미리보기가 된다) */
    setRole (tab: BaseTabComponent, role: HagisStageRole|null): void {
        const split = this.splitOf(tab)
        if (role === 'main' && split) {
            for (const other of split.getAllTabs()) {
                if (other !== tab && this.role(other) === 'main') {
                    this.assign(other, 'preview')
                }
            }
        }
        this.assign(tab, role)
        this.hintSplit(split)
    }

    /** 이 패널을 메인으로, 같은 분할 화면의 나머지는 모두 미리보기로 */
    makeStage (main: BaseTabComponent): void {
        const split = this.splitOf(main)
        if (!split) {
            return
        }
        for (const tab of split.getAllTabs()) {
            this.assign(tab, tab === main ? 'main' : 'preview')
        }
        this.hintSplit(split)
    }

    /** 분할 화면의 메인 무대를 모두 해제 */
    clearStage (tab: BaseTabComponent): void {
        const split = this.splitOf(tab)
        for (const t of split?.getAllTabs() ?? [tab]) {
            if (this.role(t)) {
                this.assign(t, null)
            }
        }
        this.hintSplit(split)
    }

    /** 이벤트 없이 역할만 붙인다 (아직 화면에 붙지 않은 새 패널용) */
    assignQuiet (tab: BaseTabComponent, role: HagisStageRole|null): void {
        if (role) {
            (tab as any).hagisStage = role
        } else {
            delete (tab as any).hagisStage
        }
    }

    findMain (split: SplitTabComponent|null): BaseTabComponent|null {
        return split?.getAllTabs().find(t => this.role(t) === 'main') ?? null
    }

    hasStage (tab: BaseTabComponent): boolean {
        return !!this.findMain(this.splitOf(tab))
    }

    /** 미리보기 → 메인 (메인이었던 패널은 그 자리의 미리보기가 된다) */
    promote (tab: BaseTabComponent): boolean {
        if (this.role(tab) !== 'preview') {
            return false
        }
        const split = this.splitOf(tab)
        const main = this.findMain(split)
        if (!split || !main) {
            this.notifications.info('hagis: 메인 패널이 없습니다 — 크게 볼 패널의 메뉴(☰) → 메인 무대 → 이 패널을 메인으로')
            return false
        }
        if (split.getMaximizedTab()) {
            split.maximize(null)
        }
        this.panes.swapPanes(tab, main)
        this.assign(main, 'preview')
        this.assign(tab, 'main', true)
        return true
    }

    previewCount (split: SplitTabComponent|null): number {
        return split?.getAllTabs().filter(t => this.role(t) === 'preview').length ?? 0
    }

    /**
     * 메인 + 미리보기 격자로 다시 배치한다.
     * 메인 폭(비율)은 그대로 두고, 나머지 패널을 반대쪽에 격자로 채운다 — 미리보기가 늘면 미리보기만 작아진다.
     * 패널을 새로 만들지 않고 컨테이너만 다시 짜므로 웹 로그인·터미널 세션이 유지된다.
     */
    arrange (split: SplitTabComponent): void {
        const main = this.findMain(split)
        if (!main) {
            return
        }
        const rect = (t: BaseTabComponent) => this.panes.hostElement(t)?.getBoundingClientRect()
        const mainRect = rect(main)
        const others = split.getAllTabs().filter(t => t !== main)
        // 화면에 보이는 순서 유지 (왼쪽 열부터, 위에서 아래로)
        const pos = new Map(others.map(t => {
            const r = rect(t)
            return [t, r ? [Math.round(r.left / 20), r.top] : [0, 0]] as [BaseTabComponent, number[]]
        }))
        others.sort((a, b) => pos.get(a)![0] - pos.get(b)![0] || pos.get(a)![1] - pos.get(b)![1])

        // 메인 폭 비율과 위치(왼쪽/오른쪽) 유지
        const rects = split.getAllTabs().map(rect).filter(Boolean) as DOMRect[]
        const left = Math.min(...rects.map(r => r.left))
        const right = Math.max(...rects.map(r => r.right))
        let fraction = mainRect && right > left ? mainRect.width / (right - left) : 0.74
        if (!others.length || fraction > 0.95) {
            fraction = 0.74
        }
        fraction = Math.min(0.9, Math.max(0.4, fraction))
        const mainOnRight = !!mainRect && mainRect.left > left + 4

        const group = (orientation: 'h' | 'v', children: (BaseTabComponent|SplitContainer)[]): BaseTabComponent|SplitContainer => {
            if (children.length === 1) {
                return children[0]
            }
            const container = new SplitContainer()
            container.orientation = orientation
            container.children = children
            container.ratios = children.map(() => 1 / children.length)
            return container
        }

        const root = new SplitContainer()
        root.orientation = 'h'
        if (others.length) {
            const columns = previewColumns(others.length)
            const cols: (BaseTabComponent|SplitContainer)[] = []
            let index = 0
            for (let c = 0; c < columns; c++) {
                const size = Math.ceil((others.length - index) / (columns - c))
                cols.push(group('v', others.slice(index, index + size)))
                index += size
            }
            const grid = group('h', cols)
            root.children = mainOnRight ? [grid, main] : [main, grid]
            root.ratios = mainOnRight ? [1 - fraction, fraction] : [fraction, 1 - fraction]
        } else {
            root.children = [main]
            root.ratios = [1]
        }
        split.root = root
        split.layout()
        this.hintSplit(split)
    }

    /**
     * 미리보기 축소 비율 — 미리보기 폭 / 메인 폭
     * (메인 자리에서 보이는 모습을 그대로 줄여 보여 준다)
     */
    previewScale (tab: BaseTabComponent): number {
        const main = this.findMain(this.splitOf(tab))
        const width = this.panes.hostElement(tab)?.clientWidth ?? 0
        const mainWidth = main ? this.panes.hostElement(main)?.clientWidth ?? 0 : 0
        if (!width || !mainWidth) {
            return 0.5
        }
        return width / mainWidth
    }

    private assign (tab: BaseTabComponent, role: HagisStageRole|null, promoted = false): void {
        this.assignQuiet(tab, role)
        ;(tab as any).recoveryStateChangedHint?.next()
        this.changed.next({ tab, role, promoted })
    }

    private splitOf (tab: BaseTabComponent): SplitTabComponent|null {
        return tab.parent instanceof SplitTabComponent ? tab.parent : null
    }

    private hintSplit (split: SplitTabComponent|null): void {
        ;(split as any)?.recoveryStateChangedHint?.next()
    }
}
