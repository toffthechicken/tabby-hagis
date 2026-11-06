import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AppService, NotificationsService, SplitDirection } from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'
import { HagisLauncherModalComponent, HagisLauncherResult } from '../components/launcherModal.component'
import { HagisSaveWorkspaceModalComponent, HagisSaveWorkspaceResult } from '../components/saveWorkspaceModal.component'
import { zoomPercent } from '../models'
import { pickFile } from '../utils'
import { HagisViewerService } from './viewer.service'
import { HagisWorkspaceService } from './workspace.service'

/** 툴바·명령 팔레트·우클릭 메뉴에서 공통으로 쓰는 hagis 동작 */
@Injectable({ providedIn: 'root' })
export class HagisActionsService {
    constructor (
        private app: AppService,
        private modal: NgbModal,
        private notifications: NotificationsService,
        private workspaces: HagisWorkspaceService,
        private viewer: HagisViewerService,
    ) { }

    async openLauncher (): Promise<void> {
        const ref = this.modal.open(HagisLauncherModalComponent, { size: 'xl' })
        let result: HagisLauncherResult
        try {
            result = await ref.result
        } catch {
            return // 닫기
        }
        await this.handle(result)
    }

    private async handle (result: HagisLauncherResult): Promise<void> {
        switch (result.action) {
            case 'open-workspace':
                await this.workspaces.openWorkspace(result.workspace)
                break
            case 'open-preset':
                await this.workspaces.openPreset(result.preset)
                break
            case 'save':
                await this.saveCurrent()
                break
            case 'compact':
                await this.setCompact(result.enabled)
                break
            case 'zoom-all':
                this.zoomAll(result.zoom)
                break
            case 'add-web':
                await this.addWebPane()
                break
            case 'add-empty':
                await this.addEmptyPane()
                break
            case 'add-markdown':
                await this.addMarkdownPane()
                break
            case 'settings':
                this.openSettings()
                break
        }
    }

    async saveCurrent (): Promise<void> {
        if (!await this.workspaces.captureActive()) {
            this.notifications.error('hagis: 저장할 분할 화면이 없습니다. 터미널 탭을 선택한 뒤 다시 시도하세요.')
            return
        }
        const ref = this.modal.open(HagisSaveWorkspaceModalComponent)
        ref.componentInstance.workspaces = this.workspaces.workspaces
        ref.componentInstance.suggestedName = this.app.activeTab?.customTitle || this.app.activeTab?.title || ''
        let info: HagisSaveWorkspaceResult
        try {
            info = await ref.result
        } catch {
            return
        }
        await this.workspaces.saveActiveAs(info)
    }

    async setCompact (enabled: boolean): Promise<void> {
        await this.workspaces.setCompactMode(enabled)
        this.notifications.notice(`hagis: 컴팩트 모드 ${enabled ? '켜짐' : '꺼짐'}`)
    }

    async toggleCompact (): Promise<void> {
        await this.setCompact(!this.workspaces.compactMode)
    }

    zoomAll (zoom: number): void {
        this.workspaces.setZoomForAll(zoom)
        this.notifications.notice(`hagis: 현재 화면의 모든 패널 글자 크기 ${zoomPercent(zoom)}%`)
    }

    async addWebPane (side: SplitDirection = 'r', url = ''): Promise<void> {
        await this.workspaces.addPaneToActive(this.workspaces.createWebPane(url), side)
    }

    async addEmptyPane (side: SplitDirection = 'r'): Promise<void> {
        await this.workspaces.addPaneToActive(this.workspaces.createPlaceholder(), side)
    }

    /** 문서(HWP·Word·Excel·PowerPoint·PDF 등)를 골라 뷰어 패널로 연다 */
    async openDocument (side: SplitDirection = 'r', filePath?: string): Promise<void> {
        const file = filePath ?? await pickFile('문서 열기', [
            { name: '문서 (HWP·Word·Excel·PowerPoint·PDF·텍스트·그림)', extensions: this.viewer.extensions },
            { name: '모든 파일', extensions: ['*'] },
        ])
        if (!file) {
            return
        }
        try {
            await this.addWebPane(side, await this.viewer.prepare(file))
        } catch (e: any) {
            this.notifications.error('hagis: 문서를 열지 못했습니다', String(e?.message ?? e))
        }
    }

    async addMarkdownPane (side: SplitDirection = 'r'): Promise<void> {
        await this.workspaces.addPaneToActive(this.workspaces.createMarkdownPane('', true), side)
    }

    openSettings (): void {
        this.app.openNewTabRaw({ type: SettingsTabComponent, inputs: { activeTab: 'hagis' } })
    }
}
