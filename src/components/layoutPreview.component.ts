import { Component, HostBinding, Input } from '@angular/core'
import { HagisLayoutNode, isSplit } from '../models'

/** 레이아웃 트리를 작은 도식으로 그린다 (런처·설정 화면용) */
@Component({
    selector: 'hagis-layout-preview',
    template: `
<ng-container *ngIf="split; else pane">
    <hagis-layout-preview
        *ngFor="let child of split.children; let i = index"
        [node]="child"
        [style.flex]="grow(i) + ' 1 0'"
    ></hagis-layout-preview>
</ng-container>
<ng-template #pane>
    <div class="hlp-pane" [ngClass]="'hlp-' + node.kind" [title]="label">
        <i class="fas fa-globe" *ngIf="node.kind === 'web'"></i>
        <span>{{ label }}</span>
    </div>
</ng-template>
`,
    styles: [`
:host { display: flex; min-width: 0; min-height: 0; gap: 2px; flex: 1 1 0; }
:host(.hlp-h) { flex-direction: row; }
:host(.hlp-v) { flex-direction: column; }
.hlp-pane { flex: auto; display: flex; align-items: center; justify-content: center; gap: 3px; min-width: 0; min-height: 0;
  border-radius: 2px; font-size: 9px; line-height: 1.1; padding: 1px; overflow: hidden; text-align: center;
  background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); }
.hlp-pane span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hlp-profile { background: rgba(80, 160, 255, .16); border-color: rgba(80, 160, 255, .35); }
.hlp-web { background: rgba(80, 220, 160, .14); border-color: rgba(80, 220, 160, .35); }
.hlp-empty { border-style: dashed; opacity: .75; }
`],
})
export class HagisLayoutPreviewComponent {
    @Input() node: HagisLayoutNode

    get split () {
        return isSplit(this.node) ? this.node : null
    }

    @HostBinding('class.hlp-h') get isH (): boolean { return isSplit(this.node) && this.node.orientation === 'h' }
    @HostBinding('class.hlp-v') get isV (): boolean { return isSplit(this.node) && this.node.orientation === 'v' }

    get label (): string {
        const node = this.node
        if (isSplit(node)) {
            return ''
        }
        if (node.stage === 'main' && !node.title) {
            return '★ 메인'
        }
        if (node.stage === 'preview' && !node.title && !(node.kind === 'web' && node.url)) {
            return '미리보기'
        }
        if (node.kind === 'web') {
            return node.title || node.url || 'Web'
        }
        if (node.kind === 'profile') {
            return node.title || node.profile?.name || '프로필'
        }
        return node.title || ''
    }

    grow (i: number): number {
        const split = this.split
        const r = split?.ratios?.[i]
        return r && split?.ratios?.length === split?.children.length ? r : 1
    }
}
