/* eslint-disable @typescript-eslint/no-var-requires */
import { Injectable, NgZone } from '@angular/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'
import { HAGIS_REPO } from '../models'
import { getRemote } from '../utils'

/** 지금 설치된 버전 (빌드할 때 package.json 에서 가져온다) */
export const HAGIS_VERSION: string = require('../../package.json').version

/** 하루에 한 번만 확인 */
const CHECK_INTERVAL_MS = 12 * 3600 * 1000
/** 시작한 뒤 이만큼 기다렸다가 처음 확인 (Tabby 가 뜨는 동안 방해하지 않게) */
const FIRST_CHECK_DELAY_MS = 25 * 1000
const MAX_ZIP_BYTES = 30 * 1000 * 1000
const MAX_API_BYTES = 2 * 1000 * 1000

export interface HagisReleaseInfo {
    version: string
    tag: string
    notes: string
    page: string
    zipUrl: string
    shaUrl: string
}

export type HagisUpdateMode = 'ask' | 'auto' | 'off'

/** 3.4.10 같은 숫자 버전 비교 (a > b 이면 양수) */
export function compareVersions (a: string, b: string): number {
    const parse = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map(x => parseInt(x, 10) || 0)
    const pa = parse(a)
    const pb = parse(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (diff) {
            return diff
        }
    }
    return 0
}

/**
 * 업데이트 — GitHub 릴리스에 새 버전이 있는지 확인하고 플러그인 파일을 교체한다
 *
 *  - 확인: api.github.com 의 "최신 릴리스" 한 건을 하루 한 번 읽는다. 보내는 정보는 없다 (GitHub 에는 IP 주소만 보인다).
 *  - 설치: 릴리스의 hagis-<버전>.zip 을 받아 SHA-256 을 확인한 뒤 플러그인 폴더의 파일만 덮어쓴다. 적용은 Tabby 를 다시 시작할 때.
 *  - 안전: HTTPS 와 GitHub 도메인만 허용, 크기 제한, zip 안에서는 정해진 파일만 꺼내 쓰고 package.json 의 이름·버전을 확인한다.
 *  - 설정 → hagis → 업데이트 에서 "물어보기(기본) / 자동 설치 / 확인하지 않음" 을 고른다.
 */
