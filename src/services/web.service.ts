import { Injectable } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { HagisSitePermission, HagisTrustedCertificate } from '../config'
import { HAGIS_SCRIPT_OPEN_PREFIX } from './openShim'
import { HAGIS_SEARCH_ENGINES, HagisSearchEngine, isSearchInput, searchUrlFor } from './address'

/** 웹 패널 전용 세션 — Tabby 본체와 쿠키·캐시·인증서 판단을 분리한다 */
export const HAGIS_WEB_PARTITION = 'persist:hagis-web'
/** 새 탭으로 열려던 링크를 패널 안에서 열라는 webContents 이벤트 (attachWindowOpenHandler) */
export const HAGIS_OPEN_IN_PLACE = 'hagis-open-in-place'
/** HTTP 인증(로그인 창) 요청 — webContents 이벤트 (attachLoginHandler) */
export const HAGIS_LOGIN_EVENT = 'hagis-login'
/** 단축키(찾기·인쇄·뒤로 등) — webContents 이벤트 (attachKeyHandler) */
export const HAGIS_KEY_EVENT = 'hagis-key'

/** 사이트가 마이크·카메라·위치 등을 쓰려 한다 — 요청한 패널이 답한다 */
export interface HagisPermissionPrompt {
    /** 요청한 웹 화면(webContents) 번호 */
    wcId: number
    origin: string
    /** media-audio | media-video | geolocation … */
    keys: string[]
    /** 어느 패널이 맡았다 (아무도 맡지 않으면 거부한다) */
    claimed: boolean
    answer: (allow: boolean, remember: boolean) => void
}

/** 화면 공유 — 공유할 화면·창을 고른다 */
export interface HagisCapturePrompt {
    wcId: number
    origin: string
    audio: boolean
    claimed: boolean
    sources: { id: string, name: string, thumbnail: string, isScreen: boolean }[]
    /** sourceId 가 null 이면 취소 */
    choose: (sourceId: string|null, withAudio: boolean) => void
}

/** 기억해 둘 수 있는 권한 이름 (사용자에게 보이는 말) */
export const HAGIS_PERMISSION_LABELS: Record<string, string> = {
    'media-audio': '마이크',
    'media-video': '카메라',
    geolocation: '위치',
    notifications: '알림',
    'clipboard-read': '클립보드 읽기',
    midi: 'MIDI 장치',
}

/** 묻지 않고 허용하는 권한 (Chrome 도 묻지 않는 것) */
const AUTO_ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock'])

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
 *  - 카메라·마이크·위치·알림은 사이트별로 사용자에게 물어 허용한 경우에만 열고, 그 밖의 권한 요청은 거부한다.
 */
@Injectable({ providedIn: 'root' })
export class HagisWebService {
    private initialized = false
    private certificateProblem = new Subject<HagisCertificateProblem>()
    /** 사용자 결정을 기다리는 인증서 검증 (호스트|지문 → Chromium 콜백) */
    private pendingDecisions = new Map<string, { problem: HagisCertificateProblem, callbacks: ((result: number) => void)[] }>()
    private logger: Logger

    private certificateDecided = new Subject<{ problem: HagisCertificateProblem, trusted: boolean }>()
    private permissionPrompt = new Subject<HagisPermissionPrompt>()
    private capturePrompt = new Subject<HagisCapturePrompt>()
    /** 메인 프로세스의 권한 확인 창구 (허용으로 기억한 것 목록) */
    private permissionStore: any = null
    private permissionStoreSync: ((store: any, json: string) => void)|null = null

    get permissionPrompt$ (): Observable<HagisPermissionPrompt> { return this.permissionPrompt }
    get capturePrompt$ (): Observable<HagisCapturePrompt> { return this.capturePrompt }

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

    private loginHook: ((wc: any, eventName: string) => void)|null = null
    private keyHook: ((wc: any, eventName: string, flags: any) => void)|null = null

