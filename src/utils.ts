/* eslint-disable @typescript-eslint/no-var-requires */

/** Electron remote (Tabby가 렌더러에 활성화해 둠) */
export function getRemote (): any {
    return require('@electron/remote')
}

/** 끌어다 놓은 File 객체의 실제 경로 (Electron 32+ 는 File.path 가 없어 webUtils 사용) */
export function getDroppedFilePath (file: File): string|null {
    try {
        const { webUtils } = require('electron')
        const p = webUtils?.getPathForFile?.(file)
        if (p) {
            return p
        }
    } catch { }
    return (file as any).path || null
}

/** 파일 열기 대화상자 */
export async function pickFile (title: string, filters: { name: string, extensions: string[] }[]): Promise<string|null> {
    const remote = getRemote()
    const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
        title,
        filters,
        properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths?.length) {
        return null
    }
    return result.filePaths[0]
}

/**
 * hagis(Tabby)가 Claude Code 세션 안에서 실행되면, 그 세션 전용 환경변수가 모든 터미널 패널로 물려 내려간다.
 * 그러면 패널에서 실행한 claude 가 자신을 "하위 세션"으로 인식해 대화 기록 저장을 끄고
 * ("Transcript saving is off — inherited CLAUDE_CODE_…") 나중에 claude --continue 로 이어갈 수 없다.
 * Tabby는 터미널 환경을 렌더러의 process.env 에서 복사하므로, 첫 터미널이 열리기 전에 세션 전용 변수만 지운다.
 * (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR 등 사용자가 설정한 변수는 건드리지 않는다)
 */
const INHERITED_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_\w+))$/

export function scrubInheritedSessionEnv (): string[] {
    const removed = Object.keys(process.env).filter(key => INHERITED_SESSION_ENV.test(key))
    for (const key of removed) {
        delete process.env[key]
    }
    return removed
}

export function baseName (filePath: string): string {
    return filePath.split(/[\\/]/).pop() ?? filePath
}
