import { Injectable } from '@angular/core'
import {
    BaseTabComponent, Command, CommandContext, CommandLocation, CommandProvider, MenuItemOptions,
    NewTabParameters, RecoveryToken, SplitTabComponent, TabContextMenuItemProvider, TabRecoveryProvider,
} from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { HagisPlaceholderTabComponent } from './components/placeholderTab.component'
import { HagisSettingsTabComponent } from './components/settingsTab.component'
import { HagisWebTabComponent } from './components/webTab.component'
import { HAGIS_ICON } from './icons'
import { ZOOM_PRESETS, zoomPercent } from './models'
import { HagisActionsService } from './services/actions.service'
import { HagisPaneChromeService } from './services/paneChrome.service'
import { HagisMarkdownTabComponent } from './components/markdownTab.component'
import { HagisWorkspaceService } from './services/workspace.service'
import { HagisDockService } from './services/dock.service'
import { HagisCaptureService } from './services/capture.service'
import { HagisUpdateService } from './services/update.service'

/** 툴바 버튼 + 명령 팔레트 (Ctrl+Shift+P) 항목 */
@Injectable()
export class HagisCommandProvider extends CommandProvider {
    constructor (
        private actions: HagisActionsService,
        private workspaces: HagisWorkspaceService,
        private dock: HagisDockService,
        private capture: HagisCaptureService,
        private updates: HagisUpdateService,
    ) {
        super()
    }

    /** 선택된 패널의 내용 복사·저장·화면 캡처 (명령 팔레트) */
    private captureCommands (): Command[] {
        const pane = this.capture.activePane()
        const run = (fn: (tab: BaseTabComponent) => unknown) => async () => {
            const tab = this.capture.activePane()
            if (tab) {
                await fn(tab)
            }
        }
        const commands: Command[] = []
        if (pane && this.capture.isTerminal(pane)) {
            commands.push(
                { id: 'hagis:copy-screen', label: 'hagis: 터미널 보이는 화면 복사', run: run(t => this.capture.copyText(t, 'screen')) },
                { id: 'hagis:copy-last', label: 'hagis: 터미널 최근 100줄 복사', run: run(t => this.capture.copyText(t, 'last')) },
                { id: 'hagis:copy-all', label: 'hagis: 터미널 전체 내용 복사 (스크롤백 포함)', run: run(t => this.capture.copyText(t, 'all')) },
                { id: 'hagis:save-text', label: 'hagis: 터미널 전체 내용을 텍스트 파일로 저장', run: run(t => this.capture.saveText(t)) },
            )
        }
        if (pane) {
            commands.push(
                { id: 'hagis:capture-copy', label: 'hagis: 패널 화면 캡처 → 클립보드', run: run(t => this.capture.copyImage(t)) },
                { id: 'hagis:capture-save', label: 'hagis: 패널 화면 캡처 → PNG 저장', run: run(t => this.capture.saveImage(t)) },
            )
        }
        return commands
    }

