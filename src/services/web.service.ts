import { Injectable } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { HagisTrustedCertificate } from '../config'
import { HAGIS_SCRIPT_OPEN_PREFIX } from './openShim'

/** 웹 패널 전용 세션 — Tabby 본체와 쿠키·캐시·인증서 판단을 분리한다 */
export const HAGIS_WEB_PARTITION = 'persist:hagis-web'
/** 새 탭으로 열려던 링크를 패널 안에서 열라는 webContents 이벤트 (attachWindowOpenHandler) */
export const HAGIS_OPEN_IN_PLACE = 'hagis-open-in-place'

export interface HagisCertificateProblem {
    host: string
    fingerprint: string
    subject: string
    issuer: string
    validExpiry: number
    verificationResult: string
}

/**
 * 웹 GUI 패널의 Electron 세션 관리
 *
 * 보안 원칙 (계획서 "개발할 때 꼭 고려할 사항"):
 *  - 인증서 검증을 전역으로 끄지 않는다. 오류가 난 인증서는 사용자가 호스트별로
 *    지문(SHA-256)을 확인하고 명시적으로 신뢰한 경우에만 허용한다.
 *  - 웹 콘텐츠에는 Node.js 권한을 주지 않는다 (sandbox, contextIsolation).
 *  - 카메라·마이크·위치 등 권한 요청은 모두 거부한다.
 */
@Injectable({ providedIn: 'root' })
export class HagisWebService {
    private initialized = false
    private certificateProblem = new Subject<HagisCertificateProblem>()
    /** 사용자 결정을 기다리는 인증서 검증 (호스트|지문 → Chromium 콜백) */
    private pendingDecisions = new Map<string, { problem: HagisCertificateProblem, callbacks: ((result: number) => void)[] }>()
    private logger: Logger

    private certificateDecided = new Subject<{ problem: HagisCertificateProblem, trusted: boolean }>()

    get certificateProblem$ (): Observable<HagisCertificateProblem> { return this.certificateProblem }
    /** 신뢰/거부가 결정됨 → 같은 인증서를 기다리던 모든 웹 패널이 배너를 닫고 (신뢰면) 다시 접속 */
    get certificateDecided$ (): Observable<{ problem: HagisCertificateProblem, trusted: boolean }> { return this.certificateDecided }

    constructor (
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('hagis-web')
    }

