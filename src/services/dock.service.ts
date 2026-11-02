/* eslint-disable @typescript-eslint/no-var-requires */
import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import {
    AppService, ConfigService, MenuItemOptions, NotificationsService, PlatformService,
    ProfilesService, PromptModalComponent, TabsService,
} from 'tabby-core'
import { HagisWebTabComponent } from '../components/webTab.component'
import { HagisDockItem, newId } from '../models'
import { baseName, getRemote } from '../utils'
import { HagisPaneService } from './pane.service'
import { HagisViewSyncService } from './viewSync.service'
import { HagisWorkspaceService } from './workspace.service'

/** 독이 차지하는 폭 — 확대된 아이콘도 이 안에 들어간다 (웹 패널은 Tabby 화면 위에 그려져 겹치면 가려지므로) */
const DOCK_WIDTH = 48
/** 접었을 때 남는 손잡이 폭 */
const DOCK_COLLAPSED_WIDTH = 10
/** 자동 숨기기일 때 가장자리에 남기는 띠 폭 (styles.service.ts 와 맞출 것) */
const DOCK_HOT_WIDTH = 6
/** 띠에 마우스를 이만큼 머물러야 나온다 (다른 모니터로 지나가는 마우스에 반응하지 않게) */
const REVEAL_DELAY = 90
/** 독에서 마우스가 떠난 뒤 숨기기까지 */
const HIDE_DELAY = 380
const ICON_BASE = 24
const ICON_MAX = 36
/** 마우스에서 이 거리(px) 정도까지 함께 커진다 */
const MAGNIFY_SIGMA = 24

/**
 * 독 — Tabby 화면 왼쪽(또는 오른쪽)의 실행 막대
 *
 * 자주 쓰는 프로그램(Winbox, 원격 데스크톱, 브라우저 …)·Tabby 프로필·워크스페이스·웹 주소를 아이콘으로 두고 한 번에 연다.
 *  - 탐색기·바탕화면에서 프로그램이나 바로가기를 끌어다 놓으면 추가
 *  - 아이콘을 끌어서 순서 변경, 우클릭: 이름·인수·제거
 *  - 마우스를 올리면 주변 아이콘까지 부드럽게 커진다 (macOS·iOS 독 방식), 반투명 유리 질감
 *
 * 탭 내용 영역 옆에 독 폭만큼 자리를 비워 두고 그 자리에 그린다.
 */
