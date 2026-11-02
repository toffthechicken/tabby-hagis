import { Component, Injector, OnInit } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, BaseTabComponent, GetRecoveryTokenOptions, PartialProfile, Profile, ProfilesService, PromptModalComponent, RecoveryToken } from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'
import { HagisPaneService } from '../services/pane.service'

/** hagis 자체 패널(웹 GUI, Markdown)을 목록 맨 위에 둔다 */
const HAGIS_TYPES = ['hagis-web', 'hagis-markdown']

/**
 * 빈 패널 — 아직 아무것도 지정되지 않은 자리
 * 프로필(SSH·Telnet·Serial·로컬 CLI·웹 GUI·Markdown)을 고르거나, 주소를 입력해 빠른 연결하거나,
 * 파일·링크를 끌어다 놓아 채운다.
 */
@Component({
    selector: 'hagis-placeholder-tab',
    template: `
<div class="hagis-ph">
    <div class="hagis-ph-head">
        <span class="hagis-tag-slot"></span>
        <input
            class="form-control form-control-sm"
            [(ngModel)]="query"
            (ngModelChange)="filter()"
            (keyup.enter)="onEnter()"
            placeholder="프로필 검색 또는 user@host 입력"
            spellcheck="false"
        >
    </div>
    <div class="hagis-ph-list">
        <button class="hagis-ph-item hagis-ph-builtin" (click)="quickConnect('ssh')" [title]="'Tabby SSH로 접속 (SFTP 사용 가능)'">
            <span class="hagis-ph-type">ssh</span>
            <span class="hagis-ph-name">{{ hostQuery ? 'SSH 연결 → ' + hostQuery : 'SSH 빠른 연결…' }}</span>
        </button>
        <button class="hagis-ph-item hagis-ph-builtin" (click)="quickConnect('telnet')">
            <span class="hagis-ph-type">telnet</span>
            <span class="hagis-ph-name">{{ hostQuery ? 'Telnet 연결 → ' + hostQuery : 'Telnet 빠른 연결…' }}</span>
        </button>
        <button
            class="hagis-ph-item"
            *ngFor="let p of filtered"
            [class.hagis-ph-builtin]="isHagis(p)"
            (click)="choose(p)"
            [title]="describe(p)"
        >
            <span class="hagis-ph-type">{{ typeLabel(p) }}</span>
            <span class="hagis-ph-name">{{ label(p) }}</span>
        </button>
        <div class="hagis-ph-empty" *ngIf="!filtered.length">{{ loaded ? '일치하는 프로필이 없습니다' : '프로필 불러오는 중…' }}</div>
    </div>
    <div class="hagis-ph-foot">
        <button class="btn btn-sm btn-link" (click)="showSelector()"><i class="fas fa-list"></i> 전체 프로필</button>
        <button class="btn btn-sm btn-link" (click)="newProfile()"><i class="fas fa-plus"></i> 새 SSH 프로필</button>
        <span class="hagis-ph-hint"><i class="fas fa-file-import"></i> 파일·링크를 끌어다 놓아도 됩니다</span>
    </div>
</div>
`,
    styles: [`
:host { display: flex; flex-direction: column; flex: auto; min-height: 0; overflow: hidden; }
.hagis-ph { display: flex; flex-direction: column; gap: 4px; padding: 4px 6px 4px; width: 100%; height: 100%; min-height: 0; }
.hagis-ph-head { flex: none; display: flex; align-items: center; gap: 6px; min-width: 0; }
.hagis-ph-head input { flex: auto; min-width: 40px; height: 24px; font-size: 12px; }
.hagis-ph-list { flex: auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.hagis-ph-item { display: flex; gap: 8px; align-items: baseline; text-align: left; background: transparent; border: none; color: inherit; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
.hagis-ph-item:hover { background: rgba(255,255,255,.08); }
.hagis-ph-builtin .hagis-ph-name { color: #c6ff00; }
.hagis-ph-type { flex: none; font-size: 10px; text-transform: uppercase; opacity: .5; width: 46px; }
.hagis-ph-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hagis-ph-empty { font-size: 12px; opacity: .5; padding: 4px 6px; }
.hagis-ph-foot { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
.hagis-ph-foot .btn { padding: 0 4px; font-size: 11px; }
.hagis-ph-hint { opacity: .5; }
`],
})
export class HagisPlaceholderTabComponent extends BaseTabComponent implements OnInit {
    /** 이전 버전 호환용 — 이름은 이제 네임태그(customTitle)로 관리 */
    paneTitle = ''
    /** 프로필이 지정되면 적용할 글자 크기 단계 */
    zoom = 0

