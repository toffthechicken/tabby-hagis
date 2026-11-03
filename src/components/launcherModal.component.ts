import { Component, OnInit } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { HagisPreset, HagisWorkspace, ZOOM_PRESETS, countPanes, zoomPercent } from '../models'
import { BUILTIN_PRESETS } from '../presets'
import { HagisWorkspaceService } from '../services/workspace.service'

/** 런처가 닫힐 때 돌려주는 동작 — 실제 실행은 HagisActionsService가 한다 */
export type HagisLauncherResult =
    | { action: 'open-workspace', workspace: HagisWorkspace }
    | { action: 'open-preset', preset: HagisPreset }
    | { action: 'save' }
    | { action: 'compact', enabled: boolean }
    | { action: 'zoom-all', zoom: number }
    | { action: 'add-web' }
    | { action: 'add-empty' }
    | { action: 'add-markdown' }
    | { action: 'settings' }

/** hagis 메인 화면 — 고객사 워크스페이스와 레이아웃 프리셋을 한 번에 연다 */
@Component({
    template: `
<div class="modal-header hagis-launcher-header">
    <div>
        <div class="hagis-logo">hagis <span>by tabby</span></div>
        <div class="hagis-tagline">Hub for All Gear, In Sight <span class="hagis-maker">· made by <b>JakeandToff</b></span></div>
    </div>
    <input class="form-control hagis-search" [(ngModel)]="query" placeholder="고객사·워크스페이스 검색" autofocus>
</div>
<div class="modal-body hagis-launcher-body">
    <section>
        <h6>고객사 워크스페이스</h6>
        <div class="hagis-empty-note" *ngIf="!workspaces.workspaces.length">
            아직 저장된 워크스페이스가 없습니다. 아래 프리셋으로 화면을 구성한 뒤 <b>현재 화면 저장</b>을 누르세요.
        </div>
        <div *ngFor="let group of workspaces.groupedWorkspaces(query)" class="hagis-group">
            <div class="hagis-group-title"><i class="fas fa-building"></i> {{ group.customer }}</div>
            <div class="hagis-cards">
                <button class="hagis-card" *ngFor="let ws of group.items" (click)="close({ action: 'open-workspace', workspace: ws })">
                    <hagis-layout-preview class="hagis-card-preview" [node]="ws.layout"></hagis-layout-preview>
                    <div class="hagis-card-name">{{ ws.name }}</div>
                    <div class="hagis-card-desc">{{ ws.description || (paneCount(ws.layout) + '개 패널') }}</div>
                </button>
            </div>
        </div>
    </section>

    <section>
        <h6>레이아웃 프리셋 <small class="text-muted">빈 패널에서 프로필·웹 GUI·Markdown을 고르거나 파일을 끌어다 놓으세요. 네임태그를 드래그하면 패널이 옮겨집니다</small></h6>
        <div class="hagis-cards">
            <button class="hagis-card" *ngFor="let preset of presets" (click)="close({ action: 'open-preset', preset: preset })">
                <hagis-layout-preview class="hagis-card-preview" [node]="preset.layout"></hagis-layout-preview>
                <div class="hagis-card-name">{{ preset.name }}</div>
                <div class="hagis-card-desc">{{ preset.description }}</div>
            </button>
        </div>
    </section>
</div>
<div class="modal-footer hagis-launcher-footer">
    <button class="btn btn-primary" (click)="close({ action: 'save' })"><i class="fas fa-save"></i> 현재 화면 저장</button>
    <button class="btn btn-secondary" (click)="close({ action: 'add-web' })"><i class="fas fa-globe"></i> 웹 GUI 패널 추가</button>
    <button class="btn btn-secondary" (click)="close({ action: 'add-markdown' })"><i class="fab fa-markdown"></i> Markdown 열기</button>
    <button class="btn btn-secondary" (click)="close({ action: 'add-empty' })"><i class="fas fa-plus-square"></i> 빈 패널 추가</button>
    <div class="hagis-footer-group">
        <span>글자 일괄</span>
        <button class="btn btn-sm btn-outline-secondary" *ngFor="let z of zoomPresets" (click)="close({ action: 'zoom-all', zoom: z.zoom })" [title]="percent(z.zoom) + '%'">{{ z.label }}</button>
    </div>
    <button class="btn" [class.btn-warning]="workspaces.compactMode" [class.btn-outline-secondary]="!workspaces.compactMode"
        (click)="close({ action: 'compact', enabled: !workspaces.compactMode })">
        <i class="fas fa-compress"></i> 컴팩트 {{ workspaces.compactMode ? 'ON' : 'OFF' }}
    </button>
    <button class="btn btn-link" (click)="close({ action: 'settings' })"><i class="fas fa-cog"></i> 설정</button>
</div>
`,
    styles: [`
.hagis-launcher-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.hagis-logo { font-size: 22px; font-weight: 700; letter-spacing: .5px; line-height: 1.1; }
.hagis-logo span { font-size: 13px; font-weight: 400; opacity: .6; }
.hagis-tagline { font-size: 12px; opacity: .6; }
.hagis-maker b { color: #c6ff00; font-weight: 600; }
.hagis-search { max-width: 280px; }
.hagis-launcher-body { max-height: 65vh; overflow-y: auto; }
.hagis-launcher-body section + section { margin-top: 18px; }
.hagis-launcher-body h6 { font-weight: 600; margin-bottom: 8px; }
.hagis-empty-note { font-size: 13px; opacity: .7; padding: 6px 0; }
.hagis-group { margin-bottom: 10px; }
.hagis-group-title { font-size: 12px; opacity: .75; margin-bottom: 6px; }
.hagis-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.hagis-card { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 8px; border-radius: 6px;
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); color: inherit; }
.hagis-card:hover { background: rgba(255,255,255,.09); border-color: rgba(255,255,255,.25); }
.hagis-card-preview { height: 78px; flex: none !important; }
.hagis-card-name { font-weight: 600; font-size: 13px; }
.hagis-card-desc { font-size: 11px; opacity: .65; }
.hagis-launcher-footer { flex-wrap: wrap; justify-content: flex-start; gap: 6px; }
.hagis-footer-group { display: flex; align-items: center; gap: 3px; font-size: 12px; opacity: .9; margin: 0 6px; }
.hagis-footer-group span { margin-right: 3px; }
`],
})
export class HagisLauncherModalComponent implements OnInit {
    query = ''
    presets = BUILTIN_PRESETS
    zoomPresets = ZOOM_PRESETS

    constructor (
        private modal: NgbActiveModal,
        public workspaces: HagisWorkspaceService,
    ) { }

    ngOnInit (): void { }

    paneCount (layout): number {
        return countPanes(layout)
    }

    percent (zoom: number): number {
        return zoomPercent(zoom)
    }

    close (result: HagisLauncherResult): void {
        this.modal.close(result)
    }
}
