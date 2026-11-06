import { Injectable, NgZone } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 브라우저 연동 — 주소창 자동완성의 재료(즐겨찾기·방문 기록)를 모으고 찾는다
 *
 * 재료는 두 갈래다.
 *  1. hagis 웹 패널에서 연 주소 (own) — 열 때마다 방문 횟수·시각을 올린다
 *  2. Chrome·Edge 등 Chromium 브라우저에서 가져온 즐겨찾기·방문 기록 (imported)
 *
 * 가져오기는 읽기만 한다: 브라우저의 파일을 임시 폴더로 복사해 그 사본을 읽고, 원본은 건드리지 않는다.
 * 쿠키·비밀번호는 가져오지 않는다 (Chrome 127+ 는 암호화 키를 Chrome 자신에게 묶어 두어 다른 프로그램은 읽을 수 없다).
 *
 * 저장: Tabby 설정 폴더의 hagis-browser.json (평문). 로그인·토큰이 든 주소는 남기지 않는다 (cleanUrl).
 */

/** 항목 하나 — [주소, 제목, 방문 횟수, 마지막 방문(ms), 직접 입력 횟수] */
type HistoryRec = [string, string, number, number, number]
/** 즐겨찾기 — [주소, 제목, 폴더 경로] */
type BookmarkRec = [string, string, string]

interface ImportedSource {
    label: string
    at: number
    history: HistoryRec[]
    bookmarks: BookmarkRec[]
}

interface StoreFile {
    v: 1
    own: Record<string, HistoryRec>
    imported: Record<string, ImportedSource>
}

export interface HagisBrowserSource {
    /** 'chrome:Default' 처럼 브라우저:프로필 폴더 */
    key: string
    browserId: string
    browserLabel: string
    profileDir: string
    profileName: string
    userName: string
    dir: string
    hasBookmarks: boolean
    hasHistory: boolean
}

export interface HagisImportStatus {
    at: number
    bookmarks: number
    history: number
}

export interface HagisSuggestion {
    url: string
    title: string
    kind: 'bookmark' | 'history'
    /** 즐겨찾기 폴더 또는 출처(방문 횟수 등) */
    detail: string
}

interface BrowserDef { id: string, label: string, dir: string[] }

/** 같은 구조(User Data/<프로필>/History·Bookmarks)를 쓰는 Chromium 계열 브라우저 (Windows) */
const BROWSERS: BrowserDef[] = [
    { id: 'chrome', label: 'Google Chrome', dir: ['Google', 'Chrome', 'User Data'] },
    { id: 'edge', label: 'Microsoft Edge', dir: ['Microsoft', 'Edge', 'User Data'] },
    { id: 'whale', label: '네이버 웨일', dir: ['Naver', 'Naver Whale', 'User Data'] },
    { id: 'brave', label: 'Brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
]

const OWN_LIMIT = 20000
const MAX_URL = 600
const MAX_TITLE = 200
const SAVE_DELAY_MS = 5000
const SYNC_DELAY_MS = 20000
/** 주소에 붙은 값 이름이 이런 말이면 로그인·인증 정보일 수 있어 기록하지 않는다 */
const SENSITIVE_PARAM = /(^|[_.-])(token|ticket|session|sess|sid|auth|pass|passwd|password|pwd|secret|otp|code|key|sig|signature|jwt|access|bearer|credential|credentials)s?($|[_.-])/i
const SEARCH_HOST = /(^|\.)(google\.[a-z.]+|bing\.com|search\.naver\.com|duckduckgo\.com|search\.daum\.net)$/i

/**
 * 저장·자동완성에 쓸 수 있는 주소로 정리 (쓸 수 없으면 null)
 *  - http(s) 만, 아이디·비밀번호가 든 주소·검색 결과 화면·인증 정보가 든 주소는 제외, #조각 제거
 */
export function cleanUrl (raw: string): string|null {
    if (!raw || raw.length > MAX_URL * 3) {
        return null
    }
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null
    }
    if (url.username || url.password || !url.hostname) {
        return null
    }
    for (const name of url.searchParams.keys()) {
        if (SENSITIVE_PARAM.test(name)) {
            return null
        }
    }
    if (SEARCH_HOST.test(url.hostname) && (url.searchParams.has('q') || url.searchParams.has('query'))) {
        return null // 검색 결과 화면은 방문 기록으로 남기지 않는다 (같은 검색은 입력하면 된다)
    }
    url.hash = ''
    const href = url.href
    return href.length > MAX_URL ? null : href
}

