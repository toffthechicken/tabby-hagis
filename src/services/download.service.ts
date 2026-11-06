import { Injectable, NgZone } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { ConfigService, LogService, Logger, NotificationsService, PlatformService } from 'tabby-core'
import * as fs from 'fs'
import * as path from 'path'
import { HAGIS_WEB_PARTITION } from './web.service'

/**
 * 웹 패널 파일 다운로드
 *
 * Electron 은 다운로드를 받으면 저장 위치 창을 바로 띄우는데, remote 콜백은 비동기라
 * 렌더러에서는 그 전에 저장 위치를 정해 줄 수 없다. 그래서 메인 프로세스에 작은 처리 함수를 붙인다
 * (web.service 의 팝업 처리와 같은 방식 — 코드는 아래 고정 문자열이고 사용자 입력은 들어가지 않는다).
 *  - 기본: Chrome 처럼 다운로드 폴더에 바로 저장 (같은 이름이 있으면 "이름 (1).확장자" — 기존 파일을 덮어쓰지 않는다)
 *  - 설정 "저장 위치 물어보기": Electron 기본 저장 창
 * 진행 상황은 메인 → 렌더러 콜백으로 받아 패널의 다운로드 버튼과 목록에 보여 준다.
 */

export type HagisDownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface HagisDownload {
    id: number
    name: string
    path: string
    url: string
    state: HagisDownloadState
    received: number
    /** 0 이하 = 크기를 모름 */
    total: number
    /** 받기 시작한 페이지(webContents) — 어느 패널의 다운로드인지 가린다 */
    wcId: number
    startedAt: number
}

/** 이 확장자의 파일은 앱 안에서 "열기"로 실행하지 않는다 (Chromium 은 다운로드한 파일에 출처 표시를 남기지 않는다) */
const RUNNABLE = new Set([
    'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
    'lnk', 'url', 'reg', 'jar', 'cpl', 'msix', 'msixbundle', 'appx', 'appxbundle', 'gadget', 'application', 'dll', 'sh',
])

const MAIN_HOOK = `
    var path = process.getBuiltinModule('path');
    var fs = process.getBuiltinModule('fs');
    var options = { ask: !!initial.ask, dir: String(initial.dir || '') };
    var items = {};
    var emitters = {};
    var nextId = 1;
    function safeName(name) {
        var base = path.basename(String(name || 'download')).replace(/[<>:"\\/\\\\|?*\\u0000-\\u001f]/g, '_').replace(/[. ]+$/, '');
        return base || 'download';
    }
    function uniquePath(dir, name) {
        var ext = path.extname(name), stem = path.basename(name, ext), file = path.join(dir, name), n = 1;
        while (fs.existsSync(file) && n < 1000) { file = path.join(dir, stem + ' (' + n + ')' + ext); n++; }
        return file;
    }
    session.on('will-download', function (event, item, wc) {
        var id = nextId++;
        items[id] = item;
        var wcId = 0;
        try { wcId = wc && !wc.isDestroyed() ? wc.id : 0; } catch (e) { }
        try {
            if (!options.ask) {
                if (options.dir) { try { fs.mkdirSync(options.dir, { recursive: true }); } catch (e) { } }
                if (options.dir && fs.existsSync(options.dir)) {
                    item.setSavePath(uniquePath(options.dir, safeName(item.getFilename())));
                }
            }
        } catch (e) { }
        function info(state) {
            var file = '';
            try { file = item.getSavePath() || ''; } catch (e) { }
            return {
                id: id, state: state, wcId: wcId,
                name: file ? path.basename(file) : safeName(item.getFilename()),
                path: file, url: String(item.getURL() || ''),
                received: item.getReceivedBytes(), total: item.getTotalBytes(),
            };
        }
        var last = 0;
        emitters[id] = function (state) { notify(info(state)); };
        notify(info('progressing'));
        item.on('updated', function (e, state) {
            var now = Date.now();
            if (state === 'progressing' && now - last < 250) { return; }
            last = now;
            notify(info(state === 'interrupted' ? 'interrupted' : (item.isPaused() ? 'paused' : 'progressing')));
        });
        item.once('done', function (e, state) {
            delete items[id];
            delete emitters[id];
            notify(info(state));
        });
    });
    return {
        cancel: function (id) { try { if (items[id]) { items[id].cancel(); } } catch (e) { } },
        // 일시정지·재개는 'updated' 이벤트가 바로 오지 않으므로 직접 알린다
        pause: function (id) { try { if (items[id]) { items[id].pause(); emitters[id]('paused'); } } catch (e) { } },
        resume: function (id) { try { if (items[id] && items[id].canResume()) { items[id].resume(); emitters[id]('progressing'); } } catch (e) { } },
        setOptions: function (next) { options.ask = !!next.ask; options.dir = String(next.dir || ''); },
    };
`

@Injectable({ providedIn: 'root' })
export class HagisDownloadService {
    /** 최근 다운로드 (최신이 앞) */
    items: HagisDownload[] = []
    private logger: Logger
    private hook: { cancel: (id: number) => void, pause: (id: number) => void, resume: (id: number) => void, setOptions: (o: any) => void }|null = null
    private changed = new Subject<void>()
    private done = new Subject<HagisDownload>()

