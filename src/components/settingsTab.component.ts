import { Component } from '@angular/core'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'
import { HagisTrustedCertificate } from '../config'
import { HAGIS_AUTHOR, HAGIS_INSTAGRAM, HAGIS_INSTAGRAM_URL, HagisWorkspace, ZOOM_PRESETS, countPanes, zoomPercent } from '../models'
import { HagisWebService } from '../services/web.service'
import { HagisWorkspaceService } from '../services/workspace.service'

/** 설정 → hagis */
@Component({
    template: `
<div class="hagis-settings">
    <h3>hagis <small class="text-muted">by tabby</small></h3>
    <p class="text-muted">네트워크 엔지니어용 통합 워크스페이스 — 고객사별 레이아웃, 패널별 글자 크기, 웹 GUI 패널</p>
    <div class="hagis-credit">
        <span>made by <b>{{ author }}</b></span>
        <span class="hagis-credit-dot">·</span>
        <a href="#" (click)="openInstagram($event)"><i class="fab fa-instagram"></i> &#64;{{ instagram }}</a>
    </div>

    <h4>화면</h4>
    <div class="form-line">
        <div class="header">
            <div class="title">패널 글자 크기 컨트롤</div>
            <div class="description">터미널 패널 우측 상단에 마우스를 올리면 A− / A+ / XS·S·M·L / 최대화 버튼을 표시합니다</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.paneControls" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">컴팩트 모드</div>
            <div class="description">탭 바·터미널 여백을 줄이고 모든 터미널 글자를 작게 해 한 화면에 더 많은 장비를 배치합니다</div>
        </div>
        <toggle [ngModel]="workspaces.compactMode" (ngModelChange)="workspaces.setCompactMode($event)"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">컴팩트 모드 글자 크기</div>
        </div>
        <select class="form-select" [(ngModel)]="config.store.hagis.compactZoom" (ngModelChange)="config.save()">
            <option *ngFor="let z of zoomOptions" [ngValue]="z">{{ percent(z) }}%</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">컴팩트 모드 여백</div>
            <div class="description">Tabby 기본값은 1.0 입니다</div>
        </div>
        <input type="range" class="form-range" min="0.1" max="1" step="0.05"
            [(ngModel)]="config.store.hagis.compactSpaciness" (ngModelChange)="config.save()">
        <span class="ms-2">{{ config.store.hagis.compactSpaciness }}</span>
    </div>

    <div class="form-line">
        <div class="header">
            <div class="title">패널 네임태그</div>
            <div class="description">분할 화면 각 패널 좌측 상단의 형광 이름표 — 드래그: 패널 이동 · 우클릭/더블클릭: 이름 변경</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.paneTags" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">모서리 크기 조절 핸들</div>
            <div class="description">가로·세로 경계가 만나는 모서리를 끌어 두 방향을 한 번에 조절 (더블클릭: 균등 분할)</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.cornerHandles" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">독 (화면 옆 실행 막대)</div>
            <div class="description">자주 쓰는 프로그램·프로필·워크스페이스·웹 주소 아이콘. 탐색기에서 프로그램을 끌어다 놓으면 추가, 우클릭: 편집</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.dock.enabled" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line" *ngIf="config.store.hagis.dock.enabled">
        <div class="header">
            <div class="title">독 위치 · 확대 효과</div>
        </div>
        <select class="form-control" style="width: 110px" [(ngModel)]="config.store.hagis.dock.side" (ngModelChange)="config.save()">
            <option value="left">왼쪽</option>
            <option value="right">오른쪽</option>
        </select>
        <toggle class="ms-3" [(ngModel)]="config.store.hagis.dock.magnify" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line" *ngIf="config.store.hagis.dock.enabled">
        <div class="header">
            <div class="title">독 표시 방식</div>
            <div class="description">자동 숨기기: 평소에는 가장자리에 얇은 띠만 남고, 마우스를 대면 독이 화면 위로 나옵니다 (macOS 독처럼)</div>
        </div>
        <select class="form-control" style="width: 220px" [(ngModel)]="config.store.hagis.dock.autoHide" (ngModelChange)="config.save()">
            <option [ngValue]="false">항상 표시 (기본)</option>
            <option [ngValue]="true">마우스를 대면 표시 (자동 숨기기)</option>
        </select>
    </div>
    <div class="form-line">
        <div class="header">
            <div class="title">웹 미리보기 갱신 주기</div>
            <div class="description">메인 무대의 웹 미리보기는 실제 화면을 멈춰 두고(CPU 절약) 이 주기마다 캡처를 새로 찍습니다. 클릭해 메인으로 올리면 실시간 화면입니다.</div>
        </div>
        <select class="form-control" style="width: 120px" [(ngModel)]="config.store.hagis.preview.refreshSeconds" (ngModelChange)="config.save()">
            <option [ngValue]="3">3초</option>
            <option [ngValue]="5">5초</option>
            <option [ngValue]="10">10초</option>
            <option [ngValue]="30">30초</option>
            <option [ngValue]="60">1분</option>
        </select>
    </div>

    <h4 class="mt-4">터미널 이어가기</h4>
    <p class="text-muted small">
        hagis를 종료하면 터미널 안의 프로그램도 함께 끝납니다. 다시 열 때(재시작 복원·워크스페이스 열기) 같은 작업 폴더에서
        아래 규칙의 명령을 자동 실행해 이전 작업을 이어갑니다. 패널마다 네임태그 우클릭 → <b>시작 명령 지정</b>으로 직접 정할 수도 있습니다.
    </p>
    <div class="form-line">
        <div class="header">
            <div class="title">실행 중이던 AI CLI 자동 이어가기</div>
        </div>
        <toggle [(ngModel)]="config.store.hagis.resume.enabled" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="mb-3">
        <label class="form-label small">규칙 — 한 줄에 하나: <code>프로세스 이름 = 다시 실행할 명령</code></label>
        <textarea class="form-control hagis-rules" [(ngModel)]="config.store.hagis.resume.rules" (blur)="config.save()" spellcheck="false"></textarea>
    </div>

    <h4 class="mt-4">고객사 워크스페이스 <small class="text-muted">{{ workspaces.workspaces.length }}개</small></h4>
    <div class="d-flex gap-2 mb-2 flex-wrap">
        <input class="form-control hagis-filter" [(ngModel)]="filter" placeholder="검색">
        <button class="btn btn-secondary" (click)="exportAll()"><i class="fas fa-copy"></i> JSON 복사 (내보내기)</button>
        <button class="btn btn-secondary" (click)="showImport = !showImport"><i class="fas fa-file-import"></i> 가져오기</button>
    </div>
    <div *ngIf="showImport" class="mb-3">
        <textarea class="form-control hagis-import" [(ngModel)]="importText" placeholder="내보낸 JSON을 붙여넣으세요"></textarea>
        <button class="btn btn-primary mt-2" [disabled]="!importText.trim()" (click)="importAll()">가져오기</button>
    </div>

    <div *ngFor="let group of workspaces.groupedWorkspaces(filter)" class="mb-3">
        <div class="hagis-group-title"><i class="fas fa-building"></i> {{ group.customer }}</div>
        <div class="list-group">
            <div class="list-group-item hagis-ws" *ngFor="let ws of group.items">
                <hagis-layout-preview class="hagis-ws-preview" [node]="ws.layout"></hagis-layout-preview>
                <div class="hagis-ws-fields" *ngIf="editingId === ws.id; else view">
                    <input class="form-control form-control-sm" [(ngModel)]="edit.customer" placeholder="고객사">
                    <input class="form-control form-control-sm" [(ngModel)]="edit.name" placeholder="이름">
                    <input class="form-control form-control-sm" [(ngModel)]="edit.description" placeholder="메모">
                </div>
                <ng-template #view>
                    <div class="hagis-ws-fields">
                        <div class="fw-bold">{{ ws.name }}</div>
                        <div class="small text-muted">{{ ws.description || '' }} · {{ count(ws) }}개 패널 · 수정 {{ ws.updatedAt | date:'yyyy-MM-dd HH:mm' }}</div>
                    </div>
                </ng-template>
                <div class="hagis-ws-actions">
                    <ng-container *ngIf="editingId === ws.id; else actions">
                        <button class="btn btn-sm btn-primary" (click)="saveEdit(ws)">확인</button>
                        <button class="btn btn-sm btn-secondary" (click)="editingId = null">취소</button>
                    </ng-container>
                    <ng-template #actions>
                        <button class="btn btn-sm btn-primary" (click)="workspaces.openWorkspace(ws)" title="열기"><i class="fas fa-play"></i></button>
                        <button class="btn btn-sm btn-secondary" (click)="startEdit(ws)" title="이름·고객사 수정"><i class="fas fa-pen"></i></button>
                        <button class="btn btn-sm btn-secondary" (click)="workspaces.duplicateWorkspace(ws)" title="복제"><i class="fas fa-clone"></i></button>
                        <button class="btn btn-sm btn-danger" (click)="remove(ws)" title="삭제"><i class="fas fa-trash"></i></button>
                    </ng-template>
                </div>
            </div>
        </div>
    </div>

    <h4 class="mt-4">웹 GUI 패널</h4>
    <p class="text-muted small">
        웹 패널은 Tabby와 분리된 세션(persist:hagis-web)에서 Node.js 권한 없이 실행됩니다.
        인증서 검증은 끄지 않으며, 자체 서명 인증서는 아래 목록에 있는 호스트·지문만 허용합니다.
    </p>
    <div class="list-group mb-2">
        <div class="list-group-item d-flex align-items-center gap-2" *ngFor="let cert of web.trustedCertificates">
            <div class="flex-grow-1 hagis-cert">
                <div class="fw-bold">{{ cert.host }}</div>
                <div class="small text-muted">{{ cert.subject }} · {{ cert.addedAt | date:'yyyy-MM-dd' }}</div>
                <code class="small">{{ cert.fingerprint }}</code>
            </div>
            <button class="btn btn-sm btn-danger" (click)="untrust(cert)"><i class="fas fa-trash"></i></button>
        </div>
        <div class="list-group-item text-muted small" *ngIf="!web.trustedCertificates.length">신뢰한 인증서가 없습니다</div>
    </div>
    <button class="btn btn-secondary" (click)="clearWebData()"><i class="fas fa-broom"></i> 웹 패널 쿠키·캐시 삭제</button>
</div>
`,
    styles: [`
.hagis-settings h4 { font-size: 16px; font-weight: 600; }
.hagis-filter { max-width: 240px; }
.hagis-import { min-height: 120px; font-family: monospace; font-size: 12px; }
.hagis-rules { min-height: 80px; font-family: monospace; font-size: 12px; }
.hagis-group-title { font-size: 12px; opacity: .75; margin-bottom: 4px; }
.hagis-ws { display: flex; align-items: center; gap: 12px; }
.hagis-ws-preview { width: 96px; height: 54px; flex: none !important; }
.hagis-ws-fields { flex: auto; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.hagis-ws-actions { flex: none; display: flex; gap: 4px; }
.hagis-cert code { word-break: break-all; }
.hagis-credit {
    display: inline-flex; align-items: center; gap: 8px; margin: -4px 0 18px; padding: 4px 12px; border-radius: 999px;
    font-size: 12px; background: rgba(198, 255, 0, .08); border: 1px solid rgba(198, 255, 0, .35);
}
.hagis-credit b { color: #c6ff00; letter-spacing: .3px; }
.hagis-credit a { color: inherit; text-decoration: none; opacity: .85; }
.hagis-credit a:hover { opacity: 1; text-decoration: underline; }
.hagis-credit-dot { opacity: .4; }
`],
})
export class HagisSettingsTabComponent {
    filter = ''
    showImport = false
    importText = ''
    editingId: string|null = null
    edit = { name: '', customer: '', description: '' }
    zoomOptions = [-6, -5, -4, -3, -2, -1, ...ZOOM_PRESETS.filter(p => p.zoom >= 0).map(p => p.zoom)]
    author = HAGIS_AUTHOR
    instagram = HAGIS_INSTAGRAM

