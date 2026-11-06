import { Injectable } from '@angular/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

/**
 * 문서 뷰어용 로컬 서버
 *
 * HWP·Word·Excel·PowerPoint·PDF 파일을 hagis 웹 패널 안에서 열기 위해, 이 PC 안에서만(127.0.0.1) 도는 작은 서버가
 * 뷰어 페이지(dist/viewer)와 사용자가 고른 파일을 준다. 뷰어 페이지가 fetch 로 파일을 받으려면 http 주소가 필요하기 때문이다
 * (웹 패널은 file:// 페이지가 다른 파일을 읽는 것을 허용하지 않는다).
 *
 * 안전 장치
 *  - 127.0.0.1 에만 열고, 모든 주소 앞에 무작위 토큰(128비트)이 붙는다 — 다른 웹 페이지·프로그램은 주소를 알 수 없다
 *  - Host 헤더가 127.0.0.1:포트 가 아니면 거절한다 (DNS rebinding 방어)
 *  - 파일은 사용자가 "열기"를 눌러 등록한 것만, 뷰어 파일은 dist/viewer 안의 허용 확장자만 준다 (경로 이탈 불가)
 *  - 뷰어 페이지에는 CSP 를 붙여 외부로 요청을 보내지 못하게 한다 (문서 안의 외부 그림·링크가 있어도 접속하지 않음)
 *  - CORS 헤더를 주지 않는다 (다른 출처 페이지가 응답을 읽을 수 없다)
 */

const VIEWER_EXTENSIONS: Record<string, string> = {
    pdf: 'application/pdf',
    hwp: 'application/x-hwp', hwpx: 'application/hwp+zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docm: 'application/octet-stream', dotx: 'application/octet-stream',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/octet-stream', xlsb: 'application/octet-stream',
    xls: 'application/vnd.ms-excel', ods: 'application/octet-stream', csv: 'text/plain; charset=utf-8', tsv: 'text/plain; charset=utf-8',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8',
    json: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8', cfg: 'text/plain; charset=utf-8', conf: 'text/plain; charset=utf-8',
    ini: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
}

const ASSET_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm',
}

const VIEWER_CSP = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ')

const MAX_FILE_BYTES = 300 * 1024 * 1024
const MAX_FILES = 200
/** 뷰어 주소 모양 — 주소에서 원래 파일 경로(p)를 되찾아 hagis 를 다시 켠 뒤에도 열 수 있게 한다 */
const VIEWER_URL = /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/app\/viewer\.html\?/

@Injectable({ providedIn: 'root' })
export class HagisViewerService {
    private starting: Promise<void>|null = null
    private port = 0
    private token = ''
    private files = new Map<string, string>()

