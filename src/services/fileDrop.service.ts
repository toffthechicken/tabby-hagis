import { Injectable, NgZone } from '@angular/core'
import { AppService, BaseTabComponent, NotificationsService, PlatformService, SplitTabComponent, TabsService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { HagisMarkdownTabComponent } from '../components/markdownTab.component'
import { HagisWebTabComponent } from '../components/webTab.component'
import { TEXT_FILE_EXTENSIONS, isTextFile } from '../models'
import { getDroppedFilePath } from '../utils'
import { HagisPaneService } from './pane.service'
import { HagisDockService } from './dock.service'

type DropTarget =
    | { kind: 'dock', element: HTMLElement }
    | { kind: 'tab-bar', element: HTMLElement }
    | { kind: 'placeholder', element: HTMLElement, tab: BaseTabComponent }
    | { kind: 'terminal', element: HTMLElement, tab: BaseTerminalTabComponent<any> }

/**
 * 탐색기 파일·브라우저 링크 끌어다 놓기
 *  - 독에 놓기       → 독 아이콘으로 추가 (프로그램·바로가기·폴더·링크)
 *  - 상단 탭 바에 놓기 → 새 탭으로 열기 (.md/.txt/.log → Markdown 뷰어, 링크 → 웹 GUI)
 *  - 빈 패널에 놓기   → 그 자리에서 열기
 *  - 터미널 패널에 놓기 → 그 자리에서 열기. 단, 연결된 세션이 있으면 확인 창
 *                       (Enter = 파일로 바꾸기 / 경로만 붙여넣기 / Esc = 취소)
 *  - Markdown 패널에 놓기 → 그 패널에서 파일 교체 (컴포넌트가 처리)
 */
@Injectable({ providedIn: 'root' })
export class HagisFileDropService {
    private highlighted: HTMLElement|null = null

    constructor (
        private app: AppService,
        private tabs: TabsService,
        private panes: HagisPaneService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private zone: NgZone,
        private dock: HagisDockService,
    ) { }

    init (): void {
        // app-root 가 dragover/drop 을 막기 전에 capture 단계에서 가로챈다
        document.addEventListener('dragover', e => this.onDragOver(e), true)
        document.addEventListener('drop', e => this.onDrop(e), true)
        document.addEventListener('dragleave', e => {
            if (!e.relatedTarget) {
                this.highlight(null)
            }
        }, true)
    }

    private hasPayload (e: DragEvent): boolean {
        const types = e.dataTransfer?.types ?? []
        return types.includes('Files') || types.includes('text/uri-list')
    }

    private resolveTarget (e: DragEvent): DropTarget|null {
        const el = e.target as HTMLElement|null
        if (!el?.closest) {
            return null
        }
        const dock = el.closest('.hagis-dock') as HTMLElement|null
        if (dock) {
            return { kind: 'dock', element: dock }
        }
        const tabBar = el.closest('.tab-bar') as HTMLElement|null
        if (tabBar && tabBar.closest('app-root')) {
            return { kind: 'tab-bar', element: tabBar }
        }
        const placeholderHost = el.closest('hagis-placeholder-tab') as HTMLElement|null
        if (placeholderHost) {
            const tab = this.findTabByHost(placeholderHost)
            if (tab) {
                return { kind: 'placeholder', element: placeholderHost, tab }
            }
        }
        const paneHost = el.closest('split-tab > .child') as HTMLElement|null
        if (paneHost) {
            const tab = this.findTabByHost(paneHost)
            if (tab instanceof BaseTerminalTabComponent) {
                return { kind: 'terminal', element: paneHost, tab }
            }
        }
        return null
    }

    private findTabByHost (host: HTMLElement): BaseTabComponent|null {
        for (const top of this.app.tabs) {
            const children = top instanceof SplitTabComponent ? top.getAllTabs() : [top]
            for (const tab of children) {
                if (this.panes.hostElement(tab) === host) {
                    return tab
                }
            }
        }
        return null
    }

    private onDragOver (e: DragEvent): void {
        if (!this.hasPayload(e)) {
            return
        }
        const target = this.resolveTarget(e)
        if (!target) {
            this.highlight(null)
            return
        }
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy'
        }
        this.highlight(target.element)
    }

    private onDrop (e: DragEvent): void {
        this.highlight(null)
        if (!this.hasPayload(e)) {
            return
        }
        const target = this.resolveTarget(e)
        if (!target) {
            return
        }
        e.preventDefault()
        e.stopPropagation()

        const files = Array.from(e.dataTransfer?.files ?? [])
            .map(f => getDroppedFilePath(f))
            .filter((p): p is string => !!p)
        const urls = files.length ? [] : (e.dataTransfer?.getData('text/uri-list') ?? '')
            .split(/\r?\n/)
            .map(x => x.trim())
            .filter(x => /^https?:\/\//i.test(x))

        this.zone.run(async () => {
            if (target.kind === 'dock') {
                await this.dock.addFromDrop(files, urls) // 프로그램·바로가기·폴더·링크를 독 아이콘으로
                return
            }
            if (target.kind === 'terminal' && target.tab.session?.open) {
                const choice = await this.confirmReplaceLiveTerminal(target.tab, [...files, ...urls])
                if (choice === 'paste') {
                    this.pastePaths(target.tab, files.length ? files : urls)
                    return
                }
                if (choice !== 'replace') {
                    return
                }
            }
            const newTabs = [
                ...files.map(f => this.tabForFile(f)),
                ...urls.map(u => this.tabs.create({ type: HagisWebTabComponent, inputs: { url: u } })),
            ].filter((t): t is BaseTabComponent => !!t)
            if (!newTabs.length) {
                return
            }
            if (target.kind === 'placeholder' || target.kind === 'terminal') {
                this.panes.replacePane(target.tab, newTabs[0])
                for (const extra of newTabs.slice(1)) {
                    this.app.wrapAndAddTab(extra)
                }
            } else {
                for (const tab of newTabs) {
                    this.app.wrapAndAddTab(tab)
                }
            }
        })
    }

    /**
     * 경로를 셸에 안전하게 붙여 넣는다 — Tabby 의 보안 수정(GHSA-m937-jm93-pfp6, GHSA-mq9v-2pgm-fxgh)과 같은 방식.
     * 파일 이름에 $(…), `…`, ; 등이 들어 있어도 명령으로 실행되지 않도록 셸 종류별로 감싸고,
     * 제어 문자는 지우고, 가능하면 괄호 붙여넣기(bracketed paste)로 보낸다.
     */
    private pastePaths (terminal: BaseTerminalTabComponent<any>, items: string[]): void {
        const profile: any = terminal.profile
        const shellType: string = profile?.type === 'local' ? profile.options?.shellType ?? 'unix' : 'unix' // SSH·Telnet 은 원격 셸
        const quote = (value: string): string => {
            value = value.replace(/[\x00-\x1F\x7F]/g, '')
            if (shellType === 'powershell') {
                return `'${value.replace(/['‘’‚‛]/g, m => m + m)}'`
            }
            if (shellType === 'cmd') {
                return `"${value.replace(/\^/g, '^^').replace(/!/g, '^!').replace(/"/g, '""').replace(/%/g, '%%')}"`
            }
            return `'${value.replace(/'/g, `'\\''`)}'`
        }
        let data = items.map(quote).join(' ') + ' '
        const frontend: any = terminal.frontend
        if (terminal.config.store.terminal.bracketedPaste && frontend?.supportsBracketedPaste?.()) {
            data = `\x1b[200~${data}\x1b[201~`
        }
        terminal.sendInput(data)
    }

    /**
     * 안전장치: 연결된 터미널 위에 파일을 놓으면 확인 (Enter = 파일로 바꾸기, Esc = 취소)
     */
    private async confirmReplaceLiveTerminal (terminal: BaseTerminalTabComponent<any>, items: string[]): Promise<'replace'|'paste'|'cancel'> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `"${this.panes.paneName(terminal)}" 패널에서 터미널이 실행 중입니다. 이 패널을 파일로 바꿀까요?`,
            detail: `바꾸면 이 패널의 터미널 세션은 종료됩니다.\n\n${items.slice(0, 5).join('\n')}${items.length > 5 ? `\n… 외 ${items.length - 5}개` : ''}`,
            buttons: ['파일로 바꾸기', '경로만 붙여넣기', '취소'],
            defaultId: 0,
            cancelId: 2,
        })
        return (['replace', 'paste', 'cancel'] as const)[result.response] ?? 'cancel'
    }

    private tabForFile (filePath: string): BaseTabComponent|null {
        if (isTextFile(filePath)) {
            return this.tabs.create({ type: HagisMarkdownTabComponent, inputs: { path: filePath } })
        }
        this.notifications.error(
            `hagis: 열 수 없는 파일 형식입니다 — ${filePath}`,
            `지원 형식: ${TEXT_FILE_EXTENSIONS.join(', ')}`,
        )
        return null
    }

    private highlight (element: HTMLElement|null): void {
        if (this.highlighted === element) {
            return
        }
        this.highlighted?.classList.remove('hagis-file-drop-target')
        this.highlighted = element
        element?.classList.add('hagis-file-drop-target')
    }
}
