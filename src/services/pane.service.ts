import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { AppService, BaseTabComponent, NotificationsService, PartialProfile, Profile, ProfilesService, SplitDirection, SplitTabComponent, TabsService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

/**
 * 패널 단위 작업 (프로필 → 탭 생성, 패널 교체, 글자 크기)
 * 컴포넌트 클래스를 import 하지 않는다 — 컴포넌트가 이 서비스를 주입받기 때문 (순환 참조 방지)
 */
@Injectable({ providedIn: 'root' })
export class HagisPaneService {
    private paneDrag = new BehaviorSubject<BaseTabComponent|null>(null)

    /** 네임태그로 패널을 끌고 있는 동안 해당 패널 (웹 패널은 이때 숨는다) */
    get paneDrag$ (): Observable<BaseTabComponent|null> { return this.paneDrag }

    setPaneDrag (tab: BaseTabComponent|null): void {
        this.paneDrag.next(tab)
    }

    constructor (
        private app: AppService,
        private tabs: TabsService,
        private profiles: ProfilesService,
        private notifications: NotificationsService,
    ) { }

    async getSelectableProfiles (): Promise<PartialProfile<Profile>[]> {
        const list = await this.profiles.getProfiles()
        return list.filter(p => !p.isTemplate)
    }

    profileLabel (profile: PartialProfile<Profile>): string {
        const group = profile.group ? this.profiles.resolveProfileGroupName(profile.group) : ''
        return group ? `${group} / ${profile.name}` : profile.name ?? ''
    }

    /**
     * 빠른 연결 프로필 (Tabby의 user@host:port 형식)
     * profiles.quickConnect()는 Serial 등 다른 공급자가 먼저 가로챌 수 있어 공급자를 직접 고른다
     */
    quickConnectProfile (type: 'ssh' | 'telnet', query: string): PartialProfile<Profile>|null {
        const provider: any = this.profiles.getProviders().find(p => p.id === type)
        if (!provider?.quickConnect || !query.trim()) {
            return null
        }
        try {
            return provider.quickConnect(query.trim())
        } catch {
            return null
        }
    }

    /** 검색어가 접속 주소처럼 보이는지 (user@host, IP, 도메인, host:port) */
    looksLikeHost (query: string): boolean {
        const q = query.trim()
        return !!q && !/\s/.test(q) && (/@/.test(q) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(q) || /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(q))
    }

    async findProfile (profileId?: string, fallback?: any): Promise<PartialProfile<Profile>|null> {
        if (profileId) {
            const found = (await this.profiles.getProfiles()).find(p => p.id === profileId)
            if (found) {
                return found
            }
        }
        return fallback ?? null
    }

    /** 프로필로 터미널 탭을 만든다 (아직 화면에 붙이지 않음) */
    async createProfileTab (profile: PartialProfile<Profile>, zoom?: number, extraInputs?: Record<string, any>): Promise<BaseTabComponent|null> {
        const params = await this.profiles.newTabParametersForProfile(profile)
        if (!params) {
            this.notifications.error(`프로필을 열 수 없습니다: ${profile.name}`)
            return null
        }
        params.inputs = { ...params.inputs ?? {}, ...extraInputs ?? {} }
        if (zoom) {
            params.inputs.zoom = zoom
        }
        return this.tabs.create(params)
    }

    /** 분할 화면 안의 패널을 다른 탭으로 바꾼다 */
    replacePane (oldTab: BaseTabComponent, newTab: BaseTabComponent): void {
        // 빈 패널에 붙여 둔 네임태그 이름·색은 새 패널이 이어받는다
        if (oldTab.customTitle && !newTab.customTitle) {
            newTab.customTitle = oldTab.customTitle
        }
        if (oldTab.color && !newTab.color) {
            newTab.color = oldTab.color
        }
        // 메인 무대 역할(메인/미리보기)도 그 자리를 이어받는다
        if ((oldTab as any).hagisStage && !(newTab as any).hagisStage) {
            (newTab as any).hagisStage = (oldTab as any).hagisStage
        }
        const split = oldTab.parent
        if (!(split instanceof SplitTabComponent)) {
            this.app.wrapAndAddTab(newTab)
            oldTab.destroy()
            return
        }
        split.replaceTab(oldTab, newTab)
        oldTab.destroy()
        split.focus(newTab)
    }

    /** 패널을 같은 분할 화면 안의 다른 패널 옆으로 옮긴다 (Tabby의 드롭 처리와 같은 방식) */
    async movePane (tab: BaseTabComponent, target: BaseTabComponent, side: SplitDirection): Promise<void> {
        const split = target.parent
        if (!(split instanceof SplitTabComponent) || tab === target) {
            return
        }
        await split.add(tab, target, side)
        split.focus(tab)
    }

    /** 두 패널의 자리를 맞바꾼다 */
    swapPanes (a: BaseTabComponent, b: BaseTabComponent): void {
        const split = a.parent
        if (!(split instanceof SplitTabComponent) || b.parent !== split || a === b) {
            return
        }
        const pa = split.getParentOf(a)
        const pb = split.getParentOf(b)
        if (!pa || !pb) {
            return
        }
        const ia = pa.children.indexOf(a)
        const ib = pb.children.indexOf(b)
        pa.children[ia] = b
        pb.children[ib] = a
        split.layout()
        split.focus(a)
        // 레이아웃이 바뀌었음을 Tabby 탭 복원 저장에 알린다 (protected 멤버)
        ;(split as any).recoveryStateChangedHint?.next()
    }

    /** 패널 네임태그 이름 (Tabby customTitle — 재시작 후에도 복원됨) */
    paneName (tab: BaseTabComponent): string {
        if (tab.customTitle) {
            return tab.customTitle
        }
        // 터미널은 셸이 바꾸는 긴 창 제목(관리자: C:\WINDOWS\...) 대신 프로필 이름
        if (tab instanceof BaseTerminalTabComponent && tab.profile?.name) {
            return tab.profile.name
        }
        return tab.title || '패널'
    }

    renamePane (tab: BaseTabComponent, name: string): void {
        tab.customTitle = name.trim()
        ;(tab as any).recoveryStateChangedHint?.next()
        const split = tab.parent
        if (split instanceof SplitTabComponent) {
            ;(split as any).recoveryStateChangedHint?.next()
        }
    }

    /** 패널 네임태그 색 (Tabby tab.color — 재시작 후에도 복원됨) */
    setPaneColor (tab: BaseTabComponent, color: string|null): void {
        tab.color = color
        const split = tab.parent
        if (split instanceof SplitTabComponent) {
            ;(split as any).recoveryStateChangedHint?.next()
        }
    }

    /** 패널 컴포넌트의 화면 요소 */
    hostElement (tab: BaseTabComponent): HTMLElement|null {
        const view: any = tab.hostView
        return view?.rootNodes?.[0] ?? null
    }

    /** 터미널 패널의 글자 크기 단계를 설정 (0 = 기본) */
    setZoom (tab: BaseTabComponent, zoom: number): void {
        if (!(tab instanceof BaseTerminalTabComponent)) {
            return
        }
        tab.zoom = zoom
        tab.frontend?.setZoom(zoom)
    }

    getActiveSplit (): SplitTabComponent|null {
        const tab = this.app.activeTab
        return tab instanceof SplitTabComponent ? tab : null
    }

    getTerminalTabs (split: SplitTabComponent|null = this.getActiveSplit()): BaseTerminalTabComponent<any>[] {
        if (!split) {
            return []
        }
        return split.getAllTabs().filter(t => t instanceof BaseTerminalTabComponent) as BaseTerminalTabComponent<any>[]
    }
}
