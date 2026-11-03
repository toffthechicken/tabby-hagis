/** 제작자 */
export const HAGIS_AUTHOR = 'JakeandToff'
export const HAGIS_INSTAGRAM = 'toomuchthought.kr'
export const HAGIS_INSTAGRAM_URL = 'https://www.instagram.com/toomuchthought.kr/'
/** 업데이트를 확인할 GitHub 저장소 */
export const HAGIS_REPO = 'toffthechicken/tabby-hagis'
/** HAGIS = Hub for All Gear, In Sight */
export const HAGIS_TAGLINE = 'Hub for All Gear, In Sight'

/**
 * hagis 레이아웃 모델
 *
 * 레이아웃은 Tabby의 SplitContainer 트리와 같은 구조를 JSON으로 표현한 것이다.
 *  - split: 가로(h) 또는 세로(v) 방향으로 자식을 나눈 영역, ratios는 자식별 비율
 *  - pane:  실제 패널 (터미널 프로필 / 웹 GUI / 빈 패널)
 */

export type HagisOrientation = 'h' | 'v'

export interface HagisSplitNode {
    kind: 'split'
    orientation: HagisOrientation
    ratios?: number[]
    children: HagisLayoutNode[]
}

export interface HagisProfilePane {
    kind: 'profile'
    /** Tabby 프로필 ID (설정에 저장된 프로필) */
    profileId?: string
    /** 프로필 ID로 찾지 못할 때 사용하는 프로필 사본 */
    profile?: any
    title?: string
    /** 패널별 글자 크기 단계 (0 = 기본, 1단계당 ×1.1) */
    zoom?: number
    /** 저장 당시 작업 폴더 (로컬 터미널) */
    cwd?: string
    /** 저장 당시 실행 중이던 프로그램의 이어가기 명령 (예: claude --continue) */
    resume?: string
    /** 패널에 직접 지정한 시작 명령 — 열 때마다 실행 */
    startupPinned?: string
}

export interface HagisWebPane {
    kind: 'web'
    url: string
    title?: string
    /** 웹페이지 확대 비율 (1 = 100%) */
    zoomFactor?: number
}

export interface HagisMarkdownPane {
    kind: 'markdown'
    /** 로컬 Markdown·텍스트 파일 경로 */
    path: string
    title?: string
}

export interface HagisEmptyPane {
    kind: 'empty'
    /** 네임태그에 표시할 이름 */
    title?: string
    zoom?: number
}

/**
 * 메인 무대 역할
 *  - main:    크게 보는 자리 (분할 화면마다 하나)
 *  - preview: 보기 전용 미리보기 — 클릭하면 메인과 자리를 바꾼다
 */
export type HagisStageRole = 'main' | 'preview'

/** 모든 패널 공통: title = 네임태그 이름, color = 네임태그 색, stage = 메인 무대 역할 */
type WithTag<T> = T & { color?: string, stage?: HagisStageRole }

export type HagisPaneNode = WithTag<HagisProfilePane> | WithTag<HagisWebPane> | WithTag<HagisMarkdownPane> | WithTag<HagisEmptyPane>
export type HagisLayoutNode = HagisSplitNode | HagisPaneNode

export interface HagisWorkspace {
    id: string
    name: string
    /** 고객사 이름 — 목록을 고객사별로 묶는 데 사용 */
    customer?: string
    description?: string
    layout: HagisLayoutNode
    createdAt: string
    updatedAt: string
}

/**
 * 독(화면 옆 실행 막대)의 아이콘 하나
 *  - app:       프로그램·바로가기(.lnk)·문서·폴더 — Windows 에서 연다
 *  - profile:   Tabby 프로필 (SSH·터미널·웹 GUI 등)
 *  - workspace: hagis 워크스페이스
 *  - web:       웹 GUI 패널로 열 주소
 */
export interface HagisDockItem {
    id: string
    kind: 'app' | 'profile' | 'workspace' | 'web'
    name: string
    path?: string
    /** 실행 인수 (.exe 만) */
    args?: string
    profileId?: string
    workspaceId?: string
    url?: string
}

export interface HagisPreset {
    id: string
    name: string
    description: string
    layout: HagisLayoutNode
}

export function isSplit (node: HagisLayoutNode): node is HagisSplitNode {
    return node.kind === 'split'
}

export function countPanes (node: HagisLayoutNode): number {
    return isSplit(node) ? node.children.reduce((s, c) => s + countPanes(c), 0) : 1
}

export function newId (): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
}

/** 글자 크기 단계 → 표시용 백분율 */
export function zoomPercent (zoom: number): number {
    return Math.round(Math.pow(1.1, zoom) * 100)
}

/** 네임태그 형광색 */
export const TAG_COLORS: { label: string, color: string }[] = [
    { label: '라임', color: '#c6ff00' },
    { label: '노랑', color: '#fff200' },
    { label: '초록', color: '#39ff14' },
    { label: '하늘', color: '#00f0ff' },
    { label: '분홍', color: '#ff4fd8' },
    { label: '주황', color: '#ff9f1a' },
]
export const DEFAULT_TAG_COLOR = TAG_COLORS[0].color

/** Markdown 뷰어로 여는 파일 확장자 */
export const TEXT_FILE_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.txt', '.log', '.cfg', '.conf']

export function isTextFile (path: string): boolean {
    const lower = path.toLowerCase()
    return TEXT_FILE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export const ZOOM_PRESETS: { label: string, zoom: number }[] = [
    { label: 'XS', zoom: -4 },
    { label: 'S', zoom: -2 },
    { label: 'M', zoom: 0 },
    { label: 'L', zoom: 2 },
]