    /**
     * HTTP 인증(Basic·Digest·NTLM) 로그인 요청 처리
     * Electron 은 이 이벤트를 아무도 받지 않으면 인증을 조용히 취소한다 (장비의 401 화면만 보인다).
     * 요청을 가로채(preventDefault 는 메인 프로세스에서 즉시 해야 한다) 패널에 알리고, 패널이 답을 callback 으로 넘긴다.
     * callback(아이디, 비밀번호) = 로그인, callback() = 취소.
     */
    attachLoginHandler (wc: any): void {
        if (!this.loginHook) {
            const MainFunction = this.remote.getGlobal('Function')
            this.loginHook = MainFunction('wc', 'eventName', `
                wc.on('login', function (event, details, authInfo, callback) {
                    event.preventDefault();
                    try {
                        wc.emit(eventName, !!authInfo.isProxy, String(authInfo.scheme || ''), String(authInfo.host || ''),
                            Number(authInfo.port) || 0, String(authInfo.realm || ''), callback);
                    } catch (e) { try { callback(); } catch (e2) { } }
                });
            `)
        }
        this.loginHook!(wc, HAGIS_LOGIN_EVENT)
    }

    /**
     * 웹 화면이 키보드 포커스를 가진 동안의 브라우저 단축키 (찾기·인쇄·뒤로·새로고침·확대 등)
     * Electron 의 WebContents 에는 Chrome 의 기본 단축키가 없고, Tabby 의 단축키도 이때는 동작하지 않는다.
     * 키를 가로채는 판단은 메인 프로세스에서 즉시 해야 하므로 작은 처리 함수를 붙인다 (코드는 고정 문자열).
     * 글쇠 위치(code)로 판단하므로 한글 입력 상태에서도 같다.
     */
    attachKeyHandler (wc: any): void {
        if (!this.keyHook) {
            const MainFunction = this.remote.getGlobal('Function')
            this.keyFlags = MainFunction('return { on: true }')()
            this.keyHook = MainFunction('wc', 'eventName', 'flags', `
                wc.on('before-input-event', function (event, input) {
                    if (input.type !== 'keyDown' || !flags.on) { return; }
                    var code = input.code, ctrl = !!(input.control || input.meta), alt = !!input.alt, shift = !!input.shift;
                    var cmd = '';
                    if (ctrl && !alt && !shift && code === 'KeyF') { cmd = 'find'; }
                    else if (code === 'F3' && !ctrl && !alt) { cmd = shift ? 'find-prev' : 'find-next'; }
                    else if (ctrl && !alt && code === 'KeyG') { cmd = shift ? 'find-prev' : 'find-next'; }
                    else if (ctrl && !alt && !shift && code === 'KeyP') { cmd = 'print'; }
                    else if ((code === 'F12' && !ctrl && !alt) || (ctrl && shift && !alt && code === 'KeyI')) { cmd = 'devtools'; }
                    else if (alt && !ctrl && !shift && code === 'ArrowLeft') { cmd = 'back'; }
                    else if (alt && !ctrl && !shift && code === 'ArrowRight') { cmd = 'forward'; }
                    else if (code === 'F5' && !alt) { cmd = (ctrl || shift) ? 'hard-reload' : 'reload'; }
                    else if (ctrl && !alt && code === 'KeyR') { cmd = shift ? 'hard-reload' : 'reload'; }
                    else if ((ctrl && !alt && !shift && code === 'KeyL') || (alt && !ctrl && !shift && code === 'KeyD') || (code === 'F6' && !ctrl && !alt && !shift)) { cmd = 'address'; }
                    else if (ctrl && !alt && (code === 'Equal' || code === 'NumpadAdd')) { cmd = 'zoom-in'; }
                    else if (ctrl && !alt && (code === 'Minus' || code === 'NumpadSubtract')) { cmd = 'zoom-out'; }
                    else if (ctrl && !alt && !shift && (code === 'Digit0' || code === 'Numpad0')) { cmd = 'zoom-reset'; }
                    if (!cmd) { return; }
                    event.preventDefault();
                    try { wc.emit(eventName, cmd); } catch (e) { }
                });
            `)
        }
        this.syncKeyFlag()
        this.keyHook!(wc, HAGIS_KEY_EVENT, this.keyFlags)
    }

    private keyFlags: any = null