    get remote (): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@electron/remote')
    }

    /**
     * 메인 프로세스의 Electron 클래스 (예: WebContentsView)
     * Tabby 메인 프로세스는 번들이라 remote.require()가 동작하지 않으므로 getBuiltin을 쓴다
     */
    getBuiltin (name: string): any {
        return this.remote.getBuiltin(name)
    }

    getSession (): any {
        return this.remote.session.fromPartition(HAGIS_WEB_PARTITION)
    }

    private windowOpenHook: ((wc: any, eventName: string) => void)|null = null

    /**
     * 새 창 열기 처리
     *
     * 웹 패널의 target=_blank 링크·window.open 을 종류별로 나눈다.
     *  - 진짜 팝업 → 그대로 팝업 창으로 띄우고 맨 앞으로 가져온다:
     *      크기·위치를 지정한 window.open (로그인·인쇄·첨부 보기), 빈 창(about:blank)과 blob:/data:/javascript: 창
     *      (페이지가 직접 내용을 채우는 창), 양식 POST (패널로는 POST 를 옮길 수 없다)
     *      + 스크립트의 window.open(주소): 열어 준 창 핸들(opener·postMessage)이 있어야 하는 사이트가 많아 창으로 연다
     *        (페이지에 심은 openShim.ts 의 코드가 창 이름에 표식을 붙여 링크 클릭과 구분한다)
     *  - "새 탭으로 열기" 링크 → 막고 HAGIS_OPEN_IN_PLACE 이벤트로 알린다 (설정에 따라 새 패널 또는 이 패널에서 연다)
     *
     * 허용/거부는 메인 프로세스에서 즉시 답해야 한다 — remote 콜백은 비동기라 답을 돌려줄 수 없으므로,
     * 메인 프로세스에 작은 처리 함수를 만들어 붙인다 (코드는 아래 고정 문자열, 사용자 입력은 들어가지 않는다).
     */
    attachWindowOpenHandler (wc: any): void {
        if (!this.windowOpenHook) {
            const MainFunction = this.remote.getGlobal('Function')
            this.windowOpenHook = MainFunction('wc', 'eventName', `
                wc.setWindowOpenHandler(function (details) {
                    var url = String(details.url || '');
                    var popup = details.disposition === 'new-window'
                        || String(details.frameName || '').indexOf('${HAGIS_SCRIPT_OPEN_PREFIX}') === 0
                        || url === '' || url === 'about:blank'
                        || /^(blob|data|javascript):/i.test(url)
                        || !!details.postBody;
                    if (popup) {
                        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
                    }
                    // http(s) 외의 주소(mailto: 등)는 열지 않는다. 열 수 없는 것도 이벤트로 알려 화면에 안내한다.
                    setImmediate(function () {
                        try { if (!wc.isDestroyed()) wc.emit(eventName, url, details.disposition, /^https?:/i.test(url), String(details.frameName || '')); } catch (e) { }
                    });
                    return { action: 'deny' };
                });
                // 팝업이 다른 창 뒤에 숨어 "아무 반응이 없는" 것처럼 보이지 않게 맨 앞으로
                wc.on('did-create-window', function (win) {
                    try { win.show(); win.moveTop(); win.focus(); } catch (e) { }
                });
            `)
        }
        this.windowOpenHook!(wc, HAGIS_OPEN_IN_PLACE)
    }

    ensureSession (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true
        const session = this.getSession()
        this.installVerifyProc()

        session.setPermissionRequestHandler((_wc: any, permission: string, callback: (granted: boolean) => void) => {
            callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
        })

        // 렌더러가 다시 로드되면 remote 콜백이 끊기므로 기본 검증으로 되돌린다
        window.addEventListener('beforeunload', () => {
            for (const pending of [...this.pendingDecisions.values()]) {
                this.reject(pending.problem)
            }
            try {
                session.setCertificateVerifyProc(null)
                session.setPermissionRequestHandler(null)
            } catch { }
        })
    }

    /**
     * 인증서 검증
     * 모르는 인증서 오류는 바로 거부하지 않고 사용자가 결정할 때까지 응답을 보류한다.
     * Chromium은 검증 결과를 세션 안에서 캐시하므로, 먼저 거부해 버리면 나중에 신뢰해도 다시 묻지 않는다.
     */
    private installVerifyProc (): void {
        const session = this.getSession()
        session.setCertificateVerifyProc((request: any, callback: (result: number) => void) => {
            try {
                if (request.errorCode === 0) {
                    callback(-3) // Chromium 기본 검증 결과 사용
                    return
                }
                const fingerprint = request.certificate?.fingerprint ?? ''
                if (this.isTrusted(request.hostname, fingerprint)) {
                    callback(0)
                    return
                }
                const key = this.problemKey(request.hostname, fingerprint)
                const pending = this.pendingDecisions.get(key)
                if (pending) {
                    pending.callbacks.push(callback)
                    this.certificateProblem.next(pending.problem)
                    return
                }
                const problem: HagisCertificateProblem = {
                    host: request.hostname,
                    fingerprint,
                    subject: request.certificate?.subjectName ?? '',
                    issuer: request.certificate?.issuerName ?? '',
                    validExpiry: request.certificate?.validExpiry ?? 0,
                    verificationResult: request.verificationResult,
                }
                this.pendingDecisions.set(key, { problem, callbacks: [callback] })
                this.certificateProblem.next(problem)
            } catch (e) {
                this.logger.error('certificate verify failed', e)
                callback(-2)
            }
        })
    }

    private problemKey (host: string, fingerprint: string): string {
        return `${host}|${fingerprint}`
    }

    /** 보류 중인 인증서 검증에 답한다 (0 = 허용, -2 = 거부) */
    private decide (problem: HagisCertificateProblem, result: number): void {
        const key = this.problemKey(problem.host, problem.fingerprint)
        const pending = this.pendingDecisions.get(key)
        this.pendingDecisions.delete(key)
        this.certificateDecided.next({ problem, trusted: result === 0 })
        for (const callback of pending?.callbacks ?? []) {
            try {
                callback(result)
            } catch (e) {
                this.logger.warn('certificate decision callback failed', e)
            }
        }
    }

    /**
     * 확정 거부 — 앱 종료 시에만 사용한다.
     * 거부도 Chromium에 캐시되므로, 사용자가 "신뢰하지 않음"을 눌렀을 때는 거부하지 않고 보류 상태로 둔다.
     * (나중에 같은 주소를 다시 열면 확인 배너가 다시 나타나고, 그때 신뢰할 수 있다)
     */
    reject (problem: HagisCertificateProblem): void {
        this.decide(problem, -2)
    }

    /**
     * 이 호스트에 대해 결정을 기다리는 인증서
     * Chromium은 같은 인증서 검증이 진행 중이면 새 요청을 거기에 합치므로 검증 함수가 다시 불리지 않는다.
     * 그래서 주소를 열 때마다 직접 확인해 배너를 다시 띄운다.
     */
    pendingProblemFor (host: string): HagisCertificateProblem|null {
        for (const pending of this.pendingDecisions.values()) {
            if (pending.problem.host === host) {
                return pending.problem
            }
        }
        return null
    }

    get trustedCertificates (): HagisTrustedCertificate[] {
        return this.config.store?.hagis?.web?.trustedCertificates ?? []
    }

    isTrusted (host: string, fingerprint: string): boolean {
        return this.trustedCertificates.some(x => x.host === host && x.fingerprint === fingerprint)
    }

    async trust (problem: HagisCertificateProblem): Promise<void> {
        if (!this.isTrusted(problem.host, problem.fingerprint)) {
            this.config.store.hagis.web.trustedCertificates = [
                ...this.trustedCertificates,
                {
                    host: problem.host,
                    fingerprint: problem.fingerprint,
                    subject: problem.subject,
                    addedAt: new Date().toISOString(),
                },
            ]
            await this.config.save()
        }
        this.decide(problem, 0)
    }

    /** 신뢰 철회 — 이미 열린 세션의 검증 캐시 때문에 Tabby 재시작 후 완전히 적용된다 */
    async untrust (cert: HagisTrustedCertificate): Promise<void> {
        this.config.store.hagis.web.trustedCertificates = this.trustedCertificates.filter(
            x => !(x.host === cert.host && x.fingerprint === cert.fingerprint),
        )
        await this.config.save()
        try {
            await this.getSession().closeAllConnections()
        } catch { }
    }

    async clearBrowsingData (): Promise<void> {
        const session = this.getSession()
        await session.clearStorageData()
        await session.clearCache()
    }

    /**
     * 사용자 입력 → 실제로 열 주소와 실패 시 대체 주소
     * Chrome의 HTTPS 우선 동작과 같다: http:// 나 스킴 없는 주소는 https:// 를 먼저 시도하고,
     * 연결이 안 되면 http:// 로 다시 시도한다. (장비 관리 페이지는 443만 열린 경우가 많다)
     */
    resolveNavigation (input: string): { url: string, fallback: string|null } {
        const url = this.normalizeUrl(input)
        const httpsFirst = this.config.store?.hagis?.web?.httpsFirst ?? true
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())
        if (httpsFirst && url.startsWith('http://')) {
            return { url: 'https://' + url.substring('http://'.length), fallback: url }
        }
        if (!hasScheme && url.startsWith('https://')) {
            return { url, fallback: 'http://' + url.substring('https://'.length) }
        }
        return { url, fallback: null }
    }

    /** 사용자 입력 주소를 정규화: 스킴이 없으면 https:// */
    normalizeUrl (input: string): string {
        const value = input.trim()
        if (!value) {
            return ''
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('about:')) {
            return value
        }
        return `https://${value}`
    }

    /**
     * HTTP 오류 응답 설명 — 장비가 빈 403 페이지를 돌려주면 화면이 그냥 비어 보이므로 이유를 알려 준다
     */
    async describeHttpProblem (url: string, code: number, statusText: string): Promise<string> {
        let host = ''
        try {
            host = new URL(url).hostname
        } catch { }
        const status = `HTTP ${code}${statusText ? ' ' + statusText : ''}`
        if (code === 403) {
            const local = await this.localAddressFor(host)
            return `${host} 가 이 PC의 접속을 거부했습니다 (${status}). `
                + `장비의 관리 접속 허용 IP에 이 PC${local ? ` (${local})` : ''}가 들어 있는지 확인하세요 — 중간에 NAT 가 있으면 장비에는 NAT 주소로 보입니다. `
                + '로그인 실패로 잠긴 경우에도 이렇게 응답합니다.'
        }
        if (code === 401) {
            return `${host} 가 로그인(HTTP 인증)을 요구합니다 (${status}). 웹 패널은 아직 HTTP 기본 인증 창을 지원하지 않으니 ↗ 버튼으로 기본 브라우저에서 여세요.`
        }
        if (code === 404) {
            return `페이지를 찾을 수 없습니다 (${status}). 주소를 확인하세요.`
        }
        if (code >= 500) {
            return `${host} 웹 서버 오류입니다 (${status}). 잠시 뒤 새로고침하세요.`
        }
        return `${host} 가 오류로 응답했습니다 (${status}).`
    }

    /**
     * 이 PC가 그 장비로 나갈 때 쓰는 자기 주소 (라우팅 표 기준)
     * UDP 소켓을 "연결"만 하면 OS가 출발 주소를 고른다 — 패킷은 보내지 않는다.
     */
    localAddressFor (host: string): Promise<string> {
        return new Promise(resolve => {
            if (!host) {
                resolve('')
                return
            }
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const socket = require('dgram').createSocket(host.includes(':') ? 'udp6' : 'udp4')
                let settled = false
                const done = (value: string) => {
                    if (settled) {
                        return
                    }
                    settled = true
                    try {
                        socket.close()
                    } catch { }
                    resolve(value)
                }
                socket.on('error', () => done(''))
                socket.connect(9, host, () => {
                    try {
                        done(socket.address().address)
                    } catch {
                        done('')
                    }
                })
                setTimeout(() => done(''), 1500)
            } catch {
                resolve('')
            }
        })
    }

    /** 웹 패널에서 허용하는 주소인지 (file:, javascript: 등 차단) */
    isAllowedUrl (url: string): boolean {
        return /^https?:\/\//i.test(url) || url === 'about:blank'
    }
}
