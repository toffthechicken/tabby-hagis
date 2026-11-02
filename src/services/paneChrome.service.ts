import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, MenuItemOptions, NotificationsService, PlatformService, SplitDirection, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { PromptModalComponent, TabsService } from 'tabby-core'
import { HagisMarkdownTabComponent } from '../components/markdownTab.component'
import { HagisPlaceholderTabComponent } from '../components/placeholderTab.component'
import { HagisWebTabComponent } from '../components/webTab.component'
import { DEFAULT_TAG_COLOR, TAG_COLORS, ZOOM_PRESETS, zoomPercent } from '../models'
import { HagisCornerResizeService } from './cornerResize.service'
import { HagisPaneService } from './pane.service'
import { HagisResumeService } from './resume.service'
import { HagisCaptureService, LAST_LINES } from './capture.service'
import { HagisStageService, MAX_PREVIEWS } from './stage.service'

interface PaneChrome {
    head: HTMLElement
    tag: HTMLElement
    zoomValue?: HTMLElement
    refreshZoom?: () => void
    /** 미리보기 패널 위에 덮는 클릭 영역 (터미널·Markdown) */
    shield?: HTMLElement
}

type DropZone = { kind: 'pane', target: BaseTabComponent, side: SplitDirection | 'swap' } | { kind: 'new-tab' }

/** 폭에 따라 글자 크기 컨트롤을 접는 기준 (px) */
const ZOOM_FULL_WIDTH = 380
const ZOOM_MID_WIDTH = 230

/**
 * 분할 패널마다 좌측 상단에 붙는 "패널 크롬"
 *  - 형광 네임태그: 드래그 → 패널 이동/자리 바꾸기/탭 바에 놓으면 새 탭으로 분리
 *                  우클릭 → 이름 변경·색상·최대화·닫기, 더블클릭 → 이름 변경
 *  - 글자 크기 컨트롤(터미널): 태그 오른쪽, 마우스를 올리면 표시. 패널 폭에 맞춰 자동으로 접힘
 *
 * 터미널·웹·Markdown·빈 패널 모두 같은 방식으로 붙인다. 컴포넌트에 .hagis-tag-slot 이 있으면 그 안에 넣는다.
 */