    async provide (_context: CommandContext): Promise<Command[]> {
        const commands: Command[] = [
            {
                id: 'hagis:launcher',
                label: 'hagis — 워크스페이스',
                sublabel: '고객사 워크스페이스·레이아웃 프리셋 열기',
                icon: HAGIS_ICON,
                weight: -5,
                locations: [CommandLocation.LeftToolbar, CommandLocation.StartPage],
                run: () => this.actions.openLauncher(),
            },
            {
                id: 'hagis:save',
                label: 'hagis: 현재 화면을 워크스페이스로 저장',
                run: () => this.actions.saveCurrent(),
            },
            {
                id: 'hagis:compact',
                label: `hagis: 컴팩트 모드 ${this.workspaces.compactMode ? '끄기' : '켜기'}`,
                run: () => this.actions.toggleCompact(),
            },
            {
                id: 'hagis:add-web',
                label: 'hagis: 웹 GUI 패널 추가 (오른쪽)',
                run: () => this.actions.addWebPane('r'),
            },
            {
                id: 'hagis:add-empty',
                label: 'hagis: 빈 패널 추가 (오른쪽)',
                run: () => this.actions.addEmptyPane('r'),
            },
            {
                id: 'hagis:add-markdown',
                label: 'hagis: Markdown 파일 열기 (오른쪽)',
                run: () => this.actions.addMarkdownPane('r'),
            },
            {
                id: 'hagis:settings',
                label: 'hagis: 설정',
                run: async () => this.actions.openSettings(),
            },
            ...this.captureCommands(),
            {
                id: 'hagis:update',
                label: this.updates.pendingVersion ? `hagis: v${this.updates.pendingVersion} 설치됨 — Tabby 재시작하면 적용` : 'hagis: 업데이트 확인',
                run: async () => {
                    await this.updates.checkNow()
                    await this.updates.installLatest()
                },
            },
            {
                id: 'hagis:dock',
                label: `hagis: 독 ${this.dock.enabled ? '숨기기' : '보이기'}`,
                run: () => this.dock.setEnabled(!this.dock.enabled),
            },
            {
                id: 'hagis:dock-collapse',
                label: `hagis: 독 ${this.dock.collapsed ? '펴기' : '접기'}`,
                run: () => this.dock.setCollapsed(!this.dock.collapsed),
            },
        ]
        for (const preset of ZOOM_PRESETS) {
            commands.push({
                id: `hagis:zoom-all-${preset.label}`,
                label: `hagis: 모든 패널 글자 크기 ${preset.label} (${zoomPercent(preset.zoom)}%)`,
                run: async () => this.actions.zoomAll(preset.zoom),
            })
        }
        for (const ws of this.workspaces.workspaces) {
            commands.push({
                id: `hagis:open:${ws.id}`,
                label: `hagis: 열기 — ${ws.customer ? ws.customer + ' · ' : ''}${ws.name}`,
                run: async () => { await this.workspaces.openWorkspace(ws) },
            })
        }
        return commands
    }
}

/** 패널·탭 우클릭 메뉴 */
@Injectable()
export class HagisContextMenuProvider extends TabContextMenuItemProvider {
    weight = 5

    constructor (
        private actions: HagisActionsService,
        private chrome: HagisPaneChromeService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tabHeader && tab instanceof SplitTabComponent) {
            return [{
                label: 'hagis',
                submenu: [
                    { label: '워크스페이스로 저장…', click: () => this.actions.saveCurrent() },
                    { type: 'separator' },
                    ...ZOOM_PRESETS.map(p => ({
                        label: `모든 패널 글자 ${p.label} (${zoomPercent(p.zoom)}%)`,
                        click: () => this.actions.zoomAll(p.zoom),
                    })),
                ],
            }]
        }
        if (tabHeader || !(tab.parent instanceof SplitTabComponent)) {
            return []
        }
        // 네임태그 우클릭·☰ 버튼과 같은 패널 메뉴
        return [{
            label: 'hagis',
            submenu: [
                ...await this.chrome.buildPaneMenu(tab),
                { type: 'separator' },
                { label: '현재 화면을 워크스페이스로 저장…', click: () => this.actions.saveCurrent() },
            ],
        }]
    }
}

/** 웹 패널·빈 패널을 Tabby 재시작 후에도 복원 */
@Injectable()
export class HagisRecoveryProvider extends TabRecoveryProvider<BaseTabComponent> {
    async applicableTo (token: RecoveryToken): Promise<boolean> {
        return ['hagis:web-tab', 'hagis:empty-pane', 'hagis:markdown-tab'].includes(token.type)
    }

    async recover (token: RecoveryToken): Promise<NewTabParameters<BaseTabComponent>> {
        if (token.type === 'hagis:markdown-tab') {
            return {
                type: HagisMarkdownTabComponent,
                inputs: { path: token.path ?? '', fontSize: token.fontSize ?? 14 },
            }
        }
        if (token.type === 'hagis:web-tab') {
            return {
                type: HagisWebTabComponent,
                inputs: { url: token.url ?? '', paneTitle: token.paneTitle ?? '', zoomFactor: token.zoomFactor ?? 1 },
            }
        }
        return {
            type: HagisPlaceholderTabComponent,
            inputs: { paneTitle: token.paneTitle ?? '', zoom: token.zoom ?? 0 },
        }
    }
}

@Injectable()
export class HagisSettingsTabProvider extends SettingsTabProvider {
    id = 'hagis'
    icon = 'th-large'
    title = 'hagis'

    getComponentType (): any {
        return HagisSettingsTabComponent
    }
}
