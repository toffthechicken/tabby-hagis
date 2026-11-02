import { Injectable } from '@angular/core'
import { ConfigService, SplitContainer, SplitTabComponent } from 'tabby-core'
import { HagisPaneService } from './pane.service'

interface SpannerRef {
    container: SplitContainer
    index: number
}

interface Corner {
    /** 세로 경계선 (가로로 나뉜 'h' 컨테이너) */
    v: SpannerRef
    /** 가로 경계선 (세로로 나뉜 'v' 컨테이너) */
    h: SpannerRef
}

/** 비율 하한 — 패널이 너무 작아지지 않게 (Tabby 기본 경계선과 같은 값) */
const MIN_RATIO = 0.1

/**
 * 모서리 크기 조절
 * Tabby 경계선은 한 방향씩만 움직인다. 가로·세로 경계가 만나는 지점(+ 와 T 자 교차)에 핸들을 두고,
 * 끌면 두 컨테이너의 비율을 동시에, 실시간으로 바꾼다.
 */
@Injectable({ providedIn: 'root' })
export class HagisCornerResizeService {
    private handles = new WeakMap<SplitTabComponent, HTMLElement[]>()

    constructor (
        private config: ConfigService,
        private panes: HagisPaneService,
    ) { }

    refresh (split: SplitTabComponent): void {
        const host = this.panes.hostElement(split)
        for (const el of this.handles.get(split) ?? []) {
            el.remove()
        }
        this.handles.set(split, [])
        if (!host || !(this.config.store?.hagis?.cornerHandles ?? true) || split.getMaximizedTab()) {
            return
        }
        const elements: HTMLElement[] = []
        for (const corner of this.findCorners(split)) {
            const el = document.createElement('div')
            el.className = 'hagis-corner'
            el.title = '끌어서 가로·세로 크기를 한 번에 조절 · 더블클릭: 균등 분할'
            this.position(el, corner)
            el.addEventListener('pointerdown', e => this.onPointerDown(split, corner, el, e))
            el.addEventListener('dblclick', e => {
                e.stopPropagation()
                this.equalize(corner)
                split.layout()
                this.refresh(split)
            })
            host.appendChild(el)
            elements.push(el)
        }
        this.handles.set(split, elements)
    }

    private lines (split: SplitTabComponent) {
        const spanners: SpannerRef[] = (split as any)._spanners ?? []
        const verticals = spanners
            .filter(s => s.container.orientation === 'h')
            .map(s => {
                const c = s.container
                return { s, x: c.x + c.w * c.getOffsetRatio(s.index), y1: c.y, y2: c.y + c.h }
            })
        const horizontals = spanners
            .filter(s => s.container.orientation === 'v')
            .map(s => {
                const c = s.container
                return { s, y: c.y + c.h * c.getOffsetRatio(s.index), x1: c.x, x2: c.x + c.w }
            })
        return { verticals, horizontals }
    }

    private findCorners (split: SplitTabComponent): Corner[] {
        const { verticals, horizontals } = this.lines(split)
        const eps = 0.5 // %
        const corners: Corner[] = []
        for (const v of verticals) {
            for (const h of horizontals) {
                if (v.x >= h.x1 - eps && v.x <= h.x2 + eps && h.y >= v.y1 - eps && h.y <= v.y2 + eps) {
                    corners.push({ v: v.s, h: h.s })
                }
            }
        }
        return corners
    }

    private cornerPoint (corner: Corner): { x: number, y: number } {
        const vc = corner.v.container
        const hc = corner.h.container
        return {
            x: vc.x + vc.w * vc.getOffsetRatio(corner.v.index),
            y: hc.y + hc.h * hc.getOffsetRatio(corner.h.index),
        }
    }

    private position (el: HTMLElement, corner: Corner): void {
        const p = this.cornerPoint(corner)
        el.style.left = `${p.x}%`
        el.style.top = `${p.y}%`
    }

    private onPointerDown (split: SplitTabComponent, corner: Corner, el: HTMLElement, down: PointerEvent): void {
        if (down.button !== 0) {
            return
        }
        down.preventDefault()
        down.stopPropagation()
        const host = this.panes.hostElement(split)!
        const rect = host.getBoundingClientRect()
        const vc = corner.v.container
        const hc = corner.h.container
        const vi = corner.v.index
        const hi = corner.h.index
        const startV = [vc.ratios[vi - 1], vc.ratios[vi]]
        const startH = [hc.ratios[hi - 1], hc.ratios[hi]]

        split.onSpannerResizing(true)
        this.panes.setPaneDrag(split) // 웹 패널(네이티브 뷰)이 마우스를 가로채지 않게 잠시 숨김
        document.body.classList.add('resizing', 'hagis-corner-dragging')
        el.classList.add('active')

        let frame = 0
        let last: PointerEvent|null = null
        const apply = () => {
            frame = 0
            if (!last) {
                return
            }
            const clamp = (d: number, start: number[]) => Math.min(Math.max(d, -start[0] + MIN_RATIO), start[1] - MIN_RATIO)
            const dx = clamp((last.clientX - down.clientX) / (rect.width * vc.w / 100), startV)
            const dy = clamp((last.clientY - down.clientY) / (rect.height * hc.h / 100), startH)
            vc.ratios[vi - 1] = startV[0] + dx
            vc.ratios[vi] = startV[1] - dx
            hc.ratios[hi - 1] = startH[0] + dy
            hc.ratios[hi] = startH[1] - dy
            split.layout()
            this.position(el, corner)
        }
        const onMove = (e: PointerEvent) => {
            last = e
            if (!frame) {
                frame = requestAnimationFrame(apply)
            }
        }
        const onUp = () => {
            window.removeEventListener('pointermove', onMove, true)
            window.removeEventListener('pointerup', onUp, true)
            if (frame) {
                cancelAnimationFrame(frame)
                apply()
            }
            document.body.classList.remove('resizing', 'hagis-corner-dragging')
            el.classList.remove('active')
            split.onSpannerResizing(false)
            this.panes.setPaneDrag(null)
            // Tabby 경계선 조절과 같은 경로로 알림 (레이아웃 + 복원 상태 저장)
            split.onSpannerAdjusted(corner.v as any)
            split.onSpannerAdjusted(corner.h as any)
            this.refresh(split)
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
    }

    private equalize (corner: Corner): void {
        for (const s of [corner.v, corner.h]) {
            const r = (s.container.ratios[s.index - 1] + s.container.ratios[s.index]) / 2
            s.container.ratios[s.index - 1] = r
            s.container.ratios[s.index] = r
        }
    }
}