@Injectable({ providedIn: 'root' })
export class HagisDockService {
    private root: HTMLElement|null = null
    private list: HTMLElement|null = null
    private handle: HTMLElement|null = null
    private glass: HTMLElement|null = null
    private hot: HTMLElement|null = null
    /** 자동 숨기기: 지금 화면 위로 나와 있음 */
    private revealed = false
    private revealTimer: any = null
    private hideTimer: any = null
    private unfreezeTimer: any = null
    private resizeObserver: ResizeObserver|null = null
    private observedContent: Element|null = null
    private icons = new Map<string, string>()
    private iconsLoaded = false
    private iconsSaveTimer: any = null
    private magnifyRaf = 0
    private lastPointerY: number|null = null
    /** 아이콘을 끌어서 옮기는 중 (끝난 직후 클릭을 무시) */
    private reordering = false

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private profiles: ProfilesService,
        private tabs: TabsService,
        private notifications: NotificationsService,
        private modal: NgbModal,
        private panes: HagisPaneService,
        private workspaces: HagisWorkspaceService,
        private viewSync: HagisViewSyncService,
        private zone: NgZone,
    ) { }

    init (): void {
        this.config.ready$.subscribe(() => {
            this.apply()
            this.config.changed$.subscribe(() => this.apply())
        })
        window.addEventListener('resize', () => this.position())
        this.zone.runOutsideAngular(() => {
            // 끌어 와서 놓은 뒤에는 (마우스 이벤트가 없으므로) 잠시 뒤 숨긴다
            const afterDrag = () => this.revealed && this.scheduleHide(1200, true)
            window.addEventListener('drop', afterDrag, true)
            window.addEventListener('dragend', afterDrag, true)
        })
    }

    private get settings (): { enabled: boolean, side: 'left' | 'right', magnify: boolean, collapsed: boolean, autoHide: boolean, items: HagisDockItem[] } {
        return this.config.store?.hagis?.dock ?? { enabled: false, side: 'left', magnify: true, collapsed: false, autoHide: false, items: [] }
    }

    /** 접힘 (자동 숨기기일 때는 접기가 없다) */
    get collapsed (): boolean {
        return !!this.settings.collapsed && !this.autoHide
    }

    get autoHide (): boolean {
        return !!this.settings.autoHide
    }

    async setAutoHide (autoHide: boolean): Promise<void> {
        this.config.store.hagis.dock.autoHide = autoHide
        await this.config.save()
    }

    async setCollapsed (collapsed: boolean): Promise<void> {
        this.config.store.hagis.dock.collapsed = collapsed
        await this.config.save()
    }

    get enabled (): boolean {
        return !!this.settings.enabled
    }

    get items (): HagisDockItem[] {
        return this.settings.items ?? []
    }

    private async saveItems (items: HagisDockItem[]): Promise<void> {
        this.config.store.hagis.dock.items = items
        await this.config.save()
    }

    async setEnabled (enabled: boolean): Promise<void> {
        this.config.store.hagis.dock.enabled = enabled
        await this.config.save()
    }

    async setSide (side: 'left' | 'right'): Promise<void> {
        this.config.store.hagis.dock.side = side
        await this.config.save()
    }

    // ---------------------------------------------------------------- 그리기

    /** 설정에 맞춰 독을 보이거나 숨기고 다시 그린다 */
    private apply (): void {
        const { enabled, side } = this.settings
        const collapsed = this.collapsed
        const autoHide = this.autoHide
        document.body.classList.toggle('hagis-dock-on', !!enabled)
        document.body.classList.toggle('hagis-dock-side-left', enabled && side !== 'right')
        document.body.classList.toggle('hagis-dock-side-right', enabled && side === 'right')
        document.body.classList.toggle('hagis-dock-collapsed', enabled && collapsed)
        document.body.classList.toggle('hagis-dock-autohide', enabled && autoHide)
        if (!enabled || !autoHide) {
            this.conceal(true)
        }
        if (!enabled) {
            this.root?.remove()
            this.root = null
            this.viewSync.kick()
            return
        }
        if (!this.root) {
            this.create()
        }
        this.root!.classList.toggle('hagis-dock-right', side === 'right')
        this.root!.classList.toggle('hagis-dock-is-collapsed', collapsed)
        this.root!.classList.toggle('hagis-dock-auto', autoHide)
        if (this.handle) {
            this.handle.title = collapsed ? '독 펴기' : '독 접기'
        }
        this.profileCache = null // 프로필이 바뀌었을 수 있다
        this.render()
        this.position()
        this.viewSync.kick() // 탭 영역 폭이 바뀌었으므로 웹 패널 위치도 다시 맞춘다
    }

    private create (): void {
        const root = document.createElement('div')
        root.className = 'hagis-dock'
        const glass = document.createElement('div')
        glass.className = 'hagis-dock-glass'
        const list = document.createElement('div')
        list.className = 'hagis-dock-items'
        glass.appendChild(list)
        root.appendChild(glass)

        // 얇게 튀어나온 손잡이 — 눌러서 접기/펴기
        const handle = document.createElement('div')
        handle.className = 'hagis-dock-handle'
        const chevron = document.createElement('span')
        chevron.className = 'hagis-dock-chevron'
        handle.appendChild(chevron)
        handle.addEventListener('click', e => {
            e.preventDefault()
            this.zone.run(() => this.setCollapsed(!this.collapsed))
        })
        handle.addEventListener('contextmenu', e => {
            e.preventDefault()
            this.platform.popupContextMenu(this.dockMenu(), e)
        })
        root.appendChild(handle)
        this.handle = handle

        // 자동 숨기기: 가장자리 띠에 마우스를 대면 나온다
        const hot = document.createElement('div')
        hot.className = 'hagis-dock-hot'
        hot.title = '독 (마우스를 대면 나타남 · 우클릭: 독 설정)'
        hot.addEventListener('contextmenu', e => {
            e.preventDefault()
            this.platform.popupContextMenu(this.dockMenu(), e)
        })
        root.appendChild(hot)
        this.hot = hot

        document.body.appendChild(root)
        this.root = root
        this.list = list
        this.glass = glass

        glass.addEventListener('contextmenu', e => {
            if ((e.target as HTMLElement).closest('.hagis-dock-item')) {
                return
            }
            e.preventDefault()
            this.platform.popupContextMenu(this.dockMenu(), e)
        })
        this.zone.runOutsideAngular(() => {
            glass.addEventListener('mousemove', e => this.onPointer(e.clientY))
            glass.addEventListener('mouseleave', () => this.onPointer(null))

            hot.addEventListener('mouseenter', () => this.scheduleReveal(REVEAL_DELAY))
            hot.addEventListener('mouseleave', () => {
                if (!this.revealed) {
                    clearTimeout(this.revealTimer) // 스쳐 지나감
                } else {
                    this.scheduleHide(HIDE_DELAY)
                }
            })
            glass.addEventListener('mouseenter', () => clearTimeout(this.hideTimer))
            glass.addEventListener('mouseleave', () => this.scheduleHide(HIDE_DELAY))
            // 탐색기에서 프로그램을 끌어 오면 나와서 받는다
            hot.addEventListener('dragenter', () => this.scheduleReveal(0))
        })
    }

    // ---------------------------------------------------------------- 자동 숨기기

    private scheduleReveal (delay: number): void {
        if (!this.autoHide || this.revealed) {
            clearTimeout(this.hideTimer)
            return
        }
        clearTimeout(this.revealTimer)
        this.revealTimer = setTimeout(() => this.reveal(), delay)
    }

    /**
     * 독을 화면 위로 꺼낸다.
     * 웹 패널(네이티브 화면)은 Tabby 화면보다 위에 그려져 독을 가리므로,
     * 독 자리와 겹치는 웹 패널을 먼저 캡처 그림으로 바꾼 뒤 미끄러져 나온다.
     */
    private async reveal (): Promise<void> {
        if (!this.root || !this.autoHide || this.revealed) {
            return
        }
        this.revealed = true
        clearTimeout(this.hideTimer)
        clearTimeout(this.unfreezeTimer)
        const r = this.root.getBoundingClientRect()
        this.viewSync.setOccluder({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
        await this.viewSync.settle(300)
        if (!this.revealed || !this.root) {
            return
        }
        this.root.classList.add('hagis-dock-revealed')
    }

    private scheduleHide (delay: number, force = false): void {
        clearTimeout(this.hideTimer)
        this.hideTimer = setTimeout(() => {
            // 메뉴가 떠 있는 동안 등 아직 독 위에 있으면 그대로 둔다
            if (!force && (this.glass?.matches(':hover') || this.hot?.matches(':hover'))) {
                return
            }
            this.conceal()
        }, delay)
    }

    /** 독을 다시 숨기고, 미끄러져 들어간 뒤 웹 패널을 실제 화면으로 되돌린다 */
    private conceal (immediate = false): void {
        clearTimeout(this.revealTimer)
        clearTimeout(this.hideTimer)
        if (!this.revealed) {
            return
        }
        this.revealed = false
        this.root?.classList.remove('hagis-dock-revealed')
        clearTimeout(this.unfreezeTimer)
        const release = () => {
            if (!this.revealed) {
                this.viewSync.setOccluder(null)
            }
        }
        if (immediate) {
            release()
        } else {
            this.unfreezeTimer = setTimeout(release, 220)
        }
    }

    private positionRetry: any = null

    /** 탭 내용 영역 바로 옆(비워 둔 자리)에 맞춘다 */
    private position (): void {
        if (!this.root) {
            return
        }
        const content = document.querySelector('app-root .content.main > .content')
        if (!content) {
            // Tabby 화면이 아직 그려지기 전 — 잠시 뒤 다시
            clearTimeout(this.positionRetry)
            this.positionRetry = setTimeout(() => this.position(), 300)
            return
        }
        if (content !== this.observedContent) {
            this.resizeObserver?.disconnect()
            this.resizeObserver = new ResizeObserver(() => this.position())
            this.resizeObserver.observe(content)
            this.observedContent = content
        }
        const rect = content.getBoundingClientRect()
        if (rect.height < 10) {
            clearTimeout(this.positionRetry)
            this.positionRetry = setTimeout(() => this.position(), 300)
            return
        }
        const right = this.settings.side === 'right'
        if (this.autoHide) {
            // 가장자리 띠(비워 둔 자리) + 그 안쪽 독 폭 — 나올 때는 패널 위에 겹친다
            this.root.style.left = `${Math.round(right ? rect.right - DOCK_WIDTH : rect.left - DOCK_HOT_WIDTH)}px`
            this.root.style.top = `${Math.round(rect.top)}px`
            this.root.style.height = `${Math.round(rect.height)}px`
            this.root.style.width = `${DOCK_WIDTH + DOCK_HOT_WIDTH}px`
            return
        }
        const width = this.collapsed ? DOCK_COLLAPSED_WIDTH : DOCK_WIDTH
        this.root.style.left = `${Math.round(right ? rect.right : rect.left - width)}px`
        this.root.style.top = `${Math.round(rect.top)}px`
        this.root.style.height = `${Math.round(rect.height)}px`
        this.root.style.width = `${width}px`
    }

    private render (): void {
        const list = this.list
        if (!list) {
            return
        }
        this.loadIconCache()
        list.textContent = ''
        for (const item of this.items) {
            list.appendChild(this.renderItem(item))
        }
        if (!this.items.length) {
            const hint = document.createElement('div')
            hint.className = 'hagis-dock-hint'
            hint.textContent = '프로그램을 여기로 끌어다 놓기'
            list.appendChild(hint)
        }
        const sep = document.createElement('div')
        sep.className = 'hagis-dock-sep'
        list.appendChild(sep)

        const add = this.makeButton('추가 — 프로그램·프로필·워크스페이스·웹 주소\n(탐색기에서 끌어다 놓아도 됩니다)', this.tile('＋', 'add'))
        add.classList.add('hagis-dock-add')
        add.addEventListener('click', e => {
            e.preventDefault()
            this.zone.run(async () => this.platform.popupContextMenu(await this.addMenu(), e))
        })
        list.appendChild(add)
    }

    private makeButton (title: string, content: HTMLElement): HTMLElement {
        const button = document.createElement('div')
        button.className = 'hagis-dock-item'
        button.title = title
        const icon = document.createElement('span')
        icon.className = 'hagis-dock-icon'
        icon.appendChild(content)
        button.appendChild(icon)
        return button
    }

    private renderItem (item: HagisDockItem): HTMLElement {
        const button = this.makeButton(this.describe(item), this.iconFor(item))
        button.dataset.id = item.id
        button.addEventListener('click', e => {
            if (this.reordering) {
                return
            }
            this.zone.run(() => this.launch(item, e))
        })
        button.addEventListener('contextmenu', e => {
            e.preventDefault()
            e.stopPropagation()
            this.zone.run(async () => this.platform.popupContextMenu(await this.itemMenu(item), e))
        })
        button.addEventListener('pointerdown', e => this.onItemPointerDown(item, button, e))
        return button
    }

    private describe (item: HagisDockItem): string {
        switch (item.kind) {
            case 'app': return `${item.name}\n${item.path}${item.args ? ' ' + item.args : ''}`
            case 'web': return `${item.name}\n${item.url}  (Ctrl+클릭: 현재 화면에 패널로)`
            case 'profile': return `${item.name}  (Tabby 프로필 · Ctrl+클릭: 현재 화면에 패널로)`
            case 'workspace': return `${item.name}  (워크스페이스)`
        }
    }

    // ---------------------------------------------------------------- 아이콘

    private iconFor (item: HagisDockItem): HTMLElement {
        if (item.kind === 'app' && item.path) {
            const cached = this.icons.get(item.path)
            if (cached) {
                const img = document.createElement('img')
                img.src = cached
                img.draggable = false
                return img
            }
            this.loadAppIcon(item.path)
            return this.tile(item.name.substring(0, 1).toUpperCase(), item.name)
        }
        if (item.kind === 'web') {
            return this.tile('', item.name, 'fas fa-globe')
        }
        if (item.kind === 'workspace') {
            return this.tile('', item.name, 'fas fa-th-large')
        }
        const profile: any = this.profileFor(item)
        if (typeof profile?.icon === 'string' && profile.icon.trim().startsWith('<svg')) {
            // Tabby 기본 셸 프로필(cmd, PowerShell, WSL …)은 SVG 아이콘을 가진다
            const tile = this.tile('', item.name)
            tile.innerHTML = profile.icon
            tile.classList.add('hagis-dock-tile-svg')
            return tile
        }
        const icon: string = typeof profile?.icon === 'string' && profile.icon.startsWith('fa') ? profile.icon : {
            ssh: 'fas fa-server', telnet: 'fas fa-network-wired', serial: 'fas fa-plug', local: 'fas fa-terminal',
            'hagis-web': 'fas fa-globe', 'hagis-markdown': 'fab fa-markdown',
        }[profile?.type as string] ?? ''
        return this.tile(icon ? '' : item.name.substring(0, 1).toUpperCase(), item.name, icon)
    }

    /** iOS 앱 아이콘처럼 둥근 사각형 + 그라데이션 (이름에서 색을 정한다) */
    private tile (text: string, seed: string, iconClass = ''): HTMLElement {
        const tile = document.createElement('span')
        tile.className = 'hagis-dock-tile'
        let hash = 0
        for (const ch of seed) {
            hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
        }
        const hue = seed === 'add' ? 0 : hash % 360
        tile.style.setProperty('--c1', `hsl(${hue}, 72%, 58%)`)
        tile.style.setProperty('--c2', `hsl(${(hue + 35) % 360}, 70%, 38%)`)
        if (iconClass) {
            const i = document.createElement('i')
            i.className = iconClass
            tile.appendChild(i)
        } else {
            tile.textContent = text
        }
        return tile
    }

    /** Tabby 프로필 목록 (기본 제공 프로필 포함) — 아이콘·종류 표시용 */
    private profileCache: Map<string, any>|null = null
    private profileLoading = false

    private profileFor (item: HagisDockItem): any {
        if (!this.profileCache) {
            if (!this.profileLoading) {
                this.profileLoading = true
                this.profiles.getProfiles().then(list => {
                    this.profileCache = new Map(list.map(p => [p.id ?? '', p] as [string, any]))
                    this.render()
                }).catch(() => null).finally(() => this.profileLoading = false)
            }
            return null
        }
        return this.profileCache.get(item.profileId ?? '') ?? null
    }

    /** 프로그램 아이콘 — Windows 파일 아이콘 (32~48px) */
    private async loadAppIcon (filePath: string): Promise<void> {
        if (this.icons.has(filePath)) {
            return
        }
        this.icons.set(filePath, '') // 중복 요청 방지
        let source = filePath
        try {
            if (filePath.toLowerCase().endsWith('.lnk')) {
                const target = require('electron').shell.readShortcutLink(filePath)?.target
                if (target && fs.existsSync(target)) {
                    source = target // 바로가기 화살표 없는 원래 아이콘
                }
            }
        } catch { }
        let data = ''
        try {
            const image = await getRemote().app.getFileIcon(source, { size: 'large' })
            if (image && !image.isEmpty()) {
                data = image.toDataURL()
            }
        } catch { }
        if (!data) {
            this.icons.delete(filePath)
            return
        }
        this.icons.set(filePath, data)
        this.saveIconCache()
        this.render()
    }

    private iconCachePath (): string {
        let dir = process.env.TABBY_CONFIG_DIRECTORY
        if (!dir) {
            try {
                dir = getRemote().app.getPath('userData')
            } catch { }
        }
        return path.join(dir ?? '.', 'hagis-dock-icons.json')
    }

    private loadIconCache (): void {
        if (this.iconsLoaded) {
            return
        }
        this.iconsLoaded = true
        try {
            const data = JSON.parse(fs.readFileSync(this.iconCachePath(), 'utf-8'))
            for (const [key, value] of Object.entries(data)) {
                if (typeof value === 'string' && value) {
                    this.icons.set(key, value)
                }
            }
        } catch { }
    }

    private saveIconCache (): void {
        clearTimeout(this.iconsSaveTimer)
        this.iconsSaveTimer = setTimeout(() => {
            const used = new Set(this.items.map(x => x.path).filter(Boolean))
            const data = Object.fromEntries([...this.icons.entries()].filter(([k, v]) => v && used.has(k)))
            try {
                fs.writeFileSync(this.iconCachePath(), JSON.stringify(data), 'utf-8')
            } catch { }
        }, 500)
    }

    // ---------------------------------------------------------------- 확대 효과

    private onPointer (y: number|null): void {
        this.lastPointerY = y
        if (this.magnifyRaf) {
            return
        }
        this.magnifyRaf = requestAnimationFrame(() => {
            this.magnifyRaf = 0
            this.magnify(this.lastPointerY)
        })
    }

    private magnify (y: number|null): void {
        const items = this.list ? Array.from(this.list.querySelectorAll<HTMLElement>('.hagis-dock-item')) : []
        const enabled = this.settings.magnify && !this.reordering
        for (const el of items) {
            if (y === null || !enabled) {
                el.style.removeProperty('--hd-size')
                continue
            }
            const rect = el.getBoundingClientRect()
            const d = y - (rect.top + rect.height / 2)
            const size = ICON_BASE + (ICON_MAX - ICON_BASE) * Math.exp(-(d * d) / (2 * MAGNIFY_SIGMA * MAGNIFY_SIGMA))
            el.style.setProperty('--hd-size', `${size.toFixed(1)}px`)
        }
    }

    // ---------------------------------------------------------------- 실행

    async launch (item: HagisDockItem, event?: MouseEvent): Promise<void> {
        const intoSplit = !!event?.ctrlKey
        this.bounce(item)
        try {
            switch (item.kind) {
                case 'app': return await this.launchApp(item)
                case 'web': return this.openTab(this.tabs.create({ type: HagisWebTabComponent, inputs: { url: item.url ?? '' } }), intoSplit)
                case 'workspace': {
                    const ws = this.workspaces.workspaces.find(w => w.id === item.workspaceId)
                    if (!ws) {
                        this.notifications.error(`hagis: 워크스페이스를 찾을 수 없습니다 — ${item.name}`)
                        return
                    }
                    await this.workspaces.openWorkspace(ws)
                    return
                }
                case 'profile': {
                    const profile = (await this.profiles.getProfiles()).find(p => p.id === item.profileId)
                    if (!profile) {
                        this.notifications.error(`hagis: 프로필을 찾을 수 없습니다 — ${item.name}`)
                        return
                    }
                    if (intoSplit && this.panes.getActiveSplit()) {
                        const tab = await this.panes.createProfileTab(profile)
                        if (tab) {
                            this.openTab(tab, true)
                        }
                    } else {
                        await this.profiles.openNewTabForProfile(profile)
                    }
                }
            }
        } catch (e) {
            this.notifications.error(`hagis: 열 수 없습니다 — ${item.name}: ${e}`)
        }
    }

    private async launchApp (item: HagisDockItem): Promise<void> {
        const target = item.path ?? ''
        if (!target || !fs.existsSync(target)) {
            this.notifications.error(`hagis: 파일을 찾을 수 없습니다 — ${target}`)
            return
        }
        // .exe 에 인수가 있으면 직접 실행, 그 외(.lnk·문서·폴더)는 Windows 가 연결된 프로그램으로 연다
        if (item.args?.trim() && target.toLowerCase().endsWith('.exe')) {
            const child = spawn(target, splitArgs(item.args), { cwd: path.dirname(target), detached: true, stdio: 'ignore' })
            child.on('error', e => this.notifications.error(`hagis: 실행하지 못했습니다 — ${e.message}`))
            child.unref()
            return
        }
        const error = await require('electron').shell.openPath(target)
        if (error) {
            this.notifications.error(`hagis: 열 수 없습니다 — ${error}`)
        }
    }

    private openTab (tab: any, intoSplit: boolean): void {
        const split = this.panes.getActiveSplit()
        if (intoSplit && split) {
            split.addTab(tab, split.getFocusedTab(), 'r')
        } else {
            this.app.wrapAndAddTab(tab)
        }
    }

    /** 실행 표시 — 아이콘이 통통 튄다 */
    private bounce (item: HagisDockItem): void {
        const el = this.list?.querySelector<HTMLElement>(`[data-id="${item.id}"]`)
        if (!el) {
            return
        }
        el.classList.remove('hagis-dock-bounce')
        void el.offsetWidth
        el.classList.add('hagis-dock-bounce')
        setTimeout(() => el.classList.remove('hagis-dock-bounce'), 900)
    }

    // ---------------------------------------------------------------- 추가 / 편집

    /** 탐색기에서 끌어다 놓은 파일·폴더·링크 */
    async addFromDrop (paths: string[], urls: string[]): Promise<void> {
        const added: HagisDockItem[] = [
            ...paths.map(p => ({ id: newId(), kind: 'app' as const, name: displayName(p), path: p })),
            ...urls.map(u => ({ id: newId(), kind: 'web' as const, name: hostOf(u), url: u })),
        ]
        if (!added.length) {
            return
        }
        await this.saveItems([...this.items, ...added])
        this.notifications.notice(`hagis: 독에 ${added.map(x => x.name).join(', ')} 추가`)
    }

    private async addMenu (): Promise<MenuItemOptions[]> {
        const profiles = await this.panes.getSelectableProfiles()
        const workspaces = this.workspaces.workspaces
        return [
            { label: '프로그램·파일 추가…', click: () => this.pickApp(false) },
            { label: '폴더 추가…', click: () => this.pickApp(true) },
            {
                label: 'Tabby 프로필',
                enabled: profiles.length > 0,
                submenu: profiles.slice(0, 60).map(p => ({
                    label: this.panes.profileLabel(p),
                    click: () => this.addItem({ id: newId(), kind: 'profile', name: p.name ?? '프로필', profileId: p.id }),
                })),
            },
            {
                label: '워크스페이스',
                enabled: workspaces.length > 0,
                submenu: workspaces.map(w => ({
                    label: w.customer ? `${w.customer} · ${w.name}` : w.name,
                    click: () => this.addItem({ id: newId(), kind: 'workspace', name: w.name, workspaceId: w.id }),
                })),
            },
            { label: '웹 주소…', click: () => this.addWebAddress() },
            { type: 'separator' },
            ...this.dockMenu(),
        ]
    }

    /** 독 자체 설정 (빈 곳 우클릭) */
    private dockMenu (): MenuItemOptions[] {
        const { side, magnify } = this.settings
        const autoHide = this.autoHide
        return [
            { label: '독 위치: 왼쪽', type: 'radio', checked: side !== 'right', click: () => this.setSide('left') },
            { label: '독 위치: 오른쪽', type: 'radio', checked: side === 'right', click: () => this.setSide('right') },
            { label: '마우스를 올리면 아이콘 확대', type: 'checkbox', checked: magnify, click: async () => {
                this.config.store.hagis.dock.magnify = !magnify
                await this.config.save()
            } },
            { label: '자동 숨기기 — 가장자리에 마우스를 대면 표시 (macOS)', type: 'checkbox', checked: autoHide, click: () => this.setAutoHide(!autoHide) },
            ...autoHide ? [] : [
                { label: this.collapsed ? '독 펴기' : '독 접기 (얇은 손잡이만 남김)', click: () => this.setCollapsed(!this.collapsed) },
            ] as MenuItemOptions[],
            { type: 'separator' },
            { label: '독 숨기기 (설정 → hagis 에서 다시 켜기)', click: () => this.setEnabled(false) },
        ]
    }

    private async itemMenu (item: HagisDockItem): Promise<MenuItemOptions[]> {
        const index = this.items.findIndex(x => x.id === item.id)
        const menu: MenuItemOptions[] = [{ label: '열기', click: () => this.launch(item) }]
        if (item.kind === 'web' || item.kind === 'profile') {
            menu.push({ label: '현재 화면에 패널로 열기 (Ctrl+클릭)', enabled: !!this.panes.getActiveSplit(), click: () => this.launch(item, { ctrlKey: true } as any) })
        }
        menu.push({ type: 'separator' }, { label: '이름 바꾸기…', click: () => this.edit(item, 'name') })
        if (item.kind === 'app') {
            if (item.path?.toLowerCase().endsWith('.exe')) {
                menu.push({ label: item.args ? `실행 인수: ${item.args}` : '실행 인수 지정…', click: () => this.edit(item, 'args') })
            }
            menu.push({ label: '파일 위치 열기', click: () => item.path && require('electron').shell.showItemInFolder(item.path) })
        }
        if (item.kind === 'web') {
            menu.push({ label: '주소 바꾸기…', click: () => this.edit(item, 'url') })
        }
        menu.push(
            { type: 'separator' },
            { label: '위로', enabled: index > 0, click: () => this.move(item, -1) },
            { label: '아래로', enabled: index < this.items.length - 1, click: () => this.move(item, 1) },
            { type: 'separator' },
            { label: '독에서 제거', click: () => this.saveItems(this.items.filter(x => x.id !== item.id)) },
        )
        return menu
    }

    private async pickApp (folder: boolean): Promise<void> {
        const remote = getRemote()
        const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
            title: folder ? '독에 추가할 폴더' : '독에 추가할 프로그램·바로가기·파일',
            properties: folder ? ['openDirectory'] : ['openFile'],
            filters: folder ? undefined : [
                { name: '프로그램·바로가기', extensions: ['exe', 'lnk', 'bat', 'cmd', 'msc', 'url'] },
                { name: '모든 파일', extensions: ['*'] },
            ],
        })
        if (!result.canceled && result.filePaths?.length) {
            await this.addFromDrop(result.filePaths, [])
        }
    }

    private async addWebAddress (): Promise<void> {
        const url = await this.prompt('독에 추가할 웹 주소 (예: 192.168.1.99)', '')
        if (!url?.trim()) {
            return
        }
        const normalized = /^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
        await this.addItem({ id: newId(), kind: 'web', name: hostOf(normalized), url: normalized })
    }

    private async addItem (item: HagisDockItem): Promise<void> {
        await this.saveItems([...this.items, item])
    }

    private async edit (item: HagisDockItem, field: 'name' | 'args' | 'url'): Promise<void> {
        const labels = { name: '독 아이콘 이름', args: '실행 인수 (예: /v:10.0.0.5)', url: '웹 주소' }
        const value = await this.prompt(labels[field], (item as any)[field] ?? '')
        if (value === null) {
            return
        }
        await this.saveItems(this.items.map(x => x.id === item.id ? { ...x, [field]: value.trim() || (field === 'name' ? x.name : undefined) } : x))
    }

    private async move (item: HagisDockItem, delta: number): Promise<void> {
        const items = [...this.items]
        const i = items.findIndex(x => x.id === item.id)
        const j = i + delta
        if (i < 0 || j < 0 || j >= items.length) {
            return
        }
        [items[i], items[j]] = [items[j], items[i]]
        await this.saveItems(items)
    }

    private async prompt (label: string, value: string): Promise<string|null> {
        const ref = this.modal.open(PromptModalComponent)
        ref.componentInstance.prompt = label
        ref.componentInstance.value = value
        try {
            const result = await ref.result
            return result ? result.value ?? '' : null
        } catch {
            return null
        }
    }

    // ---------------------------------------------------------------- 끌어서 순서 바꾸기

    private onItemPointerDown (item: HagisDockItem, el: HTMLElement, down: PointerEvent): void {
        if (down.button !== 0 || !this.list) {
            return
        }
        const list = this.list
        let dragging = false
        const onMove = (e: PointerEvent) => {
            if (!dragging) {
                if (Math.abs(e.clientY - down.clientY) < 6) {
                    return
                }
                dragging = true
                this.reordering = true
                this.magnify(null)
                el.classList.add('hagis-dock-dragging')
            }
            // 지나간 아이콘과 자리를 바꾼다
            for (const other of Array.from(list.querySelectorAll<HTMLElement>('.hagis-dock-item[data-id]'))) {
                if (other === el) {
                    continue
                }
                const r = other.getBoundingClientRect()
                const mid = r.top + r.height / 2
                const before = !!(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)
                if (before && e.clientY > mid) {
                    other.after(el)
                } else if (!before && e.clientY < mid) {
                    other.before(el)
                }
            }
        }
        const onUp = () => {
            window.removeEventListener('pointermove', onMove, true)
            window.removeEventListener('pointerup', onUp, true)
            if (!dragging) {
                return
            }
            el.classList.remove('hagis-dock-dragging')
            const order = Array.from(list.querySelectorAll<HTMLElement>('.hagis-dock-item[data-id]')).map(x => x.dataset.id)
            const byId = new Map(this.items.map(x => [x.id, x]))
            const items = order.map(id => byId.get(id!)).filter((x): x is HagisDockItem => !!x)
            setTimeout(() => this.reordering = false, 50) // 놓는 순간의 클릭은 실행하지 않는다
            this.zone.run(() => this.saveItems(items))
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        void item
    }
}

/** 실행 인수 문자열 → 배열 ("…" 안의 공백은 유지) */
function splitArgs (text: string): string[] {
    const result: string[] = []
    const re = /"([^"]*)"|(\S+)/g
    let m: RegExpExecArray|null
    while ((m = re.exec(text))) {
        result.push(m[1] ?? m[2])
    }
    return result
}

/** 파일 이름에서 표시 이름 (확장자 제외) */
function displayName (filePath: string): string {
    const name = baseName(filePath.replace(/[\\/]+$/, ''))
    return name.replace(/\.(exe|lnk|bat|cmd|url|msc)$/i, '') || name
}

function hostOf (url: string): string {
    try {
        return new URL(url).host || url
    } catch {
        return url
    }
}

export const HAGIS_DOCK_WIDTH = DOCK_WIDTH
