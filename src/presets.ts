import { HagisLayoutNode, HagisPreset } from './models'

const empty = (): HagisLayoutNode => ({ kind: 'empty' })
const web = (): HagisLayoutNode => ({ kind: 'web', url: '' })

function grid (rows: number, cols: number): HagisLayoutNode {
    return {
        kind: 'split',
        orientation: 'v',
        children: Array.from({ length: rows }, () => ({
            kind: 'split' as const,
            orientation: 'h' as const,
            children: Array.from({ length: cols }, empty),
        })),
    }
}

/**
 * 원클릭 레이아웃 프리셋 — 패널 이름은 비워 두고, 열린 뒤 네임태그를 우클릭해 붙인다.
 * 빈 패널(empty)은 프로필·웹 GUI·Markdown을 고르거나 파일을 끌어다 놓아 채운다.
 */
export const BUILTIN_PRESETS: HagisPreset[] = [
    {
        id: 'network-workspace',
        name: 'Network Workspace',
        description: '왼쪽 작업 패널 3개 + 오른쪽 웹 GUI·터미널',
        layout: {
            kind: 'split',
            orientation: 'h',
            ratios: [0.62, 0.38],
            children: [
                {
                    kind: 'split',
                    orientation: 'v',
                    ratios: [0.45, 0.55],
                    children: [
                        empty(),
                        { kind: 'split', orientation: 'h', children: [empty(), empty()] },
                    ],
                },
                { kind: 'split', orientation: 'v', ratios: [0.62, 0.38], children: [web(), empty()] },
            ],
        },
    },
    {
        id: 'stage-web',
        name: '메인 + 미리보기',
        description: '오른쪽 미리보기를 클릭하면 왼쪽 메인에 크게 (웹 로그인 유지)',
        layout: {
            kind: 'split',
            orientation: 'h',
            ratios: [0.74, 0.26],
            children: [
                { kind: 'web', url: '', stage: 'main' },
                {
                    kind: 'split',
                    orientation: 'v',
                    children: [
                        { kind: 'web', url: '', stage: 'preview' },
                        { kind: 'web', url: '', stage: 'preview' },
                        { kind: 'web', url: '', stage: 'preview' },
                    ],
                },
            ],
        },
    },
    {
        id: 'top-plus-4',
        name: '상단 1 + 하단 4',
        description: '위에 넓은 패널, 아래 패널 4개',
        layout: {
            kind: 'split',
            orientation: 'v',
            ratios: [0.4, 0.6],
            children: [
                empty(),
                { kind: 'split', orientation: 'h', children: [empty(), empty(), empty(), empty()] },
            ],
        },
    },
    {
        id: 'main-plus-stack',
        name: '메인 + 보조 3',
        description: '왼쪽 큰 패널, 오른쪽 보조 패널 3개',
        layout: {
            kind: 'split',
            orientation: 'h',
            ratios: [0.6, 0.4],
            children: [
                empty(),
                { kind: 'split', orientation: 'v', children: [empty(), empty(), empty()] },
            ],
        },
    },
    {
        id: 'compare-2',
        name: '좌우 비교',
        description: '두 패널 출력 비교',
        layout: { kind: 'split', orientation: 'h', children: [empty(), empty()] },
    },
    { id: 'grid-2x2', name: '2 × 2', description: '패널 4개', layout: grid(2, 2) },
    { id: 'grid-3x3', name: '3 × 3', description: '패널 9개', layout: grid(3, 3) },
    { id: 'grid-4x4', name: '4 × 4', description: '패널 16개 (작은 글자 크기 권장)', layout: grid(4, 4) },
]