    get changed$ (): Observable<void> { return this.changed }
    /** 받기가 끝났을 때 (완료·취소·실패) */
    get done$ (): Observable<HagisDownload> { return this.done }

    constructor (
        private config: ConfigService,
        private zone: NgZone,
        private platform: PlatformService,
        private notifications: NotificationsService,
        log: LogService,
    ) {
        this.logger = log.create('hagis-download')
    }

    private get remote (): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@electron/remote')
    }

    /** 설정의 저장 폴더 (비어 있으면 Windows 다운로드 폴더) */
    get folder (): string {
        const custom = String(this.config.store?.hagis?.download?.folder ?? '').trim()
        if (custom) {
            return custom
        }
        try {
            return this.remote.app.getPath('downloads')
        } catch {
            return ''
        }
    }

    private get optionValues (): { ask: boolean, dir: string } {
        return { ask: !!this.config.store?.hagis?.download?.askWhere, dir: this.folder }
    }

    /** 웹 패널 세션에 다운로드 처리를 붙인다 (한 번만) */
    ensureHooked (): void {
        if (this.hook) {
            return
        }
        try {
            const MainFunction = this.remote.getGlobal('Function')
            const make = MainFunction('session', 'initial', 'notify', MAIN_HOOK)
            const session = this.remote.session.fromPartition(HAGIS_WEB_PARTITION)
            this.hook = make(session, this.optionValues, (info: any) => this.zone.run(() => this.onEvent(info)))
            this.config.changed$.subscribe(() => this.hook?.setOptions(this.optionValues))
        } catch (e) {
            this.logger.warn('download hook failed', e)
        }
    }

    private onEvent (info: any): void {
        let item = this.items.find(i => i.id === info.id)
        const state: HagisDownloadState = info.state === 'completed' || info.state === 'cancelled' || info.state === 'interrupted' || info.state === 'paused'
            ? info.state : 'progressing'
        if (!item) {
            item = { id: info.id, name: info.name, path: info.path, url: info.url, state, received: info.received, total: info.total, wcId: info.wcId, startedAt: Date.now() }
            this.items.unshift(item)
            if (this.items.length > 50) {
                this.items.length = 50
            }
        }
        const finished = item.state === 'progressing' || item.state === 'paused'
        item.name = info.name || item.name
        item.path = info.path || item.path
        item.state = state
        item.received = info.received
        item.total = info.total
        this.changed.next()
        if (finished && (state === 'completed' || state === 'cancelled' || state === 'interrupted')) {
            this.done.next(item)
            if (state === 'completed') {
                this.notifications.notice(`hagis: 다운로드 완료 — ${item.name}`)
            } else if (state === 'interrupted') {
                this.notifications.error(`hagis: 다운로드 실패 — ${item.name}`)
            }
        }
    }

    // ---------------------------------------------------------------- 패널이 쓰는 것

    /** 이 패널의 다운로드 (받는 페이지를 알 수 없는 것 — 팝업 창에서 받은 것 — 은 모든 패널에 보인다) */
    forPane (wcId: number, knownWcIds: Set<number>): HagisDownload[] {
        return this.items.filter(i => i.wcId === wcId || !knownWcIds.has(i.wcId))
    }

    active (list: HagisDownload[]): HagisDownload[] {
        return list.filter(i => i.state === 'progressing' || i.state === 'paused')
    }

    /** 진행률 0~1 (크기를 모르면 -1) */
    progress (list: HagisDownload[]): number {
        const active = this.active(list)
        if (!active.length) {
            return 1
        }
        if (active.some(i => i.total <= 0)) {
            return -1
        }
        const total = active.reduce((sum, i) => sum + i.total, 0)
        return total ? Math.min(1, active.reduce((sum, i) => sum + i.received, 0) / total) : -1
    }

    cancel (item: HagisDownload): void {
        this.hook?.cancel(item.id)
    }

    togglePause (item: HagisDownload): void {
        if (item.state === 'paused') {
            this.hook?.resume(item.id)
        } else {
            this.hook?.pause(item.id)
        }
    }

    remove (item: HagisDownload): void {
        this.items = this.items.filter(i => i !== item)
        this.changed.next()
    }

    clearFinished (): void {
        this.items = this.items.filter(i => i.state === 'progressing' || i.state === 'paused')
        this.changed.next()
    }

    exists (item: HagisDownload): boolean {
        return !!item.path && fs.existsSync(item.path)
    }

    ext (item: HagisDownload): string {
        return path.extname(item.name || item.path).replace(/^\./, '').toLowerCase()
    }

    /** 앱 안에서 바로 열어도 되는 파일인가 (실행 파일·스크립트는 폴더에서 보기만) */
    canOpen (item: HagisDownload): boolean {
        return item.state === 'completed' && this.exists(item) && !RUNNABLE.has(this.ext(item))
    }

    open (item: HagisDownload): void {
        if (this.canOpen(item)) {
            this.platform.openPath(item.path)
        }
    }

    showInFolder (item: HagisDownload): void {
        if (item.path) {
            this.platform.showItemInFolder(item.path)
        }
    }
}