@Injectable({ providedIn: 'root' })
export class HagisUpdateService {
    readonly current = HAGIS_VERSION
    /** 확인 또는 설치 중 */
    busy = false
    /** 지금 설치된 것보다 새로운 릴리스 */
    latest: HagisReleaseInfo|null = null
    /** 설정 화면에 보여 줄 한 줄 상태 */
    status = ''
    /** 이미 새 버전을 설치했고 재시작을 기다리는 중 */
    pendingVersion = ''
    private asked = new Set<string>()

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private zone: NgZone,
    ) { }

    private get settings (): { mode: HagisUpdateMode, lastCheck: number, skipVersion: string } {
        return this.config.store?.hagis?.update ?? { mode: 'ask', lastCheck: 0, skipVersion: '' }
    }

    get mode (): HagisUpdateMode {
        return this.settings.mode
    }

    init (): void {
        this.config.ready$.subscribe(() => {
            this.status = `현재 v${this.current}`
            this.zone.runOutsideAngular(() => {
                setTimeout(() => this.auto(), FIRST_CHECK_DELAY_MS)
                // 오래 켜 두는 사용자를 위해 6시간마다 다시 본다 (실제 확인은 하루 한 번)
                setInterval(() => this.auto(), 6 * 3600 * 1000)
            })
        })
    }

    // ---------------------------------------------------------------- 자동 확인

    private async auto (): Promise<void> {
        const { mode, lastCheck } = this.settings
        if (mode === 'off' || this.busy || this.pendingVersion) {
            return
        }
        if (Date.now() - (lastCheck || 0) < CHECK_INTERVAL_MS) {
            return
        }
        try {
            const info = await this.check()
            if (!info || info.version === this.settings.skipVersion || this.asked.has(info.version)) {
                return
            }
            this.asked.add(info.version)
            await this.zone.run(() => mode === 'auto' ? this.installAndNotify(info) : this.askToInstall(info))
        } catch (e) {
            console.warn('[hagis] update check failed', e)
        }
    }

    private async askToInstall (info: HagisReleaseInfo): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `hagis 새 버전 v${info.version} 이 나왔습니다 (현재 v${this.current})`,
            detail: info.notes ? `${info.notes.slice(0, 700)}${info.notes.length > 700 ? '\n…' : ''}` : undefined,
            buttons: ['지금 업데이트', '나중에', '이 버전은 건너뛰기'],
            defaultId: 0,
            cancelId: 1,
        })
        if (result.response === 0) {
            await this.installAndNotify(info)
        } else if (result.response === 2) {
            this.config.store.hagis.update.skipVersion = info.version
            await this.config.save()
        }
    }

    // ---------------------------------------------------------------- 설정 화면에서 쓰는 동작

    /** 지금 확인 (설정 화면·명령 팔레트) */
    async checkNow (): Promise<void> {
        if (this.busy) {
            return
        }
        try {
            const info = await this.check()
            this.status = info
                ? `새 버전 v${info.version} 이 있습니다 (현재 v${this.current})`
                : `최신 버전입니다 (v${this.current})`
            if (!info) {
                this.notifications.notice(`hagis: 최신 버전입니다 (v${this.current})`)
            }
        } catch (e) {
            this.status = `확인하지 못했습니다 — ${this.describe(e)}`
        }
    }

    async installLatest (): Promise<void> {
        if (this.latest && !this.busy) {
            await this.installAndNotify(this.latest)
        }
    }

    private async installAndNotify (info: HagisReleaseInfo): Promise<void> {
        try {
            await this.install(info)
        } catch (e) {
            this.status = `업데이트하지 못했습니다 — ${this.describe(e)}`
            this.notifications.error(`hagis: 업데이트하지 못했습니다 — ${this.describe(e)}`)
            return
        }
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `hagis v${info.version} 로 업데이트했습니다`,
            detail: '적용하려면 Tabby 를 다시 시작해야 합니다.\n지금 다시 시작하면 열려 있는 터미널 세션이 종료됩니다 (저장한 워크스페이스·이어가기 설정은 유지됩니다).',
            buttons: ['나중에', '지금 다시 시작'],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response === 1) {
            const remote = getRemote()
            remote.app.relaunch()
            remote.app.exit(0)
        }
    }

    // ---------------------------------------------------------------- 확인

    /**
     * GitHub 에서 최신 릴리스를 읽는다
     * @returns 설치된 것보다 새로우면 그 릴리스, 아니면 null
     */
    async check (): Promise<HagisReleaseInfo|null> {
        this.busy = true
        this.status = '확인하는 중…'
        try {
            const api = process.env.HAGIS_UPDATE_API || `https://api.github.com/repos/${HAGIS_REPO}/releases/latest`
            const json = JSON.parse((await this.download(api, MAX_API_BYTES, 'application/vnd.github+json')).toString('utf-8'))
            const tag = String(json.tag_name ?? '')
            const version = tag.replace(/^v/i, '')
            if (!/^\d+\.\d+\.\d+$/.test(version)) {
                throw new Error(`알 수 없는 버전 이름: ${tag}`)
            }
            const asset = (name: string) => (json.assets ?? []).find((a: any) => a?.name === name)?.browser_download_url as string|undefined
            const zipUrl = asset(`hagis-${version}.zip`)
            const shaUrl = asset(`hagis-${version}.zip.sha256`)
            if (this.config.store.hagis?.update) {
                this.config.store.hagis.update.lastCheck = Date.now()
                await this.config.save()
            }
            if (compareVersions(version, this.current) <= 0) {
                this.latest = null
                return null
            }
            if (!zipUrl || !shaUrl) {
                throw new Error(`v${version} 릴리스에 설치 파일이나 SHA-256 파일이 없습니다`)
            }
            this.latest = { version, tag, notes: String(json.body ?? '').trim(), page: String(json.html_url ?? ''), zipUrl, shaUrl }
            return this.latest
        } finally {
            this.busy = false
        }
    }

    // ---------------------------------------------------------------- 설치

    /** 이 플러그인이 설치된 폴더 (Tabby 사용자 플러그인 폴더) */
    private pluginDir (): string {
        return path.join(getRemote().app.getPath('userData'), 'plugins', 'node_modules', 'tabby-hagis')
    }

    async install (info: HagisReleaseInfo): Promise<void> {
        this.busy = true
        let work = ''
        try {
            const target = this.pluginDir()
            let installed: any
            try {
                installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf-8'))
            } catch {
                throw new Error(`설치 폴더를 찾지 못했습니다 (${target}) — install.cmd 로 직접 설치하세요`)
            }
            if (installed.name !== 'tabby-hagis') {
                throw new Error('설치 폴더가 hagis 가 아닙니다')
            }

            this.status = `v${info.version} 내려받는 중…`
            const zip = await this.download(info.zipUrl, MAX_ZIP_BYTES)
            const expected = (await this.download(info.shaUrl, 4096)).toString('utf-8').trim().split(/\s+/)[0]?.toLowerCase()
            const actual = crypto.createHash('sha256').update(zip).digest('hex')
            if (!expected || expected !== actual) {
                throw new Error('SHA-256 이 일치하지 않습니다 — 파일이 손상되었거나 바뀌었습니다')
            }

            this.status = '압축을 푸는 중…'
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'hagis-update-'))
            const zipPath = path.join(work, 'hagis.zip')
            const out = path.join(work, 'x')
            fs.writeFileSync(zipPath, zip)
            fs.mkdirSync(out)
            await this.extract(zipPath, out)

            const root = [out, ...fs.readdirSync(out).map(x => path.join(out, x))]
                .find(dir => fs.existsSync(path.join(dir, 'dist', 'index.js')) && fs.existsSync(path.join(dir, 'package.json')))
            if (!root) {
                throw new Error('압축 파일에 dist/index.js 가 없습니다')
            }
            const next = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
            if (next.name !== 'tabby-hagis' || next.version !== info.version) {
                throw new Error(`압축 파일의 버전(${next.version})이 릴리스(${info.version})와 다릅니다`)
            }

            // 정해진 파일만 덮어쓴다 — 실행 파일(dist/index.js)을 마지막에 바꿔 중간에 실패해도 이전 버전이 그대로 동작한다
            this.status = '설치하는 중…'
            for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json']) {
                if (fs.existsSync(path.join(root, name))) {
                    fs.copyFileSync(path.join(root, name), path.join(target, name))
                }
            }
            fs.mkdirSync(path.join(target, 'dist'), { recursive: true })
            fs.copyFileSync(path.join(root, 'dist', 'index.js'), path.join(target, 'dist', 'index.js'))
            try {
                fs.rmSync(path.join(target, 'dist', 'index.js.map'), { force: true })
            } catch { }

            this.pendingVersion = info.version
            this.latest = null
            this.status = `v${info.version} 설치 완료 — Tabby 를 다시 시작하면 적용됩니다`
        } finally {
            this.busy = false
            if (work) {
                try {
                    fs.rmSync(work, { recursive: true, force: true })
                } catch { }
            }
        }
    }

    private extract (zipPath: string, out: string): Promise<void> {
        const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        const [file, args] = process.platform === 'win32' && fs.existsSync(tar)
            ? [tar, ['-xf', zipPath, '-C', out]]
            : process.platform === 'win32'
                ? ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${out.replace(/'/g, "''")}' -Force`]]
                : ['unzip', ['-q', zipPath, '-d', out]]
        return new Promise((resolve, reject) => {
            execFile(file as string, args as string[], { windowsHide: true, timeout: 60000 }, error => error ? reject(new Error(`압축을 풀지 못했습니다 — ${error.message}`)) : resolve())
        })
    }

    // ---------------------------------------------------------------- 내려받기

    /** 개발·시험용 — HAGIS_UPDATE_API 를 지정했을 때만 http 와 임의 주소를 허용한다 */
    private get devOverride (): boolean {
        return !!process.env.HAGIS_UPDATE_API
    }

    private hostAllowed (url: URL): boolean {
        if (this.devOverride) {
            return url.protocol === 'http:' || url.protocol === 'https:'
        }
        if (url.protocol !== 'https:') {
            return false
        }
        const host = url.hostname.toLowerCase()
        return host === 'api.github.com' || host === 'github.com' || host.endsWith('.githubusercontent.com')
    }

    private download (url: string, maxBytes: number, accept = '*/*', depth = 0): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            let target: URL
            try {
                target = new URL(url)
            } catch {
                reject(new Error('잘못된 주소'))
                return
            }
            if (!this.hostAllowed(target)) {
                reject(new Error(`허용되지 않는 주소입니다 (${target.host})`))
                return
            }
            const lib = target.protocol === 'http:' ? require('http') : require('https')
            const request = lib.get(target, {
                headers: { 'User-Agent': `tabby-hagis/${this.current}`, Accept: accept },
                timeout: 20000,
            }, (res: any) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume()
                    if (depth >= 5) {
                        reject(new Error('리다이렉트가 너무 많습니다'))
                        return
                    }
                    resolve(this.download(new URL(res.headers.location, target).toString(), maxBytes, accept, depth + 1))
                    return
                }
                if (res.statusCode !== 200) {
                    res.resume()
                    reject(new Error(res.statusCode === 404 ? '릴리스를 찾을 수 없습니다 (아직 릴리스가 없을 수 있습니다)' : `HTTP ${res.statusCode}`))
                    return
                }
                const chunks: Buffer[] = []
                let size = 0
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length
                    if (size > maxBytes) {
                        request.destroy(new Error('파일이 너무 큽니다'))
                        return
                    }
                    chunks.push(chunk)
                })
                res.on('end', () => resolve(Buffer.concat(chunks)))
                res.on('error', reject)
            })
            request.on('timeout', () => request.destroy(new Error('응답 시간이 초과되었습니다')))
            request.on('error', reject)
        })
    }

    private describe (e: unknown): string {
        return e instanceof Error ? e.message : String(e)
    }
}
