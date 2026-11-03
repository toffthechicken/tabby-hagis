/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCorePlugin, { AppService, CommandProvider, ConfigProvider, ProfileProvider, TabContextMenuItemProvider, TabRecoveryProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { HagisConfigProvider } from './config'
import { HagisPaneDecorator } from './decorator'
import { HagisCommandProvider, HagisContextMenuProvider, HagisRecoveryProvider, HagisSettingsTabProvider } from './providers'
import {
    HagisMarkdownProfileProvider, HagisMarkdownProfileSettingsComponent,
    HagisWebProfileProvider, HagisWebProfileSettingsComponent,
} from './profiles'
import { HagisFileDropService } from './services/fileDrop.service'
import { HagisPaneChromeService } from './services/paneChrome.service'
import { HagisStylesService } from './services/styles.service'
import { HagisResumeService } from './services/resume.service'
import { HagisStageService } from './services/stage.service'
import { HagisDockService } from './services/dock.service'
import { HagisUpdateService } from './services/update.service'
import { HagisWorkspaceService } from './services/workspace.service'
import { scrubInheritedSessionEnv } from './utils'

import { HagisLauncherModalComponent } from './components/launcherModal.component'
import { HagisLayoutPreviewComponent } from './components/layoutPreview.component'
import { HagisMarkdownTabComponent } from './components/markdownTab.component'
import { HagisPlaceholderTabComponent } from './components/placeholderTab.component'
import { HagisSaveWorkspaceModalComponent } from './components/saveWorkspaceModal.component'
import { HagisSettingsTabComponent } from './components/settingsTab.component'
import { HagisWebTabComponent } from './components/webTab.component'

/**
 * hagis by tabby
 * 네트워크 엔지니어용 통합 워크스페이스 플러그인
 */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: HagisConfigProvider, multi: true },
        { provide: TerminalDecorator, useClass: HagisPaneDecorator, multi: true },
        { provide: CommandProvider, useClass: HagisCommandProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: HagisContextMenuProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: HagisRecoveryProvider, multi: true },
        { provide: SettingsTabProvider, useClass: HagisSettingsTabProvider, multi: true },
        { provide: ProfileProvider, useClass: HagisWebProfileProvider, multi: true },
        { provide: ProfileProvider, useClass: HagisMarkdownProfileProvider, multi: true },
    ],
    declarations: [
        HagisWebTabComponent,
        HagisMarkdownTabComponent,
        HagisPlaceholderTabComponent,
        HagisLayoutPreviewComponent,
        HagisLauncherModalComponent,
        HagisSaveWorkspaceModalComponent,
        HagisSettingsTabComponent,
        HagisWebProfileSettingsComponent,
        HagisMarkdownProfileSettingsComponent,
    ],
})
export default class HagisModule {
    constructor (
        styles: HagisStylesService,
        chrome: HagisPaneChromeService,
        fileDrop: HagisFileDropService,
        resume: HagisResumeService,
        app: AppService,
        workspace: HagisWorkspaceService,
        stage: HagisStageService,
        dock: HagisDockService,
        updates: HagisUpdateService,
    ) {
        const scrubbed = scrubInheritedSessionEnv()
        if (scrubbed.length) {
            console.log('[hagis] 터미널에 넘기지 않을 상위 세션 환경변수 제거:', scrubbed.join(', '))
        }
        styles.init()
        chrome.init()
        fileDrop.init()
        resume.init()
        dock.init()
        updates.init()
        // 진단용 (개발자 도구 콘솔에서 hagisDebug.app.tabs 등으로 확인)
        Object.defineProperty(window, 'hagisDebug', { value: { app, resume, chrome, workspace, stage, dock, updates }, configurable: true })
        console.log('[hagis] hagis by tabby — made by JakeandToff (instagram @toomuchthought.kr) loaded')
    }
}

export * from './models'
export { HagisWorkspaceService } from './services/workspace.service'
export { HagisPaneService } from './services/pane.service'
