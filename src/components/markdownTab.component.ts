import { Component, ElementRef, Injector, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { BaseTabComponent, GetRecoveryTokenOptions, NotificationsService, PlatformService, RecoveryToken } from 'tabby-core'
import { TEXT_FILE_EXTENSIONS } from '../models'
import { baseName, getDroppedFilePath, pickFile } from '../utils'

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']
const MAX_FILE_SIZE = 5 * 1024 * 1024

/**
 * Markdown·텍스트 뷰어 패널
 *  - 파일을 끌어다 놓거나 열기 버튼으로 연다
 *  - 파일이 바뀌면 자동으로 다시 읽는다
 *  - Tabby 렌더러는 Node.js 권한이 있으므로 변환된 HTML은 DOMPurify로 반드시 정화한다
 */
@Component({
    selector: 'hagis-markdown-tab',
    template: `
<div class="hagis-md-bar">
    <span class="hagis-tag-slot"></span>
    <span class="hagis-md-file" [title]="path">{{ path ? fileName : '파일 없음' }}</span>
    <button class="btn btn-sm btn-link" (click)="choose()" title="파일 열기"><i class="fas fa-folder-open"></i></button>
    <button class="btn btn-sm btn-link" (click)="load()" [disabled]="!path" title="다시 읽기"><i class="fas fa-redo"></i></button>
    <button class="btn btn-sm btn-link" (click)="toggleSource()" [disabled]="!path || plainText" [class.active]="showSource" title="원문 / 미리보기">
        <i class="fas" [class.fa-code]="!showSource" [class.fa-eye]="showSource"></i>
    </button>
    <button class="btn btn-sm btn-link" (click)="changeFont(-1)" title="글자 작게"><i class="fas fa-search-minus"></i></button>
    <span class="hagis-md-zoom" (click)="fontSize = 14" title="기본 크기로">{{ fontSize }}px</span>
    <button class="btn btn-sm btn-link" (click)="changeFont(1)" title="글자 크게"><i class="fas fa-search-plus"></i></button>
    <button class="btn btn-sm btn-link" (click)="openExternal()" [disabled]="!path" title="기본 프로그램으로 열기"><i class="fas fa-external-link-alt"></i></button>
</div>
<div class="hagis-md-body" [style.font-size.px]="fontSize" (click)="onBodyClick($event)">
    <div class="hagis-md-empty" *ngIf="!path">
        <div class="hagis-brand">hagis <span>by tabby</span></div>
        <div>Markdown·텍스트 파일을 여기로 끌어다 놓거나</div>
        <button class="btn btn-sm btn-primary mt-2" (click)="choose()"><i class="fas fa-folder-open"></i> 파일 열기</button>
    </div>
    <div class="text-danger p-2" *ngIf="error">{{ error }}</div>
    <pre class="hagis-md-source" *ngIf="path && !error && (showSource || plainText)">{{ source }}</pre>
    <div class="hagis-md-content" #content [hidden]="!path || !!error || showSource || plainText"></div>
</div>
`,
    styles: [`
:host { display: flex; flex-direction: column; flex: auto; min-height: 0; overflow: hidden; }
:host(.hagis-file-drop-target) { outline: 2px dashed #c6ff00; outline-offset: -2px; }
.hagis-md-bar { display: flex; align-items: center; gap: 2px; padding: 3px 4px; flex: none; background: rgba(0,0,0,.2); min-width: 0; }
.hagis-md-bar .btn { padding: 2px 6px; }
.hagis-md-bar .btn.active { color: #c6ff00; }
.hagis-md-file { flex: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; opacity: .8; padding: 0 4px; }
.hagis-md-zoom { font-size: 11px; opacity: .7; cursor: pointer; min-width: 34px; text-align: center; }
.hagis-md-body { flex: auto; min-height: 0; overflow: auto; padding: 12px 18px; line-height: 1.6; user-select: text; }
.hagis-md-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; opacity: .8; text-align: center; }
.hagis-brand { font-size: 22px; font-weight: 600; }
.hagis-brand span { font-size: 13px; font-weight: 400; opacity: .6; }
.hagis-md-source { white-space: pre-wrap; word-break: break-word; font-size: .9em; margin: 0; }
.hagis-md-content ::ng-deep h1, .hagis-md-content ::ng-deep h2 { border-bottom: 1px solid rgba(255,255,255,.15); padding-bottom: .2em; }
.hagis-md-content ::ng-deep h1 { font-size: 1.7em; }
.hagis-md-content ::ng-deep h2 { font-size: 1.4em; }
.hagis-md-content ::ng-deep h3 { font-size: 1.2em; }
.hagis-md-content ::ng-deep h1, .hagis-md-content ::ng-deep h2, .hagis-md-content ::ng-deep h3, .hagis-md-content ::ng-deep h4 { margin: 1.1em 0 .5em; font-weight: 600; }
.hagis-md-content ::ng-deep code { background: rgba(255,255,255,.08); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
.hagis-md-content ::ng-deep pre { background: rgba(0,0,0,.35); padding: 10px 12px; border-radius: 5px; overflow: auto; }
.hagis-md-content ::ng-deep pre code { background: none; padding: 0; }
.hagis-md-content ::ng-deep table { border-collapse: collapse; margin: .6em 0; }
.hagis-md-content ::ng-deep th, .hagis-md-content ::ng-deep td { border: 1px solid rgba(255,255,255,.18); padding: 4px 10px; }
.hagis-md-content ::ng-deep th { background: rgba(255,255,255,.06); }
.hagis-md-content ::ng-deep blockquote { border-left: 3px solid rgba(255,255,255,.25); margin: .6em 0; padding: 0 0 0 12px; opacity: .85; }
.hagis-md-content ::ng-deep img { max-width: 100%; }
.hagis-md-content ::ng-deep a { color: #6cb6ff; cursor: pointer; }
.hagis-md-content ::ng-deep hr { border-color: rgba(255,255,255,.2); }
`],
})
export class HagisMarkdownTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    /** 열 파일 경로 (입력값) */
    path = ''
    /** 경로 없이 열리면 파일 선택 대화상자를 바로 띄울지 */
    autoPick = false
    fontSize = 14

    source = ''
    error = ''
    showSource = false

    @ViewChild('content', { static: true }) content: ElementRef<HTMLElement>

    private watcher: fs.FSWatcher|null = null
    private reloadTimer: any = null

    get fileName (): string { return baseName(this.path) }

    get plainText (): boolean {
        const lower = this.path.toLowerCase()
        return !MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext))
    }

    constructor (
        injector: Injector,
        private zone: NgZone,
        private platform: PlatformService,
        private notifications: NotificationsService,
        element: ElementRef,
    ) {
        super(injector)
        this.icon = 'fab fa-markdown'
        const host: HTMLElement = element.nativeElement
        // 이 패널 위에 파일을 놓으면 그 파일로 바꾼다
        host.addEventListener('dragover', e => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault()
                e.stopPropagation()
                host.classList.add('hagis-file-drop-target')
            }
        })
        host.addEventListener('dragleave', () => host.classList.remove('hagis-file-drop-target'))
        host.addEventListener('drop', e => {
            host.classList.remove('hagis-file-drop-target')
            const file = e.dataTransfer?.files?.[0]
            const filePath = file ? getDroppedFilePath(file) : null
            if (filePath) {
                e.preventDefault()
                e.stopPropagation()
                this.zone.run(() => this.open(filePath))
            }
        })
    }

    async ngOnInit (): Promise<void> {
        this.setTitle(this.path ? this.fileName : 'Markdown')
        if (this.path) {
            await this.open(this.path)
        } else if (this.autoPick) {
            setTimeout(() => this.choose())
        }
    }

    async choose (): Promise<void> {
        const filePath = await pickFile('Markdown·텍스트 파일 열기', [
            { name: 'Markdown·텍스트', extensions: TEXT_FILE_EXTENSIONS.map(x => x.substring(1)) },
            { name: '모든 파일', extensions: ['*'] },
        ])
        if (filePath) {
            await this.zone.run(() => this.open(filePath))
        }
    }

    async open (filePath: string): Promise<void> {
        this.path = filePath
        this.showSource = false
        this.setTitle(this.fileName)
        this.watch()
        await this.load()
        this.recoveryStateChangedHint.next()
    }

    async load (): Promise<void> {
        if (!this.path) {
            return
        }
        try {
            const stat = await fs.promises.stat(this.path)
            if (stat.size > MAX_FILE_SIZE) {
                throw new Error(`파일이 너무 큽니다 (${Math.round(stat.size / 1024 / 1024)}MB, 최대 5MB)`)
            }
            // Windows 메모장 등이 붙이는 UTF-8 BOM 제거 (첫 줄 제목이 인식되지 않음)
            this.source = (await fs.promises.readFile(this.path, 'utf-8')).replace(/^﻿/, '')
            this.error = ''
            this.render()
        } catch (e: any) {
            this.error = `파일을 읽을 수 없습니다: ${e.message ?? e}`
        }
    }

    private render (): void {
        const el = this.content.nativeElement
        if (this.plainText) {
            el.innerHTML = ''
            return
        }
        const dir = path.dirname(this.path)
        const raw = marked.parse(this.source, { gfm: true, async: false }) as string
        DOMPurify.addHook('afterSanitizeAttributes', node => {
            // 상대 경로 이미지 → 파일 위치 기준 file:// 주소
            if (node.tagName === 'IMG') {
                const src = node.getAttribute('src') ?? ''
                if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
                    node.setAttribute('src', pathToFileURL(path.resolve(dir, decodeURI(src))).toString())
                }
            }
        })
        try {
            el.innerHTML = DOMPurify.sanitize(raw, {
                FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'button', 'textarea', 'select'],
                FORBID_ATTR: ['style'],
            })
        } finally {
            DOMPurify.removeHook('afterSanitizeAttributes')
        }
    }

    /** 링크: 웹 주소는 기본 브라우저로, 다른 Markdown 파일은 이 패널에서, #앵커는 스크롤 */
    onBodyClick (event: MouseEvent): void {
        const a = (event.target as HTMLElement).closest('a')
        if (!a) {
            return
        }
        event.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) {
            this.platform.openExternal(href)
        } else if (href.startsWith('#')) {
            const id = decodeURIComponent(href.substring(1))
            this.content.nativeElement.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView()
        } else if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            const target = path.resolve(path.dirname(this.path), decodeURI(href.split('#')[0]))
            if (fs.existsSync(target)) {
                this.open(target)
            } else {
                this.notifications.error(`파일이 없습니다: ${target}`)
            }
        }
    }

    toggleSource (): void {
        this.showSource = !this.showSource
    }

    changeFont (delta: number): void {
        this.fontSize = Math.min(32, Math.max(8, this.fontSize + delta))
        this.recoveryStateChangedHint.next()
    }

    openExternal (): void {
        if (this.path) {
            this.platform.openPath(this.path)
        }
    }

    private watch (): void {
        this.watcher?.close()
        this.watcher = null
        try {
            this.watcher = fs.watch(this.path, () => {
                clearTimeout(this.reloadTimer)
                this.reloadTimer = setTimeout(() => this.zone.run(() => this.load()), 200)
            })
        } catch { }
    }

    async getRecoveryToken (_options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        return {
            type: 'hagis:markdown-tab',
            path: this.path,
            fontSize: this.fontSize,
        }
    }

    ngOnDestroy (): void {
        this.watcher?.close()
        clearTimeout(this.reloadTimer)
        super.ngOnDestroy()
    }
}