    /**
     * 설정 "브라우저 단축키" 를 메인 프로세스의 단축키 처리 함수에 알린다.
     * 끄면 모든 키가 페이지로 그대로 간다 (Ctrl+F·Ctrl+P 를 자체 기능으로 쓰는 웹 앱용).
     */
    syncKeyFlag (): void {
        try {
            if (this.keyFlags) {
                this.keyFlags.on = this.config.store?.hagis?.web?.shortcuts !== false
            }
        } catch (e) {
            this.logger.warn('key flag sync failed', e)
        }
    }

    /**
     * 실제 엔진(Chromium) 버전을 따르는 순정 Chrome 형태의 UA (Chrome 은 버전 뒤쪽을 0.0.0 으로 줄여 보낸다)
     * Electron 기본 UA 의 "tabby/… Electron/…" 표기를 보고 ChatGPT 가 구조도·표·코드 블록을 그리는 새 화면 대신
     * 단순한 구형 화면(문단으로만 표시)을 내려주는 것을 실제 Chrome 과 비교해 확인했다.
     */
    private chromeUserAgent (): string {
        const major = String(process.versions.chrome ?? '').split('.')[0] || '130'
        const platform = process.platform === 'darwin'
            ? 'Macintosh; Intel Mac OS X 10_15_7'
            : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'
        return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    }

