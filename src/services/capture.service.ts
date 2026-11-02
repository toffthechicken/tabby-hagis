import { Injectable } from '@angular/core'
import * as fs from 'fs'
import * as path from 'path'
import { AppService, BaseTabComponent, NotificationsService, PlatformService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { getRemote } from '../utils'
import { HagisPaneService } from './pane.service'

export type HagisTextRange = 'screen' | 'all' | 'last'

/** "최근 N줄 복사"의 N */
export const LAST_LINES = 100

const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()))

/**
 * 터미널 내용 복사·저장, 패널 화면 캡처
 *
 *  - 텍스트: xterm 버퍼에서 읽는다 (화면에 보이는 부분 / 스크롤백 전체 / 최근 N줄). 줄바꿈으로 접힌 줄은 한 줄로 합친다.
 *  - 화면 캡처: 터미널·Markdown 은 Tabby 창에서 패널 영역을 잘라 찍고, 웹 패널은 웹 화면 자체를 찍는다.
 *  - 결과는 클립보드로 복사하거나 파일로 저장한다. (AI 대화·장비 로그를 그대로 남기는 용도)
 */
@Injectable({ providedIn: 'root' })
export class HagisCaptureService {
    constructor (
        private app: AppService,
        private platform: PlatformService,
        private panes: HagisPaneService,
        private notifications: NotificationsService,
    ) { }

    /** 지금 선택(포커스)된 패널 */
    activePane (): BaseTabComponent|null {
        const tab = this.app.activeTab
        if (tab instanceof SplitTabComponent) {
            return tab.getFocusedTab() ?? tab.getAllTabs()[0] ?? null
        }
        return tab ?? null
    }

    // ---------------------------------------------------------------- 텍스트

    isTerminal (tab: BaseTabComponent|null): tab is BaseTerminalTabComponent<any> {
        return !!tab && tab instanceof BaseTerminalTabComponent && !!this.xterm(tab)
    }

    private xterm (tab: BaseTabComponent): any {
        return (tab as any).frontend?.xterm ?? null
    }

    /**
     * 터미널 텍스트
     * @returns 줄 배열 (앞뒤 빈 줄 제거) — 읽을 수 없으면 null
     */
    getLines (tab: BaseTabComponent, range: HagisTextRange): string[]|null {
        const buffer = this.xterm(tab)?.buffer?.active
        if (!buffer) {
            return null
        }
        let from = 0
        let to = buffer.length
        if (range === 'screen') {
            from = buffer.viewportY
            to = Math.min(buffer.length, from + (this.xterm(tab).rows ?? 0))
        }
        // 접혀서 이어진 줄(isWrapped)은 원래 한 줄로 합친다
        const logical: string[] = []
        for (let i = from; i < to; i++) {
            const line = buffer.getLine(i)
            if (!line) {
                continue
            }
            const text = line.translateToString(false)
            if (line.isWrapped && logical.length) {
                logical[logical.length - 1] += text
            } else {
                logical.push(text)
            }
        }
        const lines = logical.map(x => x.replace(/\s+$/, ''))
        while (lines.length && !lines[lines.length - 1]) {
            lines.pop()
        }
        while (lines.length && !lines[0]) {
            lines.shift()
        }
        return range === 'last' ? lines.slice(-LAST_LINES) : lines
    }

    copyText (tab: BaseTabComponent, range: HagisTextRange): void {
        const lines = this.getLines(tab, range)
        if (!lines?.length) {
            this.notifications.info('hagis: 복사할 터미널 내용이 없습니다')
            return
        }
        this.platform.setClipboard({ text: lines.join('\n') })
        const what = { screen: '보이는 화면', all: '전체 내용', last: `최근 ${LAST_LINES}줄` }[range]
        this.notifications.notice(`hagis: ${what} 복사 — ${lines.length}줄`)
    }

    async saveText (tab: BaseTabComponent): Promise<void> {
        const lines = this.getLines(tab, 'all')
        if (!lines?.length) {
            this.notifications.info('hagis: 저장할 터미널 내용이 없습니다')
            return
        }
        const file = await this.pickSavePath(`${this.fileStem(tab)}.txt`, 'txt', '텍스트')
        if (!file) {
            return
        }
        try {
            fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf-8')
            this.notifications.notice(`hagis: ${lines.length}줄 저장 — ${file}`)
        } catch (e) {
            this.notifications.error(`hagis: 저장하지 못했습니다 — ${e}`)
        }
    }

    // ---------------------------------------------------------------- 화면 캡처

    /** 패널 화면 이미지 (Electron NativeImage — 메인 프로세스 객체) */
    private async grab (tab: BaseTabComponent): Promise<any|null> {
        const custom = (tab as any).captureImage
        if (typeof custom === 'function') {
            return custom.call(tab) // 웹 패널: 웹 화면 자체
        }
        const host = this.panes.hostElement(tab)
        if (!host) {
            return null
        }
        // 마우스를 올렸을 때만 나오는 버튼들은 찍히지 않게 잠깐 숨긴다
        document.body.classList.add('hagis-capturing')
        try {
            await nextFrame()
            await nextFrame()
            const rect = host.getBoundingClientRect()
            let zoom = 1
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                zoom = require('electron').webFrame.getZoomFactor()
            } catch { }
            return await getRemote().getCurrentWebContents().capturePage({
                x: Math.max(0, Math.round(rect.left * zoom)),
                y: Math.max(0, Math.round(rect.top * zoom)),
                width: Math.round(rect.width * zoom),
                height: Math.round(rect.height * zoom),
            })
        } finally {
            document.body.classList.remove('hagis-capturing')
        }
    }

    async copyImage (tab: BaseTabComponent): Promise<void> {
        try {
            const image = await this.grab(tab)
            if (!image || image.isEmpty()) {
                this.notifications.error('hagis: 화면을 캡처하지 못했습니다')
                return
            }
            getRemote().clipboard.writeImage(image)
            const size = image.getSize()
            this.notifications.notice(`hagis: 화면 캡처를 클립보드에 복사 (${size.width}×${size.height})`)
        } catch (e) {
            this.notifications.error(`hagis: 화면 캡처 실패 — ${e}`)
        }
    }

    async saveImage (tab: BaseTabComponent): Promise<void> {
        try {
            const image = await this.grab(tab)
            if (!image || image.isEmpty()) {
                this.notifications.error('hagis: 화면을 캡처하지 못했습니다')
                return
            }
            const file = await this.pickSavePath(`${this.fileStem(tab)}.png`, 'png', 'PNG 이미지')
            if (!file) {
                return
            }
            fs.writeFileSync(file, Buffer.from(image.toPNG()))
            this.notifications.notice(`hagis: 화면 캡처 저장 — ${file}`)
        } catch (e) {
            this.notifications.error(`hagis: 화면 캡처 실패 — ${e}`)
        }
    }

    // ---------------------------------------------------------------- 도우미

    /** 파일 이름 — 패널 이름 + 날짜·시간 (사용할 수 없는 글자는 _) */
    private fileStem (tab: BaseTabComponent): string {
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
        const name = (tab.customTitle || tab.title || 'pane').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim().slice(0, 40) || 'pane'
        return `${name}_${stamp}`
    }

    private async pickSavePath (defaultName: string, extension: string, label: string): Promise<string|null> {
        const remote = getRemote()
        const result = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {
            title: '저장',
            defaultPath: path.join(remote.app.getPath('documents'), defaultName),
            filters: [{ name: label, extensions: [extension] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
    }
}