/** 같은 곳을 가리키는 주소를 하나로 묶는 키 (http/https, www, 끝의 / 무시) */
export function urlKey (url: string): string {
    try {
        const u = new URL(url)
        return (u.host.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase()
    } catch {
        return url.toLowerCase()
    }
}

interface Entry {
    url: string
    title: string
    titleLower: string
    host: string
    /** 호스트+경로(+쿼리) 소문자 — 스킴과 www 제외 */
    text: string
    visits: number
    typed: number
    last: number
    bookmark: boolean
    folder: string
    history: boolean
    own: boolean
}

@Injectable({ providedIn: 'root' })
export class HagisBrowserDataService {
    private logger: Logger
    private store: StoreFile|null = null
    private index: Entry[]|null = null
    private saveTimer: any = null
    private changed = new Subject<void>()

    /** 이 PC에서 찾은 브라우저·프로필 */
    sources: HagisBrowserSource[] = []
    /** 지금 가져오는 중인 항목 (key) */
    busy = new Set<string>()
    /** 가져오기 결과 메시지 (key → 오류 또는 안내) */
    messages: Record<string, { text: string, error: boolean }> = {}

    get changed$ (): Observable<void> { return this.changed }

    constructor (
        private config: ConfigService,
        private zone: NgZone,
        log: LogService,
    ) {
        this.logger = log.create('hagis-browser')
    }

    /** 모듈 시작 때 한 번 — 이미 가져온 브라우저를 조용히 최신으로 맞춘다 */
    init (): void {
        try {
            window.addEventListener('beforeunload', () => this.flush())
        } catch { }
        setTimeout(() => {
            if (this.opts.autoSync) {
                this.syncAll().catch(e => this.logger.warn('auto sync failed', e))
            }
        }, SYNC_DELAY_MS)
    }

    private get opts (): any {
        return this.config.store?.hagis?.browser ?? {}
    }

    // ---------------------------------------------------------------- 저장소

    private storePath (): string {
        let dir = process.env.TABBY_CONFIG_DIRECTORY
        if (!dir) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                dir = require('@electron/remote').app.getPath('userData')
            } catch { }
        }
        return path.join(dir ?? '.', 'hagis-browser.json')
    }

    private load (): StoreFile {
        if (this.store) {
            return this.store
        }
        let data: StoreFile = { v: 1, own: {}, imported: {} }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.storePath(), 'utf-8'))
            if (parsed && parsed.v === 1) {
                data = { v: 1, own: parsed.own ?? {}, imported: parsed.imported ?? {} }
            }
        } catch { }
        this.store = data
        return data
    }

    private touch (): void {
        this.index = null
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
        this.changed.next()
    }

    /** 바로 저장 (임시 파일에 쓰고 바꿔치기 — 쓰다 끊겨도 기존 파일이 남는다) */
    flush (): void {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
        if (!this.store) {
            return
        }
        const file = this.storePath()
        try {
            const tmp = file + '.tmp'
            fs.writeFileSync(tmp, JSON.stringify(this.store), 'utf-8')
            fs.renameSync(tmp, file)
        } catch (e) {
            this.logger.warn('cannot write browser store', e)
        }
    }

    // ---------------------------------------------------------------- hagis 방문 기록

    /** 웹 패널에서 연 주소를 기록 */
    recordVisit (rawUrl: string, title = ''): void {
        if (this.opts.recordHistory === false) {
            return
        }
        const url = cleanUrl(rawUrl)
        if (!url) {
            return
        }
        const store = this.load()
        const key = urlKey(url)
        const prev = store.own[key]
        const now = Date.now()
        if (prev && now - prev[3] < 2000 && prev[0] === url) {
            return // 같은 주소가 연달아 기록되는 것(리다이렉트·새로고침)은 한 번으로
        }
        store.own[key] = [url, (title || prev?.[1] || '').slice(0, MAX_TITLE), (prev?.[2] ?? 0) + 1, now, prev?.[4] ?? 0]
        const keys = Object.keys(store.own)
        if (keys.length > OWN_LIMIT) {
            keys.sort((a, b) => store.own[a][3] - store.own[b][3])
            for (const old of keys.slice(0, keys.length - OWN_LIMIT + 500)) {
                delete store.own[old]
            }
        }
        this.touch()
    }

    /** 페이지 제목이 나중에 정해지므로 주소에 붙여 둔다 */
    recordTitle (rawUrl: string, title: string): void {
        const url = cleanUrl(rawUrl)
        if (!url || !title) {
            return
        }
        const rec = this.load().own[urlKey(url)]
        if (rec && rec[1] !== title) {
            rec[1] = title.slice(0, MAX_TITLE)
            this.touch()
        }
    }

    get ownCount (): number {
        return Object.keys(this.load().own).length
    }

    clearOwn (): void {
        this.load().own = {}
        this.touch()
        this.flush()
    }

    importedStatus (key: string): HagisImportStatus|null {
        const src = this.load().imported[key]
        return src ? { at: src.at, bookmarks: src.bookmarks.length, history: src.history.length } : null
    }

    // ---------------------------------------------------------------- 브라우저 찾기

    /** 이 PC에 설치된 Chromium 계열 브라우저와 프로필 찾기 */
    refreshSources (): HagisBrowserSource[] {
        const found: HagisBrowserSource[] = []
        const local = process.env.LOCALAPPDATA
        if (process.platform === 'win32' && local) {
            for (const def of BROWSERS) {
                const dir = path.join(local, ...def.dir)
                if (!fs.existsSync(dir)) {
                    continue
                }
                let info: Record<string, any> = {}
                try {
                    info = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf-8'))?.profile?.info_cache ?? {}
                } catch { }
                const names = new Set<string>(Object.keys(info))
                try {
                    for (const name of fs.readdirSync(dir)) {
                        if (/^(Default|Profile \d+)$/.test(name)) {
                            names.add(name)
                        }
                    }
                } catch { }
                for (const profileDir of [...names].sort()) {
                    const base = path.join(dir, profileDir)
                    const hasBookmarks = fs.existsSync(path.join(base, 'Bookmarks'))
                    const hasHistory = fs.existsSync(path.join(base, 'History'))
                    if (!hasBookmarks && !hasHistory) {
                        continue
                    }
                    found.push({
                        key: `${def.id}:${profileDir}`,
                        browserId: def.id,
                        browserLabel: def.label,
                        profileDir,
                        profileName: String(info[profileDir]?.name ?? profileDir),
                        userName: String(info[profileDir]?.user_name ?? ''),
                        dir: base,
                        hasBookmarks,
                        hasHistory,
                    })
                }
            }
        }
        this.sources = found
        return found
    }

    // ---------------------------------------------------------------- 가져오기

    /** 한 브라우저 프로필에서 즐겨찾기·방문 기록 가져오기 (설정의 가져오기 항목에 따라) */
    async importSource (source: HagisBrowserSource): Promise<void> {
        if (this.busy.has(source.key)) {
            return
        }
        this.zone.run(() => {
            this.busy.add(source.key)
            delete this.messages[source.key]
        })
        try {
            const wantBookmarks = this.opts.importBookmarks !== false
            const wantHistory = this.opts.importHistory !== false
            const limit = Math.max(100, Math.min(100000, Number(this.opts.importHistoryLimit) || 5000))
            const prev = this.load().imported[source.key]
            const errors: string[] = []
            let bookmarks: BookmarkRec[] = prev?.bookmarks ?? []
            let history: HistoryRec[] = prev?.history ?? []
            let updated = false
            if (wantBookmarks) {
                try {
                    bookmarks = this.readBookmarks(source)
                    updated = true
                } catch (e: any) {
                    errors.push(`즐겨찾기: ${this.describeError(e)}`)
                }
            }
            if (wantHistory) {
                try {
                    history = await this.readHistory(source, limit)
                    updated = true
                } catch (e: any) {
                    errors.push(`방문 기록: ${this.describeError(e)}`)
                }
            }
            if (!wantBookmarks && !wantHistory) {
                errors.push('설정에서 가져올 항목(즐겨찾기·방문 기록)을 하나 이상 켜세요')
            }
            this.zone.run(() => {
                if (updated) {
                    this.load().imported[source.key] = {
                        label: `${source.browserLabel} · ${source.profileName}`,
                        at: Date.now(),
                        bookmarks,
                        history,
                    }
                    this.touch()
                    this.flush()
                }
                // 성공은 "마지막 가져오기" 줄이 보여 주므로 오류만 따로 알린다
                if (errors.length) {
                    this.messages[source.key] = { text: errors.join(' / '), error: true }
                } else {
                    delete this.messages[source.key]
                }
            })
        } finally {
            this.zone.run(() => this.busy.delete(source.key))
        }
    }

    /** 이미 가져온 적 있는 브라우저를 다시 읽어 최신으로 (조용히 — 실패해도 알리지 않는다) */
    async syncAll (): Promise<void> {
        const sources = this.refreshSources()
        for (const key of Object.keys(this.load().imported)) {
            const source = sources.find(s => s.key === key)
            if (source) {
                await this.importSource(source)
                await new Promise(resolve => setTimeout(resolve, 200))
            }
        }
    }

    removeImported (key: string): void {
        delete this.load().imported[key]
        delete this.messages[key]
        this.touch()
        this.flush()
    }

    private describeError (e: any): string {
        const code = e?.code
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
            return '브라우저가 파일을 사용 중이라 읽을 수 없습니다. 브라우저를 완전히 종료한 뒤 다시 시도하세요'
        }
        if (code === 'ENOENT') {
            return '파일을 찾을 수 없습니다'
        }
        if (String(e?.message ?? '').includes('node:sqlite')) {
            return '이 Tabby 버전은 방문 기록(SQLite)을 읽을 수 없습니다'
        }
        return String(e?.message ?? e)
    }

    /** Bookmarks(JSON) — 북마크바·기타·모바일 */
    private readBookmarks (source: HagisBrowserSource): BookmarkRec[] {
        const file = path.join(source.dir, 'Bookmarks')
        if (!fs.existsSync(file)) {
            return []
        }
        const roots = JSON.parse(fs.readFileSync(file, 'utf-8'))?.roots ?? {}
        const result: BookmarkRec[] = []
        const seen = new Set<string>()
        const walk = (node: any, folder: string): void => {
            if (!node || result.length >= 20000) {
                return
            }
            if (node.type === 'url') {
                const url = cleanUrl(String(node.url ?? ''))
                if (url && !seen.has(url)) {
                    seen.add(url)
                    result.push([url, String(node.name ?? '').slice(0, MAX_TITLE), folder])
                }
                return
            }
            const here = node.name ? (folder ? `${folder} › ${node.name}` : String(node.name)) : folder
            for (const child of node.children ?? []) {
                walk(child, here)
            }
        }
        for (const name of ['bookmark_bar', 'other', 'synced']) {
            walk(roots[name], '')
        }
        return result
    }

    /** History(SQLite) — 브라우저가 쓰는 파일은 건드리지 않고 임시 폴더에 복사해 읽는다 */
    private async readHistory (source: HagisBrowserSource, limit: number): Promise<HistoryRec[]> {
        const original = path.join(source.dir, 'History')
        if (!fs.existsSync(original)) {
            return []
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DatabaseSync } = require('node:sqlite')
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hagis-history-'))
        try {
            const copy = path.join(tmpDir, 'History')
            await fs.promises.copyFile(original, copy)
            for (const suffix of ['-wal', '-journal']) {
                // 아직 본 파일에 반영되지 않은 최근 기록
                if (fs.existsSync(original + suffix)) {
                    await fs.promises.copyFile(original + suffix, copy + suffix).catch(() => null)
                }
            }
            const db = new DatabaseSync(copy)
            try {
                // last_visit_time 은 1601년부터의 마이크로초(약 1.3e16)라 정수 범위를 넘는다 — 밀리초로 바꿔서 읽는다
                const rows = db.prepare(
                    'SELECT url, title, visit_count AS n, typed_count AS y, (last_visit_time / 1000 - 11644473600000) AS lv '
                    + 'FROM urls WHERE hidden = 0 AND visit_count > 0 ORDER BY last_visit_time DESC LIMIT ?',
                ).all(limit * 2) as any[]
                const result: HistoryRec[] = []
                const seen = new Set<string>()
                for (const row of rows) {
                    const url = cleanUrl(String(row.url ?? ''))
                    if (!url) {
                        continue
                    }
                    const key = urlKey(url)
                    if (seen.has(key)) {
                        continue
                    }
                    seen.add(key)
                    result.push([url, String(row.title ?? '').slice(0, MAX_TITLE), Number(row.n) || 1, Number(row.lv) || 0, Number(row.y) || 0])
                    if (result.length >= limit) {
                        break
                    }
                }
                return result
            } finally {
                try {
                    db.close()
                } catch { }
            }
        } finally {
            fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => null)
        }
    }

    // ---------------------------------------------------------------- 후보 찾기

    private buildIndex (): Entry[] {
        if (this.index) {
            return this.index
        }
        const store = this.load()
        const map = new Map<string, Entry>()
        const entryFor = (url: string, title: string): Entry => {
            const key = urlKey(url)
            let entry = map.get(key)
            if (!entry) {
                let host = ''
                try {
                    host = new URL(url).host.toLowerCase().replace(/^www\./, '')
                } catch { }
                entry = { url, title, titleLower: title.toLowerCase(), host, text: key, visits: 0, typed: 0, last: 0, bookmark: false, folder: '', history: false, own: false }
                map.set(key, entry)
            } else if (!entry.title && title) {
                entry.title = title
                entry.titleLower = title.toLowerCase()
            }
            return entry
        }
        const addHistory = (rec: HistoryRec, own: boolean): void => {
            const entry = entryFor(rec[0], rec[1])
            entry.history = true
            entry.own = entry.own || own
            entry.visits += rec[2]
            entry.typed += rec[4]
            if (rec[3] >= entry.last) {
                entry.last = rec[3]
                entry.url = rec[0] // 가장 최근에 쓴 주소 모양(https 등)으로
            }
        }
        for (const rec of Object.values(store.own)) {
            addHistory(rec, true)
        }
        for (const src of Object.values(store.imported)) {
            for (const rec of src.history) {
                addHistory(rec, false)
            }
            for (const [url, title, folder] of src.bookmarks) {
                const entry = entryFor(url, title)
                entry.bookmark = true
                entry.folder = entry.folder || folder
                if (title && (!entry.title || entry.title === entry.host)) {
                    entry.title = title
                    entry.titleLower = title.toLowerCase()
                }
            }
        }
        this.index = [...map.values()]
        return this.index
    }

    /**
     * 주소창 입력에 맞는 후보 (점수 순)
     * 입력이 비어 있으면 자주·최근에 간 곳과 즐겨찾기를 보여 준다.
     */
    suggest (query: string, max = 8): HagisSuggestion[] {
        const opts = this.opts
        const wantBookmarks = opts.suggest?.bookmarks !== false
        const wantHistory = opts.suggest?.history !== false
        if (!wantBookmarks && !wantHistory) {
            return []
        }
        const q = query.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
        const tokens = q.split(/\s+/).filter(Boolean)
        const now = Date.now()
        const scored: { entry: Entry, score: number }[] = []
        for (const entry of this.buildIndex()) {
            const asBookmark = wantBookmarks && entry.bookmark
            const asHistory = wantHistory && entry.history
            if (!asBookmark && !asHistory) {
                continue
            }
            let score = 0
            let matched = true
            for (const token of tokens) {
                if (entry.text.startsWith(token)) {
                    score += 70
                } else if (entry.host.includes(token)) {
                    score += 38
                } else if (entry.text.includes(token)) {
                    score += 16
                } else if (entry.titleLower.startsWith(token)) {
                    score += 28
                } else if (entry.titleLower.includes(' ' + token)) {
                    score += 22
                } else if (entry.titleLower.includes(token)) {
                    score += 12
                } else {
                    matched = false
                    break
                }
            }
            if (!matched) {
                continue
            }
            score += Math.min(30, Math.log2(1 + entry.visits) * 4) + Math.min(30, entry.typed * 4)
            const days = (now - entry.last) / 86400000
            score += days < 1 ? 12 : days < 7 ? 9 : days < 30 ? 5 : days < 180 ? 2 : 0
            score += asBookmark ? 18 : 0
            score += entry.own ? 6 : 0
            score -= entry.text.length * 0.02
            scored.push({ entry, score })
        }
        scored.sort((a, b) => b.score - a.score || b.entry.last - a.entry.last)
        return scored.slice(0, Math.max(1, max)).map(({ entry }) => {
            const bookmark = wantBookmarks && entry.bookmark
            return {
                url: entry.url,
                title: entry.title || entry.host,
                kind: bookmark ? 'bookmark' : 'history',
                detail: bookmark ? (entry.folder || '즐겨찾기') : `${entry.visits}회 방문`,
            } as HagisSuggestion
        })
    }
}