    private get remote (): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@electron/remote')
    }

    /** 뷰어 파일(dist/viewer) 위치 — 플러그인 폴더 안 */
    private get assetDir (): string {
        return path.join(this.remote.app.getPath('userData'), 'plugins', 'node_modules', 'tabby-hagis', 'dist', 'viewer')
    }

    extensionOf (file: string): string {
        return path.extname(file).replace(/^\./, '').toLowerCase()
    }

    /** 뷰어로 열 수 있는 확장자 (점 없이) */
    get extensions (): string[] {
        return Object.keys(VIEWER_EXTENSIONS)
    }

    /** hagis 뷰어로 열 수 있는 파일인가 (구형 .doc/.ppt 는 열 수 없다) */
    canView (file: string): boolean {
        return !!file && this.extensionOf(file) in VIEWER_EXTENSIONS
    }

    /** 뷰어 주소(이전에 만든 것)인가 */
    isViewerUrl (url: string): boolean {
        return VIEWER_URL.test(url)
    }

    /** 뷰어 주소에서 원래 파일 경로를 꺼낸다 (hagis 를 다시 켜서 토큰이 바뀐 주소를 새로 만들 때) */
    originalPath (url: string): string {
        try {
            return new URL(url).searchParams.get('p') ?? ''
        } catch {
            return ''
        }
    }

    /** 파일을 등록하고 웹 패널에서 열 뷰어 주소를 돌려준다 */
    async prepare (filePath: string): Promise<string> {
        if (!this.canView(filePath)) {
            throw new Error(`.${this.extensionOf(filePath)} 형식은 hagis 뷰어에서 열 수 없습니다`)
        }
        const stat = await fs.promises.stat(filePath).catch(() => null)
        if (!stat || !stat.isFile()) {
            throw new Error(`파일을 찾을 수 없습니다 — ${filePath}`)
        }
        if (stat.size > MAX_FILE_BYTES) {
            throw new Error(`파일이 너무 큽니다 (${Math.round(stat.size / 1024 / 1024)}MB, 최대 ${MAX_FILE_BYTES / 1024 / 1024}MB)`)
        }
        await this.ensureServer()
        const id = crypto.randomBytes(8).toString('hex')
        if (this.files.size >= MAX_FILES) {
            this.files.delete(this.files.keys().next().value as string)
        }
        this.files.set(id, filePath)
        return `http://127.0.0.1:${this.port}/${this.token}/app/viewer.html?id=${id}&p=${encodeURIComponent(filePath)}`
    }

    private ensureServer (): Promise<void> {
        if (this.port) {
            return Promise.resolve()
        }
        if (!this.starting) {
            this.starting = new Promise<void>((resolve, reject) => {
                this.token = crypto.randomBytes(16).toString('hex')
                const server = http.createServer((req, res) => this.handle(req, res))
                server.once('error', err => {
                    this.starting = null
                    reject(err)
                })
                server.listen(0, '127.0.0.1', () => {
                    this.port = (server.address() as any).port
                    server.unref()
                    resolve()
                })
            })
        }
        return this.starting
    }

    private deny (res: http.ServerResponse, code: number): void {
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(code === 404 ? 'not found' : 'forbidden')
    }

    private handle (req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.host !== `127.0.0.1:${this.port}`) {
                this.deny(res, 403)
                return
            }
            const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
            const parts = url.pathname.split('/') // ['', token, 'app'|'f', ...]
            if (parts[1] !== this.token) {
                this.deny(res, 404)
                return
            }
            if (parts[2] === 'app' && parts.length === 4) {
                this.serveAsset(req, res, decodeURIComponent(parts[3]))
            } else if (parts[2] === 'f' && parts.length >= 4) {
                this.serveFile(req, res, parts[3])
            } else {
                this.deny(res, 404)
            }
        } catch {
            this.deny(res, 404)
        }
    }

    private serveAsset (req: http.IncomingMessage, res: http.ServerResponse, name: string): void {
        // 파일 이름만 허용 (경로 문자 없음) + 허용 확장자
        const type = ASSET_TYPES[path.extname(name).toLowerCase()]
        if (!type || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
            this.deny(res, 404)
            return
        }
        const file = path.join(this.assetDir, name)
        fs.readFile(file, (err, data) => {
            if (err) {
                this.deny(res, 404)
                return
            }
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': data.length,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': VIEWER_CSP,
                'Cross-Origin-Resource-Policy': 'same-origin',
            })
            res.end(req.method === 'HEAD' ? undefined : data)
        })
    }

    private serveFile (req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
        const file = this.files.get(id)
        if (!file) {
            this.deny(res, 404)
            return
        }
        const type = VIEWER_EXTENSIONS[this.extensionOf(file)] ?? 'application/octet-stream'
        fs.stat(file, (err, stat) => {
            if (err || !stat.isFile()) {
                this.deny(res, 404)
                return
            }
            const headers: http.OutgoingHttpHeaders = {
                'Content-Type': type,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Cross-Origin-Resource-Policy': 'same-origin',
            }
            // PDF 보기는 구간 요청(Range)을 쓴다
            const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
            let start = 0
            let end = stat.size - 1
            let status = 200
            if (range && (range[1] || range[2])) {
                if (range[1]) {
                    start = Number(range[1])
                    end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
                } else {
                    start = Math.max(0, stat.size - Number(range[2]))
                }
                if (start > end || start >= stat.size) {
                    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
                    res.end()
                    return
                }
                status = 206
                headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
            }
            headers['Content-Length'] = end - start + 1
            res.writeHead(status, headers)
            if (req.method === 'HEAD' || stat.size === 0) {
                res.end()
                return
            }
            const stream = fs.createReadStream(file, { start, end })
            stream.on('error', () => res.destroy())
            res.on('close', () => stream.destroy())
            stream.pipe(res)
        })
    }
}