    /**
     * 사이트에 알릴 언어 순서 (Accept-Language) — 이 PC의 언어 설정을 따른다.
     * Tabby 본체가 Chromium 을 영어(--lang=EN)로 고정해 두어서, 그대로 두면 모든 사이트가 영어 화면으로 열린다.
     */
    private acceptLanguages (): string {
        const list: string[] = []
        const add = (tag: string) => {
            const value = String(tag || '').replace(/_/g, '-').trim()
            if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) && !list.includes(value)) {
                list.push(value)
            }
        }
        try {
            const locale = String(this.remote.app.getSystemLocale?.() ?? '')
            add(locale)
            add(locale.split('-')[0])
        } catch { }
        add('en-US')
        add('en')
        return list.join(',')
    }

    ensureSession (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true
        const session = this.getSession()
        this.installVerifyProc()

        try {
            session.setUserAgent(this.chromeUserAgent(), this.acceptLanguages())
        } catch (e) {
            this.logger.error('setUserAgent failed', e)
        }

        // 권한 요청: Chrome 처럼 사이트별로 묻는다 (마이크·카메라·위치·알림). 나머지는 거부.
        // 요청은 콜백 방식이라 비동기로 답해도 되지만, "확인" 쪽은 메인 프로세스에서 즉시 답해야 해서 작은 함수를 붙인다.
        session.setPermissionRequestHandler((wc: any, permission: string, callback: (granted: boolean) => void, details: any) => {
            try {
                this.onPermissionRequest(wc, permission, callback, details)
            } catch (e) {
                this.logger.error('permission request failed', e)
                callback(false)
            }
        })
        try {
            this.installPermissionCheck(session)
        } catch (e) {
            this.logger.error('permission check failed', e)
        }
        // 화면 공유 (getDisplayMedia) — 공유할 화면·창을 고르는 선택 줄을 직접 띄운다 (Windows 에는 시스템 선택 창이 없다)
        try {
            session.setDisplayMediaRequestHandler((request: any, callback: (streams: any) => void) => {
                this.onDisplayMediaRequest(request, callback).catch(e => {
                    this.logger.error('display media request failed', e)
                    try { callback({}) } catch { }
                })
            })
        } catch (e) {
            this.logger.error('display media handler failed', e)
        }

        // 렌더러가 다시 로드되면 remote 콜백이 끊기므로 기본 검증으로 되돌린다
        window.addEventListener('beforeunload', () => {
            for (const pending of [...this.pendingDecisions.values()]) {
                this.reject(pending.problem)
            }
            try {
                session.setCertificateVerifyProc(null)
                session.setPermissionRequestHandler(null)
                session.setPermissionCheckHandler(null)
                session.setDisplayMediaRequestHandler(null)
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

    // ---------------------------------------------------------------- 사이트 권한 (마이크·카메라·위치·알림·화면 공유)

    get sitePermissions (): HagisSitePermission[] {
        return this.config.store?.hagis?.web?.sitePermissions ?? []
    }

    private originOf (url: string): string {
        try {
            const origin = new URL(url).origin
            return origin === 'null' ? '' : origin
        } catch {
            return ''
        }
    }

    /** Electron 권한 이름 → 기억해 둘 권한 키 (묻지 않을 것은 빈 배열) */
    private permissionKeys (permission: string, details: any): string[] {
        switch (permission) {
            case 'media': {
                const types: string[] = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
                const keys: string[] = []
                if (types.includes('audio')) { keys.push('media-audio') }
                if (types.includes('video')) { keys.push('media-video') }
                return keys.length ? keys : ['media-audio', 'media-video']
            }
            case 'geolocation': return ['geolocation']
            case 'notifications': return ['notifications']
            case 'clipboard-read': return ['clipboard-read']
            case 'midi':
            case 'midiSysex': return ['midi']
            default: return []
        }
    }

    private remembered (origin: string, key: string): boolean|null {
        const found = this.sitePermissions.find(x => x.origin === origin && x.permission === key)
        return found ? found.allow : null
    }

    private onPermissionRequest (wc: any, permission: string, callback: (granted: boolean) => void, details: any): void {
        if (AUTO_ALLOWED_PERMISSIONS.has(permission)) {
            callback(true)
            return
        }
        // 화면 공유(getDisplayMedia)는 mediaTypes 가 빈 'media' 요청으로 먼저 온다 (카메라·마이크는 ['video']·['audio'])
        // 실제 동의는 이어지는 "공유할 화면 고르기" 단계(onDisplayMediaRequest)에서 받으므로 여기서는 통과시킨다
        if (permission === 'media' && Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 0) {
            callback(true)
            return
        }
        const keys = this.permissionKeys(permission, details)
        const origin = this.originOf(String(details?.requestingUrl || (() => { try { return wc.getURL() } catch { return '' } })()))
        if (!keys.length || !origin) {
            callback(false)
            return
        }
        const known = keys.map(k => this.remembered(origin, k))
        if (known.some(x => x === false)) {
            callback(false)
            return
        }
        if (known.every(x => x === true)) {
            callback(true)
            return
        }
        const prompt: HagisPermissionPrompt = {
            wcId: Number(wc?.id) || 0,
            origin,
            keys,
            claimed: false,
            answer: (allow, remember) => {
                if (remember) {
                    this.rememberPermissions(origin, keys, allow).catch(() => null)
                }
                try {
                    callback(allow)
                } catch (e) {
                    this.logger.warn('permission callback failed', e)
                }
            },
        }
        this.permissionPrompt.next(prompt)
        if (!prompt.claimed) {
            callback(false) // 물어볼 패널이 없다 (팝업 창 등)
        }
    }

    /**
     * 권한 "확인" (permissions.query·장치 이름 공개 여부) — 메인 프로세스에서 즉시 답해야 한다.
     * 허용으로 기억한 것만 "허용"이라 답한다 (전에는 거부하면서 "허용"이라 답해 사이트가 헷갈렸다).
     * 위에 나열하지 않은 권한은 Electron 기본 동작 그대로 둔다.
     */
    private installPermissionCheck (session: any): void {
        const MainFunction = this.remote.getGlobal('Function')
        this.permissionStore = MainFunction('return { allow: {} }')()
        this.permissionStoreSync = MainFunction('store', 'json', 'store.allow = JSON.parse(json)')
        MainFunction('session', 'store', `
            session.setPermissionCheckHandler(function (wc, permission, origin, details) {
                var key = permission;
                if (permission === 'media') {
                    var type = details && details.mediaType;
                    if (type === 'video') { key = 'media-video'; }
                    else if (type === 'audio') { key = 'media-audio'; }
                    else { return store.allow[String(origin).replace(/\\/$/, '') + '|media-audio'] === true || store.allow[String(origin).replace(/\\/$/, '') + '|media-video'] === true; }
                } else if (permission === 'midiSysex') { key = 'midi'; }
                if (['media-audio', 'media-video', 'geolocation', 'notifications', 'clipboard-read', 'midi'].indexOf(key) < 0) { return true; }
                return store.allow[String(origin).replace(/\\/$/, '') + '|' + key] === true;
            });
        `)(session, this.permissionStore)
        this.syncPermissionStore()
    }

    private syncPermissionStore (): void {
        if (!this.permissionStore || !this.permissionStoreSync) {
            return
        }
        const allow: Record<string, boolean> = {}
        for (const p of this.sitePermissions) {
            if (p.allow) {
                allow[`${p.origin}|${p.permission}`] = true
            }
        }
        try {
            this.permissionStoreSync(this.permissionStore, JSON.stringify(allow))
        } catch (e) {
            this.logger.warn('permission store sync failed', e)
        }
    }

    private async rememberPermissions (origin: string, keys: string[], allow: boolean): Promise<void> {
        const list = this.sitePermissions.filter(x => !(x.origin === origin && keys.includes(x.permission)))
        for (const key of keys) {
            list.push({ origin, permission: key, allow, addedAt: new Date().toISOString() })
        }
        this.config.store.hagis.web.sitePermissions = list
        this.syncPermissionStore()
        await this.config.save()
    }

    /** 기억해 둔 권한을 지운다 (다음에 다시 묻는다) */
    async forgetPermission (entry: HagisSitePermission): Promise<void> {
        this.config.store.hagis.web.sitePermissions = this.sitePermissions.filter(
            x => !(x.origin === entry.origin && x.permission === entry.permission),
        )
        this.syncPermissionStore()
        await this.config.save()
    }

    /** getDisplayMedia — 공유할 화면·창 목록을 만들어 요청한 패널에 보여 준다 */
    private async onDisplayMediaRequest (request: any, callback: (streams: any) => void): Promise<void> {
        const origin = this.originOf(String(request?.securityOrigin ?? ''))
        let wcId = 0
        try {
            wcId = Number(this.remote.webContents.fromFrame(request.frame)?.id) || 0
        } catch { }
        const desktopCapturer = this.getBuiltin('desktopCapturer')
        const raw: any[] = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 320, height: 200 },
            fetchWindowIcons: false,
        })
        const sources = raw.map(source => {
            let thumbnail = ''
            try {
                thumbnail = 'data:image/jpeg;base64,' + Buffer.from(source.thumbnail.toJPEG(70)).toString('base64')
            } catch { }
            return { id: String(source.id), name: String(source.name), thumbnail, isScreen: String(source.id).startsWith('screen:') }
        })
        const prompt: HagisCapturePrompt = {
            wcId,
            origin,
            audio: !!request?.audioRequested,
            claimed: false,
            sources,
            choose: (sourceId, withAudio) => {
                const chosen = sourceId ? sources.find(x => x.id === sourceId) : null
                try {
                    if (!chosen) {
                        callback({})
                    } else {
                        callback(withAudio && prompt.audio ? { video: { id: chosen.id, name: chosen.name }, audio: 'loopback' } : { video: { id: chosen.id, name: chosen.name } })
                    }
                } catch (e) {
                    this.logger.warn('display media callback failed', e)
                }
            },
        }
        this.capturePrompt.next(prompt)
        if (!prompt.claimed) {
            callback({})
        }
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
        if (this.isSearch(input)) {
            return { url: this.searchUrl(input), fallback: null }
        }
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

    /** 주소창에서 쓰는 검색 엔진 (설정 → 웹 GUI 패널 → 주소창에 검색어 입력) */
    get searchEngine (): HagisSearchEngine {
        const engine = this.config.store?.hagis?.web?.searchEngine
        return engine && (engine === 'off' || engine in HAGIS_SEARCH_ENGINES) ? engine : 'google'
    }

    /** 입력이 주소가 아니라 검색어인가 */
    isSearch (input: string): boolean {
        return isSearchInput(input, this.searchEngine)
    }

    searchUrl (query: string): string {
        return searchUrlFor(query, this.searchEngine)
    }

    /** 사용자 입력 주소를 정규화: 검색어면 검색 주소, 스킴이 없으면 https:// */
    normalizeUrl (input: string): string {
        const value = input.trim()
        if (!value) {
            return ''
        }
        if (this.isSearch(value)) {
            return this.searchUrl(value)
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
            return `${host} 가 로그인(HTTP 인증)을 요구합니다 (${status}). 로그인을 취소했거나 아이디·비밀번호가 맞지 않습니다. 새로고침(F5)하면 다시 묻습니다.`
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
