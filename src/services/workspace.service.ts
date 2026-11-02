import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, NotificationsService, SplitContainer, SplitDirection, SplitTabComponent, TabsService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { HagisLayoutNode, HagisPaneNode, HagisPreset, HagisWorkspace, isSplit, newId } from '../models'
import { HagisPaneService } from './pane.service'
import { HagisResumeService } from './resume.service'
import { HagisWebTabComponent } from '../components/webTab.component'
import { HagisPlaceholderTabComponent } from '../components/placeholderTab.component'
import { HagisMarkdownTabComponent } from '../components/markdownTab.component'

/**
 * 워크스페이스 = 고객사별로 저장한 화면 레이아웃 + 장비 접속 목록
 *
 * Tabby의 SplitTabComponent / SplitContainer를 그대로 사용한다.
 * 레이아웃 트리를 SplitContainer 트리로 만든 뒤 SplitTabComponent.add() 로 한 번에 붙인다.
 */
@Injectable({ providedIn: 'root' })
export class HagisWorkspaceService {
    /** 컴팩트 모드를 켜기 전 패널별 글자 크기 (끌 때 복원) */
    private zoomBeforeCompact = new WeakMap<BaseTabComponent, number>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private tabs: TabsService,
        private panes: HagisPaneService,
        private notifications: NotificationsService,
        private resume: HagisResumeService,
    ) { }

    // ---------------------------------------------------------------- 저장소

    get workspaces (): HagisWorkspace[] {
        return this.config.store?.hagis?.workspaces ?? []
    }

    private async writeWorkspaces (list: HagisWorkspace[]): Promise<void> {
        this.config.store.hagis.workspaces = list
        await this.config.save()
    }

    async upsertWorkspace (workspace: HagisWorkspace): Promise<void> {
        const list = this.workspaces.filter(x => x.id !== workspace.id)
        list.push({ ...workspace, updatedAt: new Date().toISOString() })
        list.sort((a, b) => `${a.customer ?? ''}/${a.name}`.localeCompare(`${b.customer ?? ''}/${b.name}`))
        await this.writeWorkspaces(list)
    }

    async deleteWorkspace (id: string): Promise<void> {
        await this.writeWorkspaces(this.workspaces.filter(x => x.id !== id))
    }

    async duplicateWorkspace (workspace: HagisWorkspace): Promise<HagisWorkspace> {
        const now = new Date().toISOString()
        const copy: HagisWorkspace = {
            ...JSON.parse(JSON.stringify(workspace)),
            id: newId(),
            name: `${workspace.name} (복사본)`,
            createdAt: now,
            updatedAt: now,
        }
        await this.upsertWorkspace(copy)
        return copy
    }

    /** 고객사별로 묶은 목록 */
    groupedWorkspaces (filter = ''): { customer: string, items: HagisWorkspace[] }[] {
        const q = filter.trim().toLowerCase()
        const groups = new Map<string, HagisWorkspace[]>()
        for (const ws of this.workspaces) {
            if (q && !`${ws.customer ?? ''} ${ws.name} ${ws.description ?? ''}`.toLowerCase().includes(q)) {
                continue
            }
            const key = ws.customer?.trim() || '(고객사 미지정)'
            groups.set(key, [...groups.get(key) ?? [], ws])
        }
        return [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([customer, items]) => ({ customer, items }))
    }

    exportWorkspaces (): string {
        return JSON.stringify({ format: 'hagis-workspaces', version: 1, workspaces: this.workspaces }, null, 2)
    }

    async importWorkspaces (json: string): Promise<number> {
        const data = JSON.parse(json)
        const list: HagisWorkspace[] = Array.isArray(data) ? data : data?.workspaces
        if (!Array.isArray(list)) {
            throw new Error('hagis 워크스페이스 JSON 형식이 아닙니다')
        }
        let count = 0
        for (const ws of list) {
            if (!ws?.name || !ws.layout) {
                continue
            }
            await this.upsertWorkspace({
                ...ws,
                id: this.workspaces.some(x => x.id === ws.id) ? newId() : ws.id ?? newId(),
                createdAt: ws.createdAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            })
            count++
        }
        return count
    }

    // ---------------------------------------------------------------- 열기

    async openWorkspace (workspace: HagisWorkspace): Promise<SplitTabComponent> {
        const title = workspace.customer ? `${workspace.customer} · ${workspace.name}` : workspace.name
        return this.openLayout(workspace.layout, title)
    }

    async openPreset (preset: HagisPreset): Promise<SplitTabComponent> {
        return this.openLayout(preset.layout, preset.name)
    }

    async openLayout (layout: HagisLayoutNode, title: string): Promise<SplitTabComponent> {
        const split = this.tabs.create({ type: SplitTabComponent })
        const root = await this.build(layout)
        const added = split.add(root, null, 'r')
        this.app.addTabRaw(split)
        await added
        split.customTitle = title
        split.layout()
        return split
    }

    private async build (node: HagisLayoutNode): Promise<BaseTabComponent|SplitContainer> {
        if (isSplit(node)) {
            const container = new SplitContainer()
            container.orientation = node.orientation
            for (const child of node.children) {
                container.children.push(await this.build(child))
            }
            const ratios = node.ratios?.length === container.children.length
                ? [...node.ratios]
                : container.children.map(() => 1)
            const sum = ratios.reduce((a, b) => a + b, 0) || 1
            container.ratios = ratios.map(x => x / sum)
            return container
        }
        return this.buildPane(node)
    }

    private async buildPane (node: HagisPaneNode): Promise<BaseTabComponent> {
        const tab = await this.buildPaneTab(node)
        // 네임태그 이름·색 (Tabby customTitle / color)
        if (node.title && node.title !== tab.title) {
            tab.customTitle = node.title
        }
        if (node.color) {
            tab.color = node.color
        }
        if (node.stage) {
            (tab as any).hagisStage = node.stage
        }
        return tab
    }

    private async buildPaneTab (node: HagisPaneNode): Promise<BaseTabComponent> {
        if (node.kind === 'profile') {
            let profile = await this.panes.findProfile(node.profileId, node.profile)
            if (profile) {
                // 저장 당시 작업 폴더에서 열고, 실행 중이던 프로그램은 이어가기 명령으로 다시 실행
                if (node.cwd && profile.type === 'local') {
                    profile = { ...profile, options: { ...profile.options ?? {}, cwd: node.cwd } }
                }
                const tab = await this.panes.createProfileTab(profile, node.zoom, {
                    hagisResume: node.startupPinned || node.resume || undefined,
                    hagisStartup: node.startupPinned || undefined,
                })
                if (tab) {
                    return tab
                }
            } else {
                this.notifications.error(`hagis: 프로필을 찾을 수 없습니다 — ${node.title ?? node.profileId}`)
            }
            return this.createPlaceholder(node.zoom)
        }
        if (node.kind === 'web') {
            return this.createWebPane(node.url, node.zoomFactor)
        }
        if (node.kind === 'markdown') {
            return this.createMarkdownPane(node.path)
        }
        return this.createPlaceholder(node.zoom)
    }

    createPlaceholder (zoom?: number): BaseTabComponent {
        return this.tabs.create({ type: HagisPlaceholderTabComponent, inputs: { zoom: zoom ?? 0 } })
    }

    createWebPane (url = '', zoomFactor?: number): BaseTabComponent {
        return this.tabs.create({ type: HagisWebTabComponent, inputs: { url, zoomFactor: zoomFactor ?? 1 } })
    }

    createMarkdownPane (path = '', autoPick = false): BaseTabComponent {
        return this.tabs.create({ type: HagisMarkdownTabComponent, inputs: { path, autoPick } })
    }

    /** 현재 포커스된 패널 옆에 새 패널을 붙인다. 분할 탭이 없으면 새 탭으로 연다 */
    async addPaneToActive (tab: BaseTabComponent, side: SplitDirection = 'r'): Promise<void> {
        const split = this.panes.getActiveSplit()
        if (!split) {
            this.app.wrapAndAddTab(tab)
            return
        }
        await split.addTab(tab, split.getFocusedTab(), side)
    }

    // ---------------------------------------------------------------- 저장 (현재 화면 → 레이아웃)

    async captureActive (): Promise<HagisLayoutNode|null> {
        const split = this.panes.getActiveSplit()
        if (!split) {
            return null
        }
        return this.capture(split.root)
    }

    private async capture (node: BaseTabComponent|SplitContainer): Promise<HagisLayoutNode> {
        if (node instanceof SplitContainer) {
            return this.captureContainer(node)
        }
        const pane = await this.capturePane(node)
        // 네임태그 이름·색, 메인 무대 역할
        return {
            ...pane,
            title: node.customTitle || (pane as any).title || undefined,
            color: node.color || undefined,
            stage: (node as any).hagisStage || undefined,
        } as HagisPaneNode
    }

    private async captureContainer (node: SplitContainer): Promise<HagisLayoutNode> {
        const children: HagisLayoutNode[] = []
        for (const child of node.children) {
            children.push(await this.capture(child))
        }
        return {
            kind: 'split',
            orientation: node.orientation,
            ratios: node.ratios.map(r => Math.round(r * 10000) / 10000),
            children,
        }
    }

    private async capturePane (node: BaseTabComponent): Promise<HagisPaneNode> {
        if (node instanceof HagisWebTabComponent) {
            return {
                kind: 'web',
                url: node.getCurrentUrl(),
                title: node.paneTitle || undefined,
                zoomFactor: node.zoomFactor !== 1 ? node.zoomFactor : undefined,
            }
        }
        if (node instanceof HagisMarkdownTabComponent) {
            return { kind: 'markdown', path: node.path }
        }
        if (node instanceof HagisPlaceholderTabComponent) {
            return { kind: 'empty', zoom: node.zoom || undefined }
        }
        if (node instanceof BaseTerminalTabComponent && node.profile) {
            const profile = JSON.parse(JSON.stringify(node.profile))
            const stored = await this.panes.findProfile(profile.id)
            const session: any = node.session
            let cwd: string|undefined
            if (profile.type === 'local' && session?.getWorkingDirectory) {
                cwd = await session.getWorkingDirectory().catch(() => null) ?? undefined
            }
            const pinned = this.resume.getPinned(node)
            return {
                kind: 'profile',
                profileId: profile.id,
                // 설정에 저장되지 않은 프로필(빠른 연결 등)은 사본을 함께 보관
                profile: stored ? undefined : this.stripProfile(profile),
                zoom: node.zoom || undefined,
                cwd,
                resume: pinned ? undefined : await this.resume.detect(node).catch(() => null) ?? undefined,
                startupPinned: pinned || undefined,
            }
        }
        return { kind: 'empty', title: node.title }
    }

    /** 레이아웃에 보관하는 프로필 사본에서 비밀번호 등 민감 정보 제거 */
    private stripProfile (profile: any): any {
        const copy = { ...profile, options: { ...profile.options ?? {} } }
        for (const key of ['password', 'passphrase', 'privateKeyPassphrase']) {
            delete copy.options[key]
        }
        delete copy.options.restoreFromPTYID
        return copy
    }

    async saveActiveAs (info: { id?: string, name: string, customer?: string, description?: string }): Promise<HagisWorkspace|null> {
        const layout = await this.captureActive()
        if (!layout) {
            this.notifications.error('hagis: 저장할 분할 화면이 없습니다')
            return null
        }
        const existing = info.id ? this.workspaces.find(x => x.id === info.id) : null
        const now = new Date().toISOString()
        const workspace: HagisWorkspace = {
            id: existing?.id ?? newId(),
            name: info.name,
            customer: info.customer || undefined,
            description: info.description || undefined,
            layout,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        }
        await this.upsertWorkspace(workspace)
        const split = this.panes.getActiveSplit()
        if (split) {
            split.customTitle = workspace.customer ? `${workspace.customer} · ${workspace.name}` : workspace.name
        }
        this.notifications.info(`hagis: "${workspace.name}" 워크스페이스를 저장했습니다`)
        return workspace
    }

    // ---------------------------------------------------------------- 글자 크기 / 컴팩트 모드

    setZoomForAll (zoom: number, split = this.panes.getActiveSplit()): void {
        for (const tab of this.panes.getTerminalTabs(split)) {
            this.panes.setZoom(tab, zoom)
        }
        for (const tab of split?.getAllTabs() ?? []) {
            if (tab instanceof HagisPlaceholderTabComponent) {
                tab.zoom = zoom
            }
        }
    }

    get compactMode (): boolean {
        return !!this.config.store?.hagis?.compactMode
    }

    async setCompactMode (enabled: boolean): Promise<void> {
        this.config.store.hagis.compactMode = enabled
        await this.config.save()
        const allTerminals = this.app.tabs
            .filter(t => t instanceof SplitTabComponent)
            .flatMap(t => this.panes.getTerminalTabs(t as SplitTabComponent))
        for (const tab of allTerminals) {
            if (enabled) {
                this.applyCompactZoom(tab)
            } else if (this.zoomBeforeCompact.has(tab)) {
                this.panes.setZoom(tab, this.zoomBeforeCompact.get(tab)!)
                this.zoomBeforeCompact.delete(tab)
            }
        }
    }

    /** 컴팩트 모드에서 새로 열린 터미널에도 작은 글자 크기를 적용 */
    applyCompactZoom (tab: BaseTerminalTabComponent<any>): void {
        const compactZoom = this.config.store?.hagis?.compactZoom ?? -2
        if (tab.zoom > compactZoom && !this.zoomBeforeCompact.has(tab)) {
            this.zoomBeforeCompact.set(tab, tab.zoom)
            this.panes.setZoom(tab, compactZoom)
        }
    }
}
