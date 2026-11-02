import { Injectable } from '@angular/core'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigService, Logger, LogService, NotificationsService, TabRecoveryService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

/** 명령줄을 확인해야 이름만으로는 구분되지 않는 런타임 (npm 으로 설치한 CLI 는 node.exe 로 보인다) */
/** windows-process-tree ProcessDataFlag.CommandLine */
const PROCESS_DATA_COMMAND_LINE = 2

const RUNTIME_PROCESSES = ['node', 'node.exe', 'bun', 'bun.exe', 'deno', 'deno.exe', 'python', 'python.exe', 'python3', 'cmd.exe']

/** 값을 하나 받는 ssh 옵션 */
const SSH_OPTIONS_WITH_VALUE = 'BbcDEeFIiJLlmOoPpQRSWw'

/** `ssh -p 2222 admin@10.0.0.1` → `admin@10.0.0.1:2222` (Tabby 빠른 연결 형식) */
export function parseSshCommand (commandLine: string): string|null {
    const tokens = (commandLine.match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, ''))
    const start = tokens.findIndex(t => /(^|[\\/])ssh(\.exe)?$/i.test(t))
    if (start < 0) {
        return null
    }
    let user = ''
    let port = ''
    let destination = ''
    for (let i = start + 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.startsWith('-') && t.length >= 2) {
            const flag = t[1]
            if (SSH_OPTIONS_WITH_VALUE.includes(flag)) {
                const value = t.length > 2 ? t.substring(2) : tokens[++i] ?? ''
                if (flag === 'p') {
                    port = value
                } else if (flag === 'l') {
                    user = value
                }
            }
            continue
        }
        destination = t
        break
    }
    if (!destination) {
        return null
    }
    const url = destination.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?/)
    if (url) {
        user = url[1] ?? user
        destination = url[2]
        port = url[3] ?? port
    } else if (destination.includes('@')) {
        user = destination.substring(0, destination.lastIndexOf('@'))
        destination = destination.substring(destination.lastIndexOf('@') + 1)
    }
    return `${user ? user + '@' : ''}${destination}${port ? ':' + port : ''}`
}

interface ResumeRule {
    match: string
    command: string
}

/**
 * 터미널 이어가기
 *
 * Tabby를 종료하면 터미널 안의 프로세스(예: claude)는 함께 끝난다. Tabby 자체 복원은 작업 폴더와 화면 내용만 되살린다.
 * hagis는 저장 시점에 각 패널에서 실행 중인 프로그램을 확인해 "이어가기 명령"을 함께 기록하고,
 * 다시 열릴 때 같은 폴더에서 그 명령(예: claude --continue)을 자동으로 실행한다.
 *
 *  - Tabby 재시작 복원: 터미널 복원 토큰에 hagisResume / hagisStartup 을 덧붙인다
 *  - 워크스페이스 저장·열기: 패널 노드에 cwd / resume / startupPinned 를 저장한다
 *  - 패널마다 직접 지정한 "시작 명령"(hagisStartup)은 감지 결과보다 우선한다
 */
@Injectable({ providedIn: 'root' })
export class HagisResumeService {
    private cmdlineCache = new Map<number, string>()
    private started = new WeakSet<object>()
    /** 진단용 카운터 */
    stats = { initAt: 0, recoverCalls: 0, resumeTokens: 0 }
    private logger: Logger

    constructor (
        private config: ConfigService,
        private tabRecovery: TabRecoveryService,
        private notifications: NotificationsService,
        log: LogService,
    ) {
        this.logger = log.create('hagis-resume')
    }

