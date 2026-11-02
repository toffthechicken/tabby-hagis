import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'
import { HagisWorkspaceService } from './services/workspace.service'
import { HagisResumeService } from './services/resume.service'

/**
 * 모든 터미널에 붙는 데코레이터
 *  - 레이아웃에 저장된 글자 크기(zoom)를 실제 화면에 적용 (Tabby는 zoom 입력값을 처음에 적용하지 않음)
 *  - 컴팩트 모드일 때 새 터미널도 작은 글자로
 * 네임태그·글자 크기 버튼은 HagisPaneChromeService가 붙인다.
 */
@Injectable()
export class HagisPaneDecorator extends TerminalDecorator {
    constructor (
        private config: ConfigService,
        private workspaces: HagisWorkspaceService,
        private resume: HagisResumeService,
    ) {
        super()
    }

    attach (terminal: BaseTerminalTabComponent<any>): void {
        if (terminal.zoom) {
            terminal.frontend?.setZoom(terminal.zoom)
        }
        if (this.config.store?.hagis?.compactMode) {
            this.workspaces.applyCompactZoom(terminal)
        }
        // 이어가기: 복원 토큰에 실행 중인 프로그램 기록 + 넘어온 이어가기 명령 실행
        this.resume.attach(terminal)
    }
}