    query = ''
    loaded = false
    profiles: PartialProfile<Profile>[] = []
    filtered: PartialProfile<Profile>[] = []

    /** 검색어가 접속 주소처럼 보이면 그 값 */
    get hostQuery (): string {
        return this.panes.looksLikeHost(this.query) ? this.query.trim() : ''
    }

    constructor (
        injector: Injector,
        private panes: HagisPaneService,
        private profilesService: ProfilesService,
        private modal: NgbModal,
        private app: AppService,
    ) {
        super(injector)
        this.icon = 'fas fa-plus-square'
    }

    async ngOnInit (): Promise<void> {
        this.setTitle('빈 패널')
        if (this.paneTitle && !this.customTitle) {
            this.customTitle = this.paneTitle
        }
        const list = await this.panes.getSelectableProfiles()
        this.profiles = [
            ...list.filter(p => this.isHagis(p)),
            ...list.filter(p => !this.isHagis(p)),
        ]
        this.loaded = true
        this.filter()
    }

    isHagis (p: PartialProfile<Profile>): boolean {
        return HAGIS_TYPES.includes(p.type)
    }

    typeLabel (p: PartialProfile<Profile>): string {
        return { 'hagis-web': 'web', 'hagis-markdown': 'md' }[p.type] ?? p.type
    }

    filter (): void {
        const q = this.query.trim().toLowerCase()
        this.filtered = this.profiles
            .filter(p => !q || `${this.label(p)} ${this.describe(p)} ${p.type}`.toLowerCase().includes(q))
            .slice(0, 60)
    }

    label (p: PartialProfile<Profile>): string {
        return this.panes.profileLabel(p)
    }

    describe (p: PartialProfile<Profile>): string {
        return this.profilesService.getDescription(p) ?? ''
    }

    /** Enter: 일치하는 프로필이 있으면 첫 번째, 없고 주소처럼 보이면 SSH 빠른 연결 */
    onEnter (): void {
        if (this.filtered.length) {
            this.choose(this.filtered[0])
        } else if (this.hostQuery) {
            this.quickConnect('ssh')
        }
    }

    async quickConnect (type: 'ssh' | 'telnet'): Promise<void> {
        let query = this.hostQuery
        if (!query) {
            const ref = this.modal.open(PromptModalComponent)
            ref.componentInstance.prompt = `${type.toUpperCase()} 접속 주소 (예: admin@192.168.1.1:22)`
            ref.componentInstance.value = this.query.trim()
            try {
                query = (await ref.result)?.value?.trim() ?? ''
            } catch {
                return
            }
        }
        if (!query) {
            return
        }
        const profile = this.panes.quickConnectProfile(type, query)
        if (profile) {
            await this.choose(profile)
        }
    }

    async choose (profile: PartialProfile<Profile>): Promise<void> {
        const tab = await this.panes.createProfileTab(profile, this.zoom)
        if (tab) {
            this.panes.replacePane(this, tab)
        }
    }

    async showSelector (): Promise<void> {
        const profile = await this.profilesService.showProfileSelector()
        if (profile) {
            await this.choose(profile)
        }
    }

    /** Tabby 설정 → 프로필 (SSH 프로필 저장: 호스트·계정·키·점프 호스트 등) */
    newProfile (): void {
        this.app.openNewTabRaw({ type: SettingsTabComponent, inputs: { activeTab: 'profiles' } })
    }

    async getRecoveryToken (_options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        return {
            type: 'hagis:empty-pane',
            zoom: this.zoom,
        }
    }
}