    init (): void {
        this.stats.initAt = Date.now()
        this.store = this.readStore()
        const service: any = this.tabRecovery

        // 저장: 모든 터미널의 복원 토큰에 패널 ID 와 이어가기 정보를 붙인다.
        // (터미널이 화면에 한 번도 표시되지 않았어도 — 아직 실행하지 못한 이어가기 명령은 그대로 보존)
        const originalGetToken = service.getFullRecoveryToken.bind(service)
        service.getFullRecoveryToken = async (tab: any, ...rest: any[]) => {
            const token = await originalGetToken(tab, ...rest)
            // 메인 무대 역할은 모든 패널 종류에 붙인다
            if (token && (tab?.hagisStage === 'main' || tab?.hagisStage === 'preview')) {
                token.hagisStage = tab.hagisStage
            }
            if (token && tab instanceof BaseTerminalTabComponent) {
                try {
                    const id = this.paneId(tab)
                    token.hagisPaneId = id
                    const pending: string|undefined = (tab as any).hagisResume
                    const command = pending || await this.resumeCommandFor(tab)
                    if (command) {
                        token.hagisResume = command
                    }
                    if (this.getPinned(tab)) {
                        token.hagisStartup = this.getPinned(tab)
                    }
                    this.remember(id, command ?? null, this.getPinned(tab) || null)
                } catch (e) {
                    this.logger.warn('resume detection failed', e)
                }
            }
            return token
        }

        // 복원: 이어가기 정보를 새 탭 입력값으로 넘긴다.
        // Tabby 복원 정보(localStorage)는 디스크 반영이 늦어 강제 종료·PC 다운 때 최근 상태가 빠질 수 있으므로,
        // 패널 ID 로 hagis-resume.json(즉시 기록)에서도 찾는다.
        const original = service.recoverTab.bind(service)
        service.recoverTab = async (token: any, ...rest: any[]) => {
            this.stats.recoverCalls++
            const params = await original(token, ...rest)
            if (!params || !token) {
                return params
            }
            const stored = token.hagisPaneId ? this.store[token.hagisPaneId] : undefined
            const resume = stored ? stored.command ?? undefined : token.hagisResume
            const startup = stored ? stored.pinned ?? undefined : token.hagisStartup
            if (resume) {
                this.stats.resumeTokens++
            }
            if (token.hagisPaneId || resume || startup) {
                params.inputs = {
                    ...params.inputs ?? {},
                    hagisPaneId: token.hagisPaneId,
                    hagisResume: resume,
                    hagisStartup: startup,
                }
            }
            if (token.hagisStage) {
                params.inputs = { ...params.inputs ?? {}, hagisStage: token.hagisStage }
            }
            return params
        }
    }

    // ---------------------------------------------------------------- 즉시 기록 저장소 (hagis-resume.json)

    private store: Record<string, { command: string|null, pinned: string|null, at: number }> = {}