@Injectable({ providedIn: 'root' })
export class HagisPaneChromeService {
    private chromes = new WeakMap<BaseTabComponent, PaneChrome>()
    private watchedSplits = new WeakSet<SplitTabComponent>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private panes: HagisPaneService,
        private corners: HagisCornerResizeService,
        private resume: HagisResumeService,
        private stage: HagisStageService,
        private modal: NgbModal,
        private tabs: TabsService,
        private notifications: NotificationsService,
        private capture: HagisCaptureService,
    ) { }

    init (): void {
        this.app.tabOpened$.subscribe(() => this.scan())
        this.app.tabsChanged$.subscribe(() => this.scan())
        this.stage.changed$.subscribe(({ tab }) => {
            const split = tab.parent
            if (split instanceof SplitTabComponent) {
                setTimeout(() => this.refreshSplit(split))
            }
        })
        this.config.ready$.subscribe(() => {
            this.scan()
            this.config.changed$.subscribe(() => this.scan())
        })
    }

    private scan (): void {
        for (const tab of this.app.tabs) {
            if (tab instanceof SplitTabComponent) {
                this.watch(tab)
                this.refreshSplit(tab)
            }
        }
    }

    private watch (split: SplitTabComponent): void {
        if (this.watchedSplits.has(split)) {
            return
        }
        this.watchedSplits.add(split)
        const refresh = () => setTimeout(() => this.refreshSplit(split))
        split.subscribeUntilDestroyed(split.initialized$, refresh)
        split.subscribeUntilDestroyed(split.tabAdded$, refresh)
        split.subscribeUntilDestroyed(split.tabRemoved$, removed => {
            refresh()
            // 미리보기를 닫으면 남은 미리보기로 빈자리를 고르게 채운다 (끌어서 옮기는 중이면 그대로 둔다)
            if (this.stage.role(removed) === 'preview') {
                setTimeout(() => {
                    if (!split.getAllTabs().includes(removed) && this.stage.findMain(split)) {
                        this.stage.arrange(split)
                    }
                }, 50)
            }
        })
        split.subscribeUntilDestroyed(split.tabAdopted$, refresh)
        split.subscribeUntilDestroyed(split.focusChanged$, refresh)
        split.subscribeUntilDestroyed(split.splitAdjusted$, refresh)
    }

    refreshSplit (split: SplitTabComponent): void {
        const tabs = split.getAllTabs()
        const tagged = tabs.length > 1 && (this.config.store?.hagis?.paneTags ?? true)
        for (const tab of tabs) {
            const host = this.panes.hostElement(tab)
            if (!host) {
                continue
            }
            const chrome = this.ensureChrome(tab, host)
            if (tab instanceof BaseTerminalTabComponent) {
                // 복원·워크스페이스로 넘어온 이어가기 명령 실행 (탭이 화면에 보이지 않아도)
                this.resume.attach(tab)
            }
            host.classList.toggle('hagis-tagged', tagged)
            this.placeHead(host, chrome)
            this.updateTag(tab, chrome)
            this.updateShield(tab, host, chrome)
        }
        this.corners.refresh(split)
    }

    /**
     * 미리보기 패널(터미널·Markdown)은 투명한 막을 덮어 보기 전용으로 만들고, 클릭하면 메인으로 올린다.
     * 웹 패널은 네이티브 뷰라 막이 위에 올라가지 않으므로 컴포넌트가 직접 처리한다. 빈 패널은 그대로 쓸 수 있게 둔다.
     */
    private updateShield (tab: BaseTabComponent, host: HTMLElement, chrome: PaneChrome): void {
        const wanted = this.stage.role(tab) === 'preview'
            && !(tab instanceof HagisWebTabComponent)
            && !(tab instanceof HagisPlaceholderTabComponent)
        if (wanted && !chrome.shield) {
            const shield = document.createElement('div')
            shield.className = 'hagis-stage-shield'
            const hint = document.createElement('span')
            hint.textContent = '클릭 → 메인으로'
            shield.appendChild(hint)
            shield.addEventListener('mousedown', e => {
                e.preventDefault()
                e.stopPropagation()
                if (e.button === 0) {
                    this.stage.promote(tab)
                }
            })
            shield.addEventListener('contextmenu', e => {
                e.preventDefault()
                e.stopPropagation()
                this.showTagMenu(tab, e)
            })
            chrome.shield = shield
        }
        if (chrome.shield) {
            if (wanted && chrome.shield.parentElement !== host) {
                host.appendChild(chrome.shield)
            }
            chrome.shield.style.display = wanted ? '' : 'none'
        }
        host.classList.toggle('hagis-stage-main', this.stage.role(tab) === 'main')
    }

    // ------------------------------------------------------------------ 생성

    private ensureChrome (tab: BaseTabComponent, host: HTMLElement): PaneChrome {
        let chrome = this.chromes.get(tab)
        if (chrome) {
            return chrome
        }
        const head = document.createElement('div')
        head.className = 'hagis-pane-head'

        const tag = document.createElement('span')
        tag.className = 'hagis-tag'
        tag.title = '드래그: 패널 이동 · 우클릭: 이름/색상 · 더블클릭: 이름 변경'
        tag.addEventListener('pointerdown', e => this.onTagPointerDown(tab, e))
        tag.addEventListener('mousedown', e => e.stopPropagation())
        tag.addEventListener('click', e => e.stopPropagation())
        tag.addEventListener('dblclick', e => {
            e.stopPropagation()
            this.startRename(tab)
        })
        tag.addEventListener('contextmenu', e => {
            e.preventDefault()
            e.stopPropagation()
            this.showTagMenu(tab, e)
        })
        head.appendChild(tag)

        // ☰ 패널 메뉴 — Windows 터미널은 우클릭이 복사/붙여넣기라 따로 둔다 (마우스를 올리면 표시)
        const menuButton = document.createElement('button')
        menuButton.className = 'hagis-pane-menu'
        menuButton.textContent = '☰'
        menuButton.title = '패널 메뉴 (SFTP · 다시 연결 · 복제 · 패널 추가 …)'
        menuButton.addEventListener('mousedown', e => e.stopPropagation())
        menuButton.addEventListener('click', e => {
            e.preventDefault()
            e.stopPropagation()
            this.showTagMenu(tab, e)
        })
        head.appendChild(menuButton)

        // ＋ 미리보기 — 메인 패널에만 표시
        const addButton = document.createElement('button')
        addButton.className = 'hagis-stage-add'
        addButton.textContent = '＋ 미리보기'
        addButton.title = '미리보기 추가 (메인 크기는 그대로, 미리보기만 작아짐)'
        addButton.addEventListener('mousedown', e => e.stopPropagation())
        addButton.addEventListener('click', e => {
            e.preventDefault()
            e.stopPropagation()
            this.platform.popupContextMenu([
                { label: '웹 미리보기', click: () => this.addPreview(tab, 'web') },
                { label: '빈 패널 미리보기 (SSH·터미널·md)', click: () => this.addPreview(tab, 'empty') },
                { type: 'separator' },
                { label: '미리보기 다시 정렬', click: () => this.stage.arrange(tab.parent as SplitTabComponent) },
            ], e)
        })
        head.appendChild(addButton)

        chrome = { head, tag }
        if (tab instanceof BaseTerminalTabComponent) {
            this.createZoomControls(tab, chrome, host)
        }
        tab.subscribeUntilDestroyed(tab.titleChange$, () => this.updateTag(tab, chrome!))
        this.chromes.set(tab, chrome)
        return chrome
    }

    /** 컴포넌트에 태그 자리(.hagis-tag-slot)가 있으면 그 안에, 없으면 패널 위에 띄운다 */
    private placeHead (host: HTMLElement, chrome: PaneChrome): void {
        const slot = host.querySelector('.hagis-tag-slot')
        const parent = slot ?? host
        chrome.head.classList.toggle('hagis-pane-head-inline', !!slot)
        if (chrome.head.parentElement !== parent) {
            parent.appendChild(chrome.head)
        }
    }

    private updateTag (tab: BaseTabComponent, chrome: PaneChrome): void {
        if (chrome.tag.querySelector('input')) {
            return // 이름 편집 중
        }
        // 바뀐 것만 고친다 (분할 화면 이벤트마다 모든 패널을 다시 그리지 않도록)
        const name = this.panes.paneName(tab)
        if (chrome.tag.textContent !== name) {
            chrome.tag.textContent = name
        }
        const color = tab.color || DEFAULT_TAG_COLOR
        if (chrome.tag.style.getPropertyValue('--hagis-tag-color') !== color) {
            chrome.tag.style.setProperty('--hagis-tag-color', color)
        }
        const role = this.stage.role(tab) ?? ''
        if (chrome.tag.dataset.stage !== role) {
            chrome.tag.dataset.stage = role
        }
        chrome.head.classList.toggle('hagis-head-main', role === 'main')
    }

    private createZoomControls (terminal: BaseTerminalTabComponent<any>, chrome: PaneChrome, host: HTMLElement): void {
        const bar = document.createElement('span')
        bar.className = 'hagis-zoom'

        const button = (label: string, title: string, cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement => {
            const el = document.createElement('button')
            el.textContent = label
            el.title = title
            el.className = cls
            el.addEventListener('mousedown', e => e.stopPropagation())
            el.addEventListener('click', e => {
                e.preventDefault()
                e.stopPropagation()
                onClick(e)
                refresh()
            })
            bar.appendChild(el)
            return el
        }

        button('A−', '글자 작게 (이 패널만)', 'hz-step', () => this.panes.setZoom(terminal, terminal.zoom - 1))
        const value = button('100%', '클릭: 기본 크기(100%)로', 'hz-value', e => {
            if (bar.classList.contains('hz-min')) {
                this.showZoomMenu(terminal, e)
            } else {
                this.panes.setZoom(terminal, 0)
            }
        })
        button('A+', '글자 크게 (이 패널만)', 'hz-step', () => this.panes.setZoom(terminal, terminal.zoom + 1))
        const presets = ZOOM_PRESETS.map(p => ({
            zoom: p.zoom,
            el: button(p.label, `글자 크기 ${zoomPercent(p.zoom)}%`, 'hz-preset', () => this.panes.setZoom(terminal, p.zoom)),
        }))
        const maximize = button('⤢', '이 패널 최대화 / 복원', 'hz-max', () => this.toggleMaximize(terminal))

        const refresh = () => {
            const width = host.clientWidth
            bar.classList.toggle('hz-full', width >= ZOOM_FULL_WIDTH)
            bar.classList.toggle('hz-mid', width < ZOOM_FULL_WIDTH && width >= ZOOM_MID_WIDTH)
            bar.classList.toggle('hz-min', width < ZOOM_MID_WIDTH)
            value.textContent = `${zoomPercent(terminal.zoom)}%`
            value.title = width < ZOOM_MID_WIDTH ? '클릭: 글자 크기 메뉴' : '클릭: 기본 크기(100%)로'
            for (const p of presets) {
                p.el.classList.toggle('active', p.zoom === terminal.zoom)
            }
            const split = terminal.parent
            maximize.classList.toggle('active', split instanceof SplitTabComponent && split.getMaximizedTab() === terminal)
        }
        // 단축키(Ctrl +/-)나 창 크기 변경도 반영되도록 마우스를 올릴 때마다 갱신
        host.addEventListener('mouseenter', refresh)
        refresh()

        chrome.head.appendChild(bar)
        chrome.zoomValue = value
        chrome.refreshZoom = refresh
    }

    // ------------------------------------------------------------------ 메뉴 / 이름

    private async showTagMenu (tab: BaseTabComponent, event: MouseEvent): Promise<void> {
        this.platform.popupContextMenu(await this.buildPaneMenu(tab), event)
    }

    /**
     * 패널 메뉴 — 네임태그 우클릭, ☰ 버튼, 패널 우클릭(hagis 하위 메뉴)에서 공통으로 쓴다
     */
    async buildPaneMenu (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        const split = tab.parent instanceof SplitTabComponent ? tab.parent : null
        const anyTab = tab as any
        const items: MenuItemOptions[] = [
            { label: '이름 변경…', click: () => this.startRename(tab) },
            { label: '원래 이름으로', enabled: !!tab.customTitle, click: () => {
                this.panes.renamePane(tab, '')
                this.refreshTab(tab)
            } },
            {
                label: '태그 색상',
                submenu: TAG_COLORS.map(c => ({
                    label: c.label,
                    type: 'radio' as const,
                    checked: (tab.color || DEFAULT_TAG_COLOR) === c.color,
                    click: () => {
                        this.panes.setPaneColor(tab, c.color === DEFAULT_TAG_COLOR ? null : c.color)
                        this.refreshTab(tab)
                    },
                })),
            },
        ]

        // ---- 접속 관련 (SSH / Telnet / 로컬 터미널)
        const connection: MenuItemOptions[] = []
        if (typeof anyTab.openSFTP === 'function') {
            connection.push({ label: 'SFTP 열기 (파일 전송)', click: () => anyTab.openSFTP() })
        } else if (tab instanceof BaseTerminalTabComponent) {
            // 로컬 터미널에서 직접 ssh 를 실행 중이면 같은 주소로 SFTP 패널을 옆에 연다
            const target = await Promise.race([
                this.resume.detectSshTarget(tab).catch(() => null),
                new Promise<null>(resolve => setTimeout(() => resolve(null), 1500)),
            ])
            if (target) {
                connection.push({ label: `SFTP 열기 → ${target} (옆 패널)`, click: () => this.openSftpBeside(tab, target) })
            }
        }
        if (typeof anyTab.reconnect === 'function') {
            connection.push({ label: '다시 연결', click: () => anyTab.reconnect() })
        }
        if (tab instanceof BaseTerminalTabComponent && anyTab.session?.getWorkingDirectory && tab.profile?.type === 'local') {
            connection.push({
                label: '작업 폴더 열기 (탐색기)',
                click: async () => {
                    const cwd = await anyTab.session.getWorkingDirectory().catch(() => null)
                    if (cwd) {
                        this.platform.openPath(cwd)
                    }
                },
            })
        }
        if (connection.length) {
            items.push({ type: 'separator' }, ...connection)
        }

        // ---- 터미널 설정
        if (tab instanceof BaseTerminalTabComponent) {
            const pinned = this.resume.getPinned(tab)
            items.push(
                { type: 'separator' },
                {
                    label: pinned ? `시작 명령: ${pinned}` : '시작 명령 지정… (재시작 시 자동 실행)',
                    click: () => this.editStartupCommand(tab),
                },
                {
                    label: `글자 크기 (${zoomPercent(tab.zoom)}%)`,
                    submenu: ZOOM_PRESETS.map(p => ({
                        label: `${p.label} — ${zoomPercent(p.zoom)}%`,
                        type: 'radio' as const,
                        checked: tab.zoom === p.zoom,
                        click: () => this.panes.setZoom(tab, p.zoom),
                    })),
                },
            )
        }

        // ---- 내용 복사 · 화면 캡처
        items.push({ type: 'separator' })
        if (this.capture.isTerminal(tab)) {
            items.push({
                label: '터미널 내용 복사 · 저장',
                submenu: [
                    { label: '보이는 화면 복사', click: () => this.capture.copyText(tab, 'screen') },
                    { label: `최근 ${LAST_LINES}줄 복사`, click: () => this.capture.copyText(tab, 'last') },
                    { label: '전체 내용 복사 (스크롤백 포함)', click: () => this.capture.copyText(tab, 'all') },
                    { type: 'separator' },
                    { label: '전체 내용을 텍스트 파일로 저장…', click: () => this.capture.saveText(tab) },
                ],
            })
        }
        items.push({
            label: '화면 캡처',
            submenu: [
                { label: '클립보드로 복사', click: () => this.capture.copyImage(tab) },
                { label: 'PNG 파일로 저장…', click: () => this.capture.saveImage(tab) },
            ],
        })

        // ---- 메인 무대 (미리보기를 클릭하면 메인 자리에 크게)
        const role = this.stage.role(tab)
        const hasMain = !!this.stage.findMain(split)
        const previews = this.stage.previewCount(split)
        items.push(
            { type: 'separator' },
            {
                label: role === 'main' ? '메인 무대 (★ 메인)' : role === 'preview' ? '메인 무대 (미리보기)' : '메인 무대',
                enabled: !!split && split.getAllTabs().length > 1,
                submenu: [
                    { label: '이 패널을 메인으로 + 나머지는 미리보기 (오른쪽 정렬)', click: () => {
                        this.stage.makeStage(tab)
                        this.stage.arrange(tab.parent as SplitTabComponent)
                    } },
                    { type: 'separator' },
                    { label: `미리보기 추가 — 웹 (${previews}/${MAX_PREVIEWS})`, enabled: hasMain, click: () => this.addPreview(tab, 'web') },
                    { label: '미리보기 추가 — 빈 패널 (SSH·터미널·md)', enabled: hasMain, click: () => this.addPreview(tab, 'empty') },
                    { label: '미리보기 다시 정렬 (메인 크기 유지)', enabled: hasMain, click: () => this.stage.arrange(tab.parent as SplitTabComponent) },
                    { type: 'separator' },
                    { label: '이 패널을 메인으로', type: 'radio', checked: role === 'main', click: () => this.stage.setRole(tab, 'main') },
                    { label: '미리보기 (클릭하면 메인과 자리 바꿈)', type: 'radio', checked: role === 'preview', click: () => this.stage.setRole(tab, 'preview') },
                    { label: '일반 패널', type: 'radio', checked: !role, click: () => this.stage.setRole(tab, null) },
                    { type: 'separator' },
                    { label: '이 화면의 메인 무대 모두 해제', click: () => this.stage.clearStage(tab) },
                ],
            },
        )

        // ---- 패널 배치
        const addBeside = (side: 'r' | 'b', create: () => BaseTabComponent) => {
            const created = create()
            // 미리보기 옆에 추가한 패널도 미리보기
            if (role === 'preview') {
                this.stage.assignQuiet(created, 'preview')
            }
            return split?.addTab(created, tab, side).then(() => {
                if (role === 'preview' && split) {
                    this.stage.arrange(split) // 메인 크기는 그대로, 미리보기만 다시 나눈다
                }
            })
        }
        items.push(
            { type: 'separator' },
            { label: '패널 복제 → 오른쪽', enabled: !!split, click: () => this.duplicateBeside(tab) },
            {
                label: '패널 추가',
                enabled: !!split,
                submenu: [
                    { label: '빈 패널 → 오른쪽', click: () => addBeside('r', () => this.tabs.create({ type: HagisPlaceholderTabComponent })) },
                    { label: '빈 패널 → 아래', click: () => addBeside('b', () => this.tabs.create({ type: HagisPlaceholderTabComponent })) },
                    { label: '웹 GUI → 오른쪽', click: () => addBeside('r', () => this.tabs.create({ type: HagisWebTabComponent })) },
                    { label: '웹 GUI → 아래', click: () => addBeside('b', () => this.tabs.create({ type: HagisWebTabComponent })) },
                    { label: 'Markdown → 오른쪽', click: () => addBeside('r', () => this.tabs.create({ type: HagisMarkdownTabComponent, inputs: { autoPick: true } })) },
                ],
            },
            { type: 'separator' },
            {
                label: split?.getMaximizedTab() === tab ? '최대화 해제' : '이 패널 최대화',
                click: () => this.toggleMaximize(tab),
            },
            { label: '새 탭으로 분리', enabled: (split?.getAllTabs().length ?? 0) > 1, click: () => this.detachToNewTab(tab) },
            { label: '패널 닫기', click: () => tab.destroy() },
        )
        return items
    }

    /**
     * 미리보기 추가 — 마지막 미리보기 아래에 붙인 뒤 격자로 다시 배치한다 (메인 크기 유지)
     * 웹: 주소창에 바로 입력 / 빈 패널: SSH·터미널·Markdown 등을 고른다
     */
    async addPreview (anyPaneInSplit: BaseTabComponent, kind: 'web' | 'empty'): Promise<void> {
        const split = anyPaneInSplit.parent
        if (!(split instanceof SplitTabComponent)) {
            return
        }
        const main = this.stage.findMain(split)
        if (!main) {
            this.notifications.info('hagis: 먼저 크게 볼 패널을 메인으로 지정하세요 (☰ → 메인 무대)')
            return
        }
        if (this.stage.previewCount(split) >= MAX_PREVIEWS) {
            this.notifications.info(`hagis: 미리보기는 한 화면에 최대 ${MAX_PREVIEWS}개까지 둘 수 있습니다`)
            return
        }
        const created = kind === 'web'
            ? this.tabs.create({ type: HagisWebTabComponent })
            : this.tabs.create({ type: HagisPlaceholderTabComponent })
        this.stage.assignQuiet(created, 'preview')
        const previews = split.getAllTabs().filter(t => this.stage.role(t) === 'preview')
        await split.addTab(created, previews[previews.length - 1] ?? main, previews.length ? 'b' : 'r')
        this.stage.arrange(split)
        split.focus(created)
        // 새 웹 미리보기는 주소창에 바로 입력할 수 있게
        setTimeout(() => {
            const input = this.panes.hostElement(created)?.querySelector('input') as HTMLInputElement|null
            input?.focus()
        }, 150)
    }

    /** 패널 복제 — 같은 프로필로 새 세션 (이어가기 명령은 복제하지 않는다) */
    private async duplicateBeside (tab: BaseTabComponent): Promise<void> {
        const split = tab.parent
        if (!(split instanceof SplitTabComponent)) {
            return
        }
        const dup = await this.tabs.duplicate(tab)
        if (dup) {
            delete (dup as any).hagisResume
            delete (dup as any).hagisPaneId // 복제본은 새 패널 ID 를 받는다
            if (this.stage.role(dup) === 'main') {
                this.stage.assignQuiet(dup, 'preview') // 메인은 하나만
            }
            await split.addTab(dup, tab, 'r')
        }
    }

    /** 로컬 터미널의 ssh 접속과 같은 주소로 Tabby SSH 패널을 옆에 열고, 연결되면 SFTP 를 띄운다 */
    private async openSftpBeside (tab: BaseTabComponent, target: string): Promise<void> {
        const split = tab.parent
        const profile = this.panes.quickConnectProfile('ssh', target)
        if (!(split instanceof SplitTabComponent) || !profile) {
            return
        }
        const sshTab: any = await this.panes.createProfileTab(profile)
        if (!sshTab) {
            return
        }
        sshTab.customTitle = `SFTP ${target}`
        await split.addTab(sshTab, tab, 'r')
        const started = Date.now()
        while (!sshTab.session?.open && Date.now() - started < 120000) {
            await new Promise(r => setTimeout(r, 500)) // 비밀번호·키 인증을 기다린다
        }
        if (sshTab.session?.open && typeof sshTab.openSFTP === 'function') {
            sshTab.openSFTP()
        }
    }

    private showZoomMenu (terminal: BaseTerminalTabComponent<any>, event: MouseEvent): void {
        this.platform.popupContextMenu([
            { label: '글자 작게', click: () => this.panes.setZoom(terminal, terminal.zoom - 1) },
            { label: '글자 크게', click: () => this.panes.setZoom(terminal, terminal.zoom + 1) },
            { type: 'separator' },
            ...ZOOM_PRESETS.map(p => ({
                label: `${p.label} — ${zoomPercent(p.zoom)}%`,
                type: 'radio' as const,
                checked: terminal.zoom === p.zoom,
                click: () => this.panes.setZoom(terminal, p.zoom),
            })),
            { type: 'separator' },
            { label: '이 패널 최대화 / 복원', click: () => this.toggleMaximize(terminal) },
        ], event)
    }

    /**
     * 이 패널을 다시 열 때(재시작·워크스페이스) 실행할 명령 — 예: claude --continue, ssh 접속 후 실행할 명령
     * 비워 두면 실행 중인 프로그램을 자동 감지한다 (설정 → hagis → 이어가기 규칙)
     */
    private async editStartupCommand (terminal: BaseTerminalTabComponent<any>): Promise<void> {
        const ref = this.modal.open(PromptModalComponent)
        ref.componentInstance.prompt = '이 패널을 다시 열 때 실행할 명령 (비우면 자동 감지 — 예: claude --continue)'
        ref.componentInstance.value = this.resume.getPinned(terminal)
        try {
            const result = await ref.result
            if (result) {
                this.resume.setPinned(terminal, result.value ?? '')
            }
        } catch { }
    }

    private refreshTab (tab: BaseTabComponent): void {
        const chrome = this.chromes.get(tab)
        if (chrome) {
            this.updateTag(tab, chrome)
            chrome.refreshZoom?.()
        }
    }

    private toggleMaximize (tab: BaseTabComponent): void {
        const split = tab.parent
        if (split instanceof SplitTabComponent) {
            split.maximize(split.getMaximizedTab() === tab ? null : tab)
            this.refreshTab(tab)
        }
    }

    startRename (tab: BaseTabComponent): void {
        const chrome = this.chromes.get(tab)
        if (!chrome || chrome.tag.querySelector('input')) {
            return
        }
        const input = document.createElement('input')
        input.className = 'hagis-tag-input'
        input.value = this.panes.paneName(tab)
        input.spellcheck = false
        chrome.tag.textContent = ''
        chrome.tag.appendChild(input)
        input.focus()
        input.select()

        let done = false
        const finish = (commit: boolean) => {
            if (done) {
                return
            }
            done = true
            if (commit) {
                this.panes.renamePane(tab, input.value)
            }
            input.remove()
            this.updateTag(tab, chrome)
        }
        input.addEventListener('keydown', e => {
            e.stopPropagation() // Tabby 단축키·터미널로 가지 않게
            if (e.isComposing || e.keyCode === 229) {
                return // 한글 조합 중 Enter는 조합 확정용
            }
            if (e.key === 'Enter') {
                finish(true)
            } else if (e.key === 'Escape') {
                finish(false)
            }
        })
        input.addEventListener('pointerdown', e => e.stopPropagation())
        input.addEventListener('blur', () => finish(true))
    }

    private detachToNewTab (tab: BaseTabComponent): void {
        const split = tab.parent
        if (!(split instanceof SplitTabComponent) || split.getAllTabs().length < 2) {
            return
        }
        split.removeTab(tab)
        if (this.stage.role(tab)) {
            this.stage.setRole(tab, null) // 새 탭에서는 메인 무대가 없다
        }
        this.app.wrapAndAddTab(tab)
    }

    // ------------------------------------------------------------------ 드래그로 패널 이동

    private onTagPointerDown (tab: BaseTabComponent, down: PointerEvent): void {
        if (down.button !== 0 || (down.target as HTMLElement).tagName === 'INPUT') {
            return
        }
        const split = tab.parent
        if (!(split instanceof SplitTabComponent)) {
            return
        }
        down.preventDefault()
        down.stopPropagation()

        let overlay: HTMLElement|null = null
        let highlight: HTMLElement|null = null
        let ghost: HTMLElement|null = null
        let zone: DropZone|null = null

        const begin = () => {
            this.panes.setPaneDrag(tab)
            overlay = document.createElement('div')
            overlay.className = 'hagis-drag-overlay'
            highlight = document.createElement('div')
            highlight.className = 'hagis-drag-highlight'
            ghost = document.createElement('div')
            ghost.className = 'hagis-drag-ghost'
            ghost.textContent = this.panes.paneName(tab)
            ghost.style.setProperty('--hagis-tag-color', tab.color || DEFAULT_TAG_COLOR)
            overlay.append(highlight, ghost)
            document.body.appendChild(overlay)
        }

        const update = (e: PointerEvent) => {
            ghost!.style.left = `${e.clientX + 12}px`
            ghost!.style.top = `${e.clientY + 12}px`
            zone = this.findDropZone(split, tab, e.clientX, e.clientY)
            this.drawZone(highlight!, split, zone)
        }

        const cleanup = () => {
            window.removeEventListener('pointermove', onMove, true)
            window.removeEventListener('pointerup', onUp, true)
            window.removeEventListener('keydown', onKey, true)
            overlay?.remove()
            if (overlay) {
                this.panes.setPaneDrag(null)
            }
        }

        const onMove = (e: PointerEvent) => {
            if (!overlay) {
                if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) {
                    return
                }
                begin()
            }
            update(e)
        }
        const onUp = () => {
            const started = !!overlay
            const dropZone = zone
            cleanup()
            if (started && dropZone) {
                this.drop(tab, dropZone)
            }
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                zone = null
                cleanup()
            }
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        window.addEventListener('keydown', onKey, true)
    }

    private findDropZone (split: SplitTabComponent, dragged: BaseTabComponent, x: number, y: number): DropZone|null {
        const tabBar = document.querySelector('app-root .tab-bar')
        const barRect = tabBar?.getBoundingClientRect()
        if (barRect && x >= barRect.left && x <= barRect.right && y >= barRect.top && y <= barRect.bottom) {
            return split.getAllTabs().length > 1 ? { kind: 'new-tab' } : null
        }
        for (const target of split.getAllTabs()) {
            if (target === dragged) {
                continue
            }
            const host = this.panes.hostElement(target)
            const rect = host?.getBoundingClientRect()
            if (!rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                continue
            }
            const dx = (x - rect.left) / rect.width
            const dy = (y - rect.top) / rect.height
            const edges: [SplitDirection, number][] = [['l', dx], ['r', 1 - dx], ['t', dy], ['b', 1 - dy]]
            edges.sort((a, b) => a[1] - b[1])
            return { kind: 'pane', target, side: edges[0][1] > 0.28 ? 'swap' : edges[0][0] }
        }
        return null
    }

    private drawZone (highlight: HTMLElement, _split: SplitTabComponent, zone: DropZone|null): void {
        if (!zone) {
            highlight.style.display = 'none'
            return
        }
        let rect: DOMRect|undefined
        let label = ''
        if (zone.kind === 'new-tab') {
            rect = document.querySelector('app-root .tab-bar')?.getBoundingClientRect()
            label = '새 탭으로 분리'
        } else {
            const r = this.panes.hostElement(zone.target)?.getBoundingClientRect()
            if (r) {
                const half = { l: [0, 0, .5, 1], r: [.5, 0, .5, 1], t: [0, 0, 1, .5], b: [0, .5, 1, .5], swap: [0, 0, 1, 1] }[zone.side]
                rect = new DOMRect(r.left + r.width * half[0], r.top + r.height * half[1], r.width * half[2], r.height * half[3])
                label = { l: '왼쪽에 놓기', r: '오른쪽에 놓기', t: '위에 놓기', b: '아래에 놓기', swap: '자리 바꾸기' }[zone.side]
            }
        }
        if (!rect) {
            highlight.style.display = 'none'
            return
        }
        highlight.style.display = 'flex'
        highlight.style.left = `${rect.left}px`
        highlight.style.top = `${rect.top}px`
        highlight.style.width = `${rect.width}px`
        highlight.style.height = `${rect.height}px`
        highlight.textContent = label
    }

    private drop (tab: BaseTabComponent, zone: DropZone): void {
        if (zone.kind === 'new-tab') {
            this.detachToNewTab(tab)
        } else if (zone.side === 'swap') {
            this.panes.swapPanes(tab, zone.target)
        } else {
            this.panes.movePane(tab, zone.target, zone.side)
        }
        const split = tab.parent
        if (split instanceof SplitTabComponent) {
            setTimeout(() => this.refreshSplit(split), 50)
        }
    }
}
