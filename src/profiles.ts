import { Component, Injectable } from '@angular/core'
import { BaseTabComponent, NewTabParameters, PartialProfile, Profile, ProfileProvider, ProfileSettingsComponent } from 'tabby-core'
import { HagisMarkdownTabComponent } from './components/markdownTab.component'
import { HagisWebTabComponent } from './components/webTab.component'

/**
 * hagis 패널을 Tabby "프로필"로 등록한다.
 * → Tabby 상단 + 버튼(프로필 선택), 빈 패널 목록, 프로필 설정에 "웹 GUI", "Markdown 뷰어"가 나타난다.
 * 고객사별로 "FortiGate GUI (https://10.0.0.1)" 같은 웹 프로필을 저장해 둘 수도 있다.
 */

export interface HagisWebProfile extends Profile {
    options: { url: string }
}

export interface HagisMarkdownProfile extends Profile {
    options: { path: string }
}

@Component({
    template: `
<div class="form-group">
    <label>관리 페이지 주소</label>
    <input class="form-control" type="text" [(ngModel)]="profile.options.url" placeholder="예: https://192.168.1.99">
    <small class="form-text text-muted">이 프로필을 열면 웹 GUI 패널에 이 주소가 열립니다.</small>
</div>
`,
})
export class HagisWebProfileSettingsComponent implements ProfileSettingsComponent<HagisWebProfile> {
    profile: any
}

@Component({
    template: `
<div class="form-group">
    <label>파일 경로</label>
    <input class="form-control" type="text" [(ngModel)]="profile.options.path" placeholder="예: D:\\docs\\점검표.md (비우면 열 때 파일 선택)">
</div>
`,
})
export class HagisMarkdownProfileSettingsComponent implements ProfileSettingsComponent<HagisMarkdownProfile> {
    profile: any
}

@Injectable()
export class HagisWebProfileProvider extends ProfileProvider<HagisWebProfile> {
    id = 'hagis-web'
    name = '웹 GUI (hagis)'
    settingsComponent = HagisWebProfileSettingsComponent as any
    configDefaults = { options: { url: '' } }

    async getBuiltinProfiles (): Promise<PartialProfile<HagisWebProfile>[]> {
        return [{
            id: 'hagis-web:blank',
            type: 'hagis-web',
            name: '웹 GUI',
            icon: 'fas fa-globe',
            isBuiltin: true,
            weight: -2,
            options: { url: '' },
        }]
    }

    async getNewTabParameters (profile: HagisWebProfile): Promise<NewTabParameters<BaseTabComponent>> {
        const url = profile.options?.url ?? ''
        return {
            type: HagisWebTabComponent,
            inputs: { url, paneTitle: url && !profile.isBuiltin ? profile.name : '' },
        }
    }

    getDescription (profile: PartialProfile<HagisWebProfile>): string {
        return profile.options?.url || '주소를 직접 입력'
    }
}

@Injectable()
export class HagisMarkdownProfileProvider extends ProfileProvider<HagisMarkdownProfile> {
    id = 'hagis-markdown'
    name = 'Markdown 뷰어 (hagis)'
    settingsComponent = HagisMarkdownProfileSettingsComponent as any
    configDefaults = { options: { path: '' } }

    async getBuiltinProfiles (): Promise<PartialProfile<HagisMarkdownProfile>[]> {
        return [{
            id: 'hagis-markdown:open',
            type: 'hagis-markdown',
            name: 'Markdown 뷰어',
            icon: 'fab fa-markdown',
            isBuiltin: true,
            weight: -1,
            options: { path: '' },
        }]
    }

    async getNewTabParameters (profile: HagisMarkdownProfile): Promise<NewTabParameters<BaseTabComponent>> {
        const path = profile.options?.path ?? ''
        return {
            type: HagisMarkdownTabComponent,
            inputs: { path, autoPick: !path },
        }
    }

    getDescription (profile: PartialProfile<HagisMarkdownProfile>): string {
        return profile.options?.path || '.md 파일 열기'
    }
}