    private storePath (): string {
        let dir = process.env.TABBY_CONFIG_DIRECTORY
        if (!dir) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                dir = require('@electron/remote').app.getPath('userData')
            } catch { }
        }
        return path.join(dir ?? '.', 'hagis-resume.json')
    }

    private readStore (): Record<string, { command: string|null, pinned: string|null, at: number }> {
        try {
            const data = JSON.parse(fs.readFileSync(this.storePath(), 'utf-8'))
            // 30일 넘게 갱신되지 않은 패널 정보는 정리
            const limit = Date.now() - 30 * 24 * 3600 * 1000
            return Object.fromEntries(Object.entries(data).filter(([, v]: any) => v?.at > limit)) as any
        } catch {
            return {}
        }
    }

    private remember (id: string, command: string|null, pinned: string|null): void {
        const prev = this.store[id]
        if (prev && prev.command === command && prev.pinned === pinned) {
            prev.at = Date.now()
            return
        }
        this.store[id] = { command, pinned, at: Date.now() }
        try {
            fs.writeFileSync(this.storePath(), JSON.stringify(this.store, null, 1), 'utf-8')
        } catch (e) {
            this.logger.warn('cannot write resume store', e)
        }
    }

    /** 패널 고유 ID — 한 번 정해지면 복원 토큰을 통해 계속 유지된다 */
    private paneId (tab: any): string {
        if (!tab.hagisPaneId) {
            tab.hagisPaneId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
        }
        return tab.hagisPaneId
    }

    get enabled (): boolean {
        return this.config.store?.hagis?.resume?.enabled ?? true
    }

    rules (): ResumeRule[] {
        const text: string = this.config.store?.hagis?.resume?.rules ?? ''
        return text.split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && line.includes('='))
            .map(line => {
                const i = line.indexOf('=')
                return { match: line.substring(0, i).trim().toLowerCase(), command: line.substring(i + 1).trim() }
            })
            .filter(rule => rule.match && rule.command)
    }

    /** 패널에 직접 지정한 시작 명령 */
    getPinned (terminal: BaseTerminalTabComponent<any>): string {
        return (terminal as any).hagisStartup ?? ''
    }

    setPinned (terminal: BaseTerminalTabComponent<any>, command: string): void {
        (terminal as any).hagisStartup = command.trim() || undefined
        ;(terminal as any).recoveryStateChangedHint?.next()
    }

    /**
     * 셸 아래에서 실행 중인 모든 하위 프로세스 (가까운 것부터)
     * Tabby의 session.getChildProcesses()는 Windows에서 truePID 가 0 으로 잡혀 빈 목록을 주는 경우가 있어
     * 셸 PID 로 프로세스 트리를 직접 조회한다. (예: cmd.exe → claude.exe, cmd.exe → npm shim → node.exe)
     */
    async descendants (terminal: BaseTerminalTabComponent<any>): Promise<{ pid: number, command: string }[]> {
        const session: any = terminal.session
        if (!session) {
            return []
        }
        if (process.platform === 'win32' && session.pty?.getPID) {
            try {
                const pid = await session.pty.getPID()
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const wpt = require('@tabby-gang/windows-process-tree')
                // CommandLine 플래그(2): 명령줄까지 한 번에 읽는다 — 예전처럼 PowerShell 을 띄우지 않는다
                const tree: any = await new Promise(resolve => wpt.getProcessTree(pid, resolve, PROCESS_DATA_COMMAND_LINE))
                const result: { pid: number, command: string }[] = []
                let level: any[] = tree?.children ?? []
                while (level.length) {
                    for (const node of level) {
                        result.push({ pid: node.pid, command: node.name })
                        if (node.commandLine) {
                            this.cmdlineCache.set(node.pid, node.commandLine)
                        }
                    }
                    level = level.flatMap(n => n.children ?? [])
                }
                this.pruneCmdlineCache()
                return result
            } catch (e) {
                this.logger.warn('process tree lookup failed', e)
            }
        }
        if (!session.getChildProcesses) {
            return [] // SSH 등 원격 세션은 프로세스를 알 수 없다 → 시작 명령을 직접 지정
        }
        try {
            return await session.getChildProcesses() ?? []
        } catch {
            return []
        }
    }

    /** 지금 이 패널에서 실행 중인 프로그램에 맞는 이어가기 명령 (없으면 null) */
    async detect (terminal: BaseTerminalTabComponent<any>): Promise<string|null> {
        if (!this.enabled) {
            return null
        }
        const children = await this.descendants(terminal)
        const rules = this.rules()
        for (const child of children) {
            const name = (child.command ?? '').split(/[\\/]/).pop()!.toLowerCase()
            let text = name
            if (RUNTIME_PROCESSES.includes(name)) {
                text += ' ' + (await this.commandLine(child.pid)).toLowerCase()
            }
            const rule = rules.find(r => text.includes(r.match))
            if (rule) {
                return rule.command
            }
        }
        return null
    }

    /** 다시 열 때 실행할 명령: 직접 지정한 시작 명령 > 감지된 이어가기 명령 */
    async resumeCommandFor (terminal: BaseTerminalTabComponent<any>): Promise<string|null> {
        return this.getPinned(terminal) || await this.detect(terminal)
    }

    /**
     * 복원/워크스페이스로 넘어온 이어가기 명령을 한 번 실행한다 (여러 번 불려도 한 번만)
     * 패널이 만들어지는 즉시 불린다 — 탭이 화면에 표시될 때까지 기다리지 않는다.
     */
    attach (terminal: BaseTerminalTabComponent<any>): void {
        if (this.started.has(terminal)) {
            return
        }
        const command: string|undefined = (terminal as any).hagisResume
        if (command && this.enabled) {
            this.started.add(terminal)
            this.runWhenReady(terminal, command)
        }
    }

    private async runWhenReady (terminal: BaseTerminalTabComponent<any>, command: string): Promise<void> {
        // Tabby는 화면에 보이지 않는 탭의 셸(PTY)을 그 탭을 처음 열 때 시작한다.
        // 세션 객체는 먼저 생기므로, 실제로 열릴 때(session.open)까지 기다린다.
        let destroyed = false
        const sub = terminal.destroyed$.subscribe(() => destroyed = true)
        while (!destroyed && !(terminal.session as any)?.open) {
            await new Promise(r => setTimeout(r, 500))
        }
        sub.unsubscribe()
        const session: any = terminal.session
        if (destroyed || !session) {
            return
        }
        // 셸 프롬프트가 다 나올 때까지: 출력이 0.8초 멈추면 준비된 것으로 본다 (최대 8초)
        await new Promise<void>(resolve => {
            let idle = setTimeout(done, 2500)
            const hardStop = setTimeout(done, 8000)
            const sub = session.output$?.subscribe(() => {
                clearTimeout(idle)
                idle = setTimeout(done, 800)
            })
            function done () {
                clearTimeout(idle)
                clearTimeout(hardStop)
                sub?.unsubscribe()
                resolve()
            }
        })
        terminal.sendInput(command + '\r')
        // 실행했으므로 더 이상 보존하지 않는다 (이후 저장은 실제 실행 중인 프로그램을 다시 감지)
        delete (terminal as any).hagisResume
        this.notifications.notice(`hagis: 이전 작업 이어가기 — ${command}`)
    }

    /**
     * 로컬 터미널에서 직접 실행 중인 ssh 접속 대상 (예: admin@10.0.0.1:2222) — SFTP 바로 열기용
     */
    async detectSshTarget (terminal: BaseTerminalTabComponent<any>): Promise<string|null> {
        for (const child of await this.descendants(terminal)) {
            const name = (child.command ?? '').split(/[\\/]/).pop()!.toLowerCase()
            if (name === 'ssh' || name === 'ssh.exe') {
                return parseSshCommand(await this.commandLine(child.pid))
            }
        }
        return null
    }

    private commandLine (pid: number): Promise<string> {
        const cached = this.cmdlineCache.get(pid)
        if (cached !== undefined) {
            return Promise.resolve(cached)
        }
        return new Promise(resolve => {
            const finish = (text: string) => {
                this.cmdlineCache.set(pid, text)
                resolve(text)
            }
            if (process.platform === 'win32') {
                // 프로세스 트리 모듈로 바로 읽는다 (PowerShell 실행 없이)
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const wpt = require('@tabby-gang/windows-process-tree')
                    wpt.getProcessList(Number(pid), (list: any[]|undefined) => {
                        finish(list?.find(p => p.pid === Number(pid))?.commandLine ?? '')
                    }, PROCESS_DATA_COMMAND_LINE)
                } catch {
                    finish('')
                }
            } else {
                execFile('ps', ['-o', 'args=', '-p', String(Number(pid))], { timeout: 3000 }, (_err, stdout) => finish((stdout ?? '').trim()))
            }
        })
    }

    /** 끝난 프로세스의 명령줄 기록이 계속 쌓이지 않게 정리 */
    private pruneCmdlineCache (): void {
        if (this.cmdlineCache.size > 500) {
            const keep = [...this.cmdlineCache.entries()].slice(-200)
            this.cmdlineCache = new Map(keep)
        }
    }
}