    constructor (
        public config: ConfigService,
        public workspaces: HagisWorkspaceService,
        public web: HagisWebService,
        private platform: PlatformService,
        private notifications: NotificationsService,
    ) { }

    percent (z: number): number {
        return zoomPercent(z)
    }

    openInstagram (event: Event): void {
        event.preventDefault()
        this.platform.openExternal(HAGIS_INSTAGRAM_URL)
    }

    count (ws: HagisWorkspace): number {
        return countPanes(ws.layout)
    }

    startEdit (ws: HagisWorkspace): void {
        this.editingId = ws.id
        this.edit = { name: ws.name, customer: ws.customer ?? '', description: ws.description ?? '' }
    }

    async saveEdit (ws: HagisWorkspace): Promise<void> {
        if (!this.edit.name.trim()) {
            return
        }
        await this.workspaces.upsertWorkspace({
            ...ws,
            name: this.edit.name.trim(),
            customer: this.edit.customer.trim() || undefined,
            description: this.edit.description.trim() || undefined,
        })
        this.editingId = null
    }

    async remove (ws: HagisWorkspace): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `"${ws.name}" 워크스페이스를 삭제할까요?`,
            buttons: ['삭제', '취소'],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response === 0) {
            await this.workspaces.deleteWorkspace(ws.id)
        }
    }

    exportAll (): void {
        this.platform.setClipboard({ text: this.workspaces.exportWorkspaces() })
        this.notifications.notice('hagis: 워크스페이스 JSON을 클립보드에 복사했습니다')
    }

    async importAll (): Promise<void> {
        try {
            const count = await this.workspaces.importWorkspaces(this.importText)
            this.notifications.info(`hagis: 워크스페이스 ${count}개를 가져왔습니다`)
            this.importText = ''
            this.showImport = false
        } catch (e) {
            this.notifications.error('hagis: 가져오기 실패', String(e))
        }
    }

    async untrust (cert: HagisTrustedCertificate): Promise<void> {
        await this.web.untrust(cert)
    }

    async clearWebData (): Promise<void> {
        await this.web.clearBrowsingData()
        this.notifications.notice('hagis: 웹 패널 쿠키·캐시를 삭제했습니다')
    }
}
