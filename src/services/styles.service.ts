import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { HagisViewSyncService } from './viewSync.service'

const GLOBAL_CSS = `
/* ===== hagis: 패널 크롬 (네임태그 + 글자 크기) ===== */
.hagis-pane-head {
    position: absolute;
    top: 3px;
    left: 4px;
    z-index: 7;
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: calc(100% - 8px);
    pointer-events: none;
    user-select: none;
}
.hagis-tag-slot { flex: none; display: inline-flex; min-width: 0; max-width: 45%; }
.hagis-tag-slot:empty { display: none; }
.hagis-pane-head.hagis-pane-head-inline {
    position: static;
    max-width: 100%;
    margin-right: 2px;
}
.hagis-pane-head-inline .hagis-tag { flex: none; max-width: 100%; }
.hagis-tag {
    display: none;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 6px;
    border-radius: 3px;
    font: 700 10px/15px system-ui, sans-serif;
    letter-spacing: .2px;
    color: #111;
    background: var(--hagis-tag-color, #c6ff00);
    box-shadow: 0 0 6px color-mix(in srgb, var(--hagis-tag-color, #c6ff00) 55%, transparent);
    cursor: grab;
    pointer-events: auto;
    opacity: .92;
}
.hagis-tag:hover { opacity: 1; }
.hagis-tagged .hagis-tag { display: inline-block; }
.hagis-tag-input {
    width: 140px;
    border: none;
    outline: none;
    background: transparent;
    color: #111;
    font: inherit;
    padding: 0;
}
/* ☰ 패널 메뉴 버튼 */
.hagis-pane-menu {
    display: none;
    flex: none;
    pointer-events: auto;
    /* 터미널 색상 설정(--hagis-fg / --hagis-bg)을 따른다 — 배경이 완전 검정이어도 버튼이 보이게 글자색 + 옅은 테두리 */
    background: color-mix(in srgb, var(--hagis-fg, #ddd) 14%, var(--hagis-bg, #000));
    border: 1px solid color-mix(in srgb, var(--hagis-fg, #ddd) 32%, transparent);
    border-radius: 3px;
    color: var(--hagis-fg, #ddd);
    font: 12px/14px system-ui, sans-serif;
    padding: 0 5px;
    cursor: pointer;
}
.hagis-pane-menu:hover { background: color-mix(in srgb, var(--hagis-fg, #ddd) 30%, var(--hagis-bg, #000)); }
*:hover > .hagis-pane-head > .hagis-pane-menu,
.hagis-pane-head-inline > .hagis-pane-menu { display: inline-block; }
.hagis-pane-head-inline > .hagis-pane-menu { background: transparent; border-color: transparent; color: inherit; }
/* 화면 캡처 중에는 마우스를 올렸을 때만 나오는 버튼을 숨긴다 */
body.hagis-capturing .hagis-zoom, body.hagis-capturing .hagis-pane-menu, body.hagis-capturing .hagis-stage-add { display: none !important; }

/* 태그가 터미널 첫 줄을 가리지 않도록 자리 확보 */
.hagis-tagged > .content { margin-top: 20px !important; }
/* hagis 태그와 겹치는 Tabby 기본 패널 이름 표시는 숨김 */
body.hagis-tags-on split-tab-pane-label .custom-name { display: none !important; }

/* 글자 크기 컨트롤 — 마우스를 올린 패널에서만 표시, 폭에 따라 접힘 */
.hagis-zoom {
    display: none;
    flex: none;
    align-items: center;
    gap: 1px;
    padding: 0 3px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--hagis-fg, #ddd) 14%, var(--hagis-bg, #000));
    border: 1px solid color-mix(in srgb, var(--hagis-fg, #ddd) 32%, transparent);
    color: var(--hagis-fg, #ddd);
    pointer-events: auto;
}
*:hover > .hagis-pane-head > .hagis-zoom { display: inline-flex; }
.hagis-hide-pane-controls .hagis-zoom { display: none !important; }
.hagis-zoom button {
    background: transparent;
    border: none;
    color: inherit;
    font: 11px/17px system-ui, sans-serif;
    padding: 0 4px;
    border-radius: 3px;
    cursor: pointer;
}
.hagis-zoom button:hover { background: color-mix(in srgb, var(--hagis-fg, #ddd) 22%, transparent); }
.hagis-zoom button.active { background: color-mix(in srgb, var(--hagis-fg, #ddd) 34%, transparent); }
.hagis-zoom .hz-value { min-width: 34px; opacity: .85; }
.hagis-zoom.hz-mid .hz-preset { display: none; }
.hagis-zoom.hz-min .hz-preset,
.hagis-zoom.hz-min .hz-step,
.hagis-zoom.hz-min .hz-max { display: none; }

/* 좁은 패널에서 웹·Markdown 도구 막대가 넘치지 않게, 태그가 있으면 파일명은 숨김 */
.hagis-web-bar, .hagis-md-bar { overflow: hidden; }
.hagis-tagged .hagis-md-file { visibility: hidden; }

/* ===== hagis: 모서리 크기 조절 핸들 ===== */
.hagis-corner {
    position: absolute;
    width: 16px;
    height: 16px;
    margin: -8px 0 0 -8px;
    z-index: 8;
    border-radius: 50%;
    cursor: move;
}
.hagis-corner::after {
    content: '';
    position: absolute;
    inset: 5px;
    border-radius: 50%;
    background: #c6ff00;
    opacity: 0;
    transition: opacity .15s, inset .15s;
}
split-tab:hover > .hagis-corner::after { opacity: .35; }
.hagis-corner:hover::after, .hagis-corner.active::after { opacity: 1; inset: 3px; box-shadow: 0 0 8px #c6ff00; }
body.hagis-corner-dragging, body.hagis-corner-dragging * { cursor: move !important; }

/* ===== hagis: 패널 드래그 ===== */
.hagis-drag-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    cursor: grabbing;
}
.hagis-drag-highlight {
    position: fixed;
    display: none;
    align-items: center;
    justify-content: center;
    border: 2px solid #c6ff00;
    background: rgba(198, 255, 0, .12);
    color: #c6ff00;
    font: 700 13px system-ui, sans-serif;
    border-radius: 4px;
    pointer-events: none;
    transition: all .06s;
}
.hagis-drag-ghost {
    position: fixed;
    padding: 1px 8px;
    border-radius: 3px;
    font: 700 11px/17px system-ui, sans-serif;
    color: #111;
    background: var(--hagis-tag-color, #c6ff00);
    pointer-events: none;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .5);
}

/* ===== hagis: 메인 무대 ===== */
.hagis-tag[data-stage="main"]::before { content: '★ '; }
.hagis-stage-add {
    display: none;
    flex: none;
    pointer-events: auto;
    background: rgba(0, 0, 0, .6);
    border: 1px solid rgba(198, 255, 0, .6);
    border-radius: 3px;
    color: #c6ff00;
    font: 700 10px/15px system-ui, sans-serif;
    padding: 0 6px;
    cursor: pointer;
    white-space: nowrap;
}
.hagis-stage-add:hover { background: #c6ff00; color: #111; }
.hagis-head-main > .hagis-stage-add { display: inline-block; }
.hagis-stage-shield {
    position: absolute;
    inset: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    container-type: size; /* 안내 글자를 패널 크기에 비례해 줄인다 */
}
.hagis-stage-shield:hover { background: rgba(198, 255, 0, .06); box-shadow: inset 0 0 0 1px rgba(198, 255, 0, .5); }
.hagis-stage-shield > span {
    padding: .25em .8em;
    border-radius: .35em;
    border: 1px solid #c6ff00;
    background: rgba(0, 0, 0, .75);
    color: #c6ff00;
    font-family: system-ui, sans-serif;
    font-weight: 700;
    line-height: 1.5;
    white-space: nowrap;
    font-size: clamp(6px, min(4cqw, 9cqh), 13px);
    opacity: 0;
    transition: opacity .12s;
    pointer-events: none;
}
.hagis-stage-shield:hover > span { opacity: 1; }

/* ===== hagis: 독 (화면 옆 실행 막대) ===== */
/* 탭 내용 영역 옆에 독 자리를 비운다 — 웹 패널(네이티브 뷰)은 Tabby 화면 위에 그려져 겹치면 독을 가리므로 */
/* 크기: 독 폭 48px, 아이콘 평소 24px → 마우스를 올리면 최대 36px (dock.service.ts 와 맞출 것) */
body.hagis-dock-side-left app-root .content.main > .content { margin-left: 48px; width: calc(100% - 48px) !important; }
body.hagis-dock-side-right app-root .content.main > .content { margin-right: 48px; width: calc(100% - 48px) !important; }
.hagis-dock {
    position: fixed;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    user-select: none;
    /* 탭 바와 같은 색 — 탭 바에서 이어지는 사이드바처럼 */
    background: var(--theme-bg-more-2, #0d0d0d);
}
.hagis-dock-glass {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    width: 40px;
    max-height: calc(100% - 16px);
    margin-right: 4px; /* 오른쪽 가장자리는 접기 손잡이 자리 */
    padding: 6px 0;
    border-radius: 14px;
    background:
        linear-gradient(160deg, rgba(255, 255, 255, .16) 0%, rgba(255, 255, 255, .05) 45%, rgba(255, 255, 255, .02) 100%),
        rgba(30, 32, 40, .45);
    -webkit-backdrop-filter: blur(20px) saturate(170%);
    backdrop-filter: blur(20px) saturate(170%);
    border: 1px solid rgba(255, 255, 255, .16);
    box-shadow:
        0 8px 22px rgba(0, 0, 0, .45),
        inset 0 1px 0 rgba(255, 255, 255, .22),
        inset 0 -1px 0 rgba(0, 0, 0, .25);
}
.hagis-dock-items {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
}
.hagis-dock-items::-webkit-scrollbar { display: none; }
.hagis-dock-item {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: var(--hd-size, 24px);
    cursor: pointer;
    transition: height .14s cubic-bezier(.2, .8, .2, 1);
}
.hagis-dock-icon {
    display: block;
    width: var(--hd-size, 24px);
    height: var(--hd-size, 24px);
    transition: width .14s cubic-bezier(.2, .8, .2, 1), height .14s cubic-bezier(.2, .8, .2, 1);
}
.hagis-dock-icon > img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .45));
}
.hagis-dock-tile {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    border-radius: 24%;
    color: #fff;
    font: 700 calc(var(--hd-size, 24px) * .44)/1 system-ui, sans-serif;
    text-shadow: 0 1px 2px rgba(0, 0, 0, .35);
    background: linear-gradient(145deg, var(--c1, #6a8cff), var(--c2, #3a4fc0));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .4), 0 2px 5px rgba(0, 0, 0, .4);
}
.hagis-dock-tile > i { font-size: calc(var(--hd-size, 24px) * .46); }
.hagis-dock-tile-svg > svg { width: 58%; height: 58%; fill: currentColor; }
.hagis-dock-add .hagis-dock-tile {
    background: rgba(255, 255, 255, .07);
    border: 1px dashed rgba(255, 255, 255, .35);
    box-shadow: none;
    color: rgba(255, 255, 255, .75);
    font-weight: 300;
}
.hagis-dock-item:active .hagis-dock-icon { filter: brightness(.75); }
.hagis-dock-dragging { opacity: .55; }
.hagis-dock-bounce .hagis-dock-icon { animation: hagis-dock-bounce .9s cubic-bezier(.3, .7, .4, 1); }
.hagis-dock-right .hagis-dock-bounce .hagis-dock-icon { animation-name: hagis-dock-bounce-left; }
@keyframes hagis-dock-bounce {
    0%, 100% { transform: none; } 25% { transform: translateX(6px); } 50% { transform: none; } 70% { transform: translateX(3px); }
}
@keyframes hagis-dock-bounce-left {
    0%, 100% { transform: none; } 25% { transform: translateX(-6px); } 50% { transform: none; } 70% { transform: translateX(-3px); }
}
.hagis-dock-sep { flex: none; width: 20px; height: 1px; margin: 2px 0; background: rgba(255, 255, 255, .2); }
.hagis-dock-hint {
    writing-mode: vertical-rl;
    padding: 4px 0;
    font: 10px/1.2 system-ui, sans-serif;
    color: rgba(255, 255, 255, .45);
    letter-spacing: 1px;
}
/* 접기·펴기 손잡이 — 독 안쪽 가장자리에 얇게 튀어나온 탭 */
body.hagis-dock-collapsed.hagis-dock-side-left app-root .content.main > .content { margin-left: 10px; width: calc(100% - 10px) !important; }
body.hagis-dock-collapsed.hagis-dock-side-right app-root .content.main > .content { margin-right: 10px; width: calc(100% - 10px) !important; }
.hagis-dock-is-collapsed .hagis-dock-glass { display: none; }
.hagis-dock-right .hagis-dock-glass { margin-right: 0; margin-left: 4px; }
.hagis-dock-handle {
    position: absolute;
    top: 50%;
    right: 0;
    width: 5px;
    height: 44px;
    transform: translateY(-50%);
    pointer-events: auto;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px 0 0 5px;
    background: linear-gradient(180deg, rgba(255, 255, 255, .22), rgba(255, 255, 255, .08));
    border: 1px solid rgba(255, 255, 255, .18);
    border-right: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, .4);
    transition: width .15s, background .15s;
}
.hagis-dock-handle:hover { width: 8px; background: linear-gradient(180deg, rgba(198, 255, 0, .55), rgba(198, 255, 0, .25)); }
.hagis-dock-chevron { opacity: 0; font: 700 9px/1 system-ui, sans-serif; color: #fff; transition: opacity .15s; }
.hagis-dock-chevron::before { content: '‹'; }
.hagis-dock-handle:hover .hagis-dock-chevron { opacity: 1; }
/* 오른쪽 독은 반대 방향 */
.hagis-dock-right .hagis-dock-handle { right: auto; left: 0; border-radius: 0 5px 5px 0; border: 1px solid rgba(255, 255, 255, .18); border-left: none; }
.hagis-dock-right .hagis-dock-chevron::before { content: '›'; }
/* 접힌 상태: 창 가장자리에서 튀어나온 얇은 탭만 */
.hagis-dock-is-collapsed .hagis-dock-handle {
    left: 0;
    right: auto;
    width: 9px;
    height: 56px;
    border-radius: 0 6px 6px 0;
    border: 1px solid rgba(255, 255, 255, .2);
    border-left: none;
}
.hagis-dock-is-collapsed .hagis-dock-handle:hover { width: 10px; }
.hagis-dock-is-collapsed .hagis-dock-chevron { opacity: .8; }
.hagis-dock-is-collapsed .hagis-dock-chevron::before { content: '›'; }
.hagis-dock-right.hagis-dock-is-collapsed .hagis-dock-handle { left: auto; right: 0; border-radius: 6px 0 0 6px; border: 1px solid rgba(255, 255, 255, .2); border-right: none; }
.hagis-dock-right.hagis-dock-is-collapsed .hagis-dock-chevron::before { content: '‹'; }
/* 자동 숨기기 (macOS 방식): 가장자리에 6px 띠만 남기고, 마우스를 대면 독이 화면 위로 미끄러져 나온다 */
body.hagis-dock-autohide.hagis-dock-side-left app-root .content.main > .content { margin-left: 6px; width: calc(100% - 6px) !important; }
body.hagis-dock-autohide.hagis-dock-side-right app-root .content.main > .content { margin-right: 6px; width: calc(100% - 6px) !important; }
.hagis-dock-hot { display: none; }
.hagis-dock-auto { background: transparent; justify-content: flex-start; }
.hagis-dock-auto.hagis-dock-right { justify-content: flex-end; }
.hagis-dock-auto .hagis-dock-handle { display: none; }
.hagis-dock-auto .hagis-dock-hot {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    background: var(--theme-bg-more-2, #0d0d0d);
}
.hagis-dock-auto.hagis-dock-right .hagis-dock-hot { left: auto; right: 0; }
.hagis-dock-hot::before {
    content: '';
    width: 2px;
    height: 44px;
    border-radius: 2px;
    background: rgba(255, 255, 255, .22);
    transition: background .15s, height .15s;
}
.hagis-dock-hot:hover::before, .hagis-dock-revealed .hagis-dock-hot::before { height: 64px; background: #c6ff00; }
.hagis-dock-auto .hagis-dock-glass {
    margin: 0 0 0 10px;
    transform: translateX(-60px);
    opacity: 0;
    pointer-events: none;
    transition: transform .2s cubic-bezier(.2, .8, .2, 1), opacity .16s;
}
.hagis-dock-auto.hagis-dock-right .hagis-dock-glass { margin: 0 10px 0 0; transform: translateX(60px); }
.hagis-dock-auto.hagis-dock-revealed .hagis-dock-glass { transform: none; opacity: 1; pointer-events: auto; }
.hagis-dock.hagis-file-drop-target { outline: none !important; background: var(--theme-bg-more-2, #0d0d0d) !important; }
.hagis-dock-auto.hagis-file-drop-target { background: transparent !important; }
.hagis-dock.hagis-file-drop-target .hagis-dock-glass { border-color: #c6ff00; box-shadow: 0 0 0 2px rgba(198, 255, 0, .45), 0 8px 22px rgba(0, 0, 0, .45); }

/* ===== hagis: 패널 경계선 (설정 → 패널 경계선) ===== */
/* Tabby 가 패널 사이에 두는 크기 조절 영역(split-tab-spanner) 한가운데에 선을 그린다.
   은은한 반투명 선 + 부드러운 번짐, 양 끝은 서서히 사라지고, 마우스를 올리거나 끌 때만 또렷해진다. */
body.hagis-pane-borders split-tab-spanner::before,
body.hagis-pane-borders split-tab-spanner::after {
    content: '';
    position: absolute;
    pointer-events: none;
    transition: background .18s ease, opacity .18s ease;
}
/* 또렷한 선 */
body.hagis-pane-borders split-tab-spanner::before {
    background: color-mix(in srgb, var(--hagis-border-color, #c6ff00) var(--hagis-border-alpha, 55%), transparent);
}
/* 옅은 번짐 */
body.hagis-pane-borders split-tab-spanner::after {
    background: color-mix(in srgb, var(--hagis-border-color, #c6ff00) calc(var(--hagis-border-alpha, 55%) * .32), transparent);
    filter: blur(2.5px);
}
body.hagis-pane-borders split-tab-spanner.h::before { top: 0; bottom: 0; left: calc(50% - var(--hagis-border-width, 1px) / 2); width: var(--hagis-border-width, 1px); }
body.hagis-pane-borders split-tab-spanner.h::after { top: 0; bottom: 0; left: calc(50% - var(--hagis-border-width, 1px) * 2); width: calc(var(--hagis-border-width, 1px) * 4); }
body.hagis-pane-borders split-tab-spanner.v::before { left: 0; right: 0; top: calc(50% - var(--hagis-border-width, 1px) / 2); height: var(--hagis-border-width, 1px); }
body.hagis-pane-borders split-tab-spanner.v::after { left: 0; right: 0; top: calc(50% - var(--hagis-border-width, 1px) * 2); height: calc(var(--hagis-border-width, 1px) * 4); }
/* 양 끝이 서서히 사라진다 */
body.hagis-pane-borders split-tab-spanner.h::before,
body.hagis-pane-borders split-tab-spanner.h::after { -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 6%, #000 94%, transparent 100%); mask-image: linear-gradient(to bottom, transparent 0, #000 6%, #000 94%, transparent 100%); }
body.hagis-pane-borders split-tab-spanner.v::before,
body.hagis-pane-borders split-tab-spanner.v::after { -webkit-mask-image: linear-gradient(to right, transparent 0, #000 6%, #000 94%, transparent 100%); mask-image: linear-gradient(to right, transparent 0, #000 6%, #000 94%, transparent 100%); }
/* 마우스를 올리면(크기 조절 가능) 또렷하게 */
body.hagis-pane-borders split-tab-spanner:hover::before,
body.hagis-pane-borders split-tab-spanner.active::before { background: var(--hagis-border-color, #c6ff00); }
body.hagis-pane-borders split-tab-spanner:hover::after,
body.hagis-pane-borders split-tab-spanner.active::after { background: color-mix(in srgb, var(--hagis-border-color, #c6ff00) 45%, transparent); }

/* ===== hagis: 툴바 버튼에 "Hagis" 글자 — 아이콘만으로는 무엇인지 알아보기 어렵다 ===== */
.btn-tab-bar:has(> svg.hagis-toolbar-icon) {
    width: auto !important;
    min-width: 46px;
    padding-left: 10px !important;
    padding-right: 12px !important;
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    gap: 7px;
}
.btn-tab-bar:has(> svg.hagis-toolbar-icon)::after {
    content: 'Hagis';
    font: 700 12px/1 system-ui, sans-serif;
    letter-spacing: .4px;
}
.btn-tab-bar:has(> svg.hagis-toolbar-icon) > svg { flex: none; color: #c6ff00; }

/* ===== hagis: 파일 끌어다 놓기 ===== */
.hagis-file-drop-target {
    outline: 2px dashed #c6ff00 !important;
    outline-offset: -2px;
    background: rgba(198, 255, 0, .08) !important;
}

/* ===== hagis: 컴팩트 모드 ===== */
body.hagis-compact split-tab > .child { opacity: 1; }
body.hagis-compact split-tab > .child.minimized { opacity: .1; }
body.hagis-compact .hagis-tagged > .content { margin-top: 17px !important; }
`

/** 전역 CSS 주입 + 컴팩트 모드·네임태그 body 클래스 관리 */
@Injectable({ providedIn: 'root' })
export class HagisStylesService {
    private styleElement: HTMLStyleElement|null = null
    private varsElement: HTMLStyleElement|null = null

    constructor (private config: ConfigService, private viewSync: HagisViewSyncService) { }

    init (): void {
        if (this.styleElement) {
            return
        }
        this.styleElement = document.createElement('style')
        this.styleElement.id = 'hagis-styles'
        this.styleElement.textContent = GLOBAL_CSS
        document.head.appendChild(this.styleElement)

        this.varsElement = document.createElement('style')
        this.varsElement.id = 'hagis-vars'
        document.head.appendChild(this.varsElement)

        // 플러그인 모듈은 설정 파일 로드 전에 생성되므로 ready$ 이후에 적용한다
        this.config.ready$.subscribe(() => {
            this.apply()
            this.config.changed$.subscribe(() => this.apply())
        })
    }

    /**
     * 터미널 패널 위에 떠 있는 버튼(글자 크기·메뉴)이 Tabby 색상 설정을 따르게 한다.
     * 밝은/어두운 모드는 설정(appearance.colorSchemeMode)과 시스템 모드를 보고 알맞은 색상표를 고른다.
     */
    private applyTerminalColors (): void {
        const store = this.config.store
        const mode = store?.appearance?.colorSchemeMode ?? 'auto'
        const light = mode === 'light' || (mode === 'auto' && window.matchMedia?.('(prefers-color-scheme: light)').matches)
        const scheme = (light ? store?.terminal?.lightColorScheme : store?.terminal?.colorScheme) ?? store?.terminal?.colorScheme
        const body = document.body.style
        for (const [name, value] of [['--hagis-fg', scheme?.foreground], ['--hagis-bg', scheme?.background]] as const) {
            if (typeof value === 'string' && /^#?[0-9a-f]{3,8}$/i.test(value.trim())) {
                body.setProperty(name, value.startsWith('#') ? value : '#' + value)
            } else {
                body.removeProperty(name)
            }
        }
    }

    /**
     * 패널 경계선 — 켜짐/색/굵기를 body 에 반영한다.
     * 웹 패널(네이티브 뷰)은 HTML 선 위에 그려져 선을 덮으므로, 켜져 있으면 웹 화면을 선 굵기의 절반만큼 안으로 줄인다.
     */
    private applyBorders (borders?: { enabled?: boolean, color?: string, width?: number, alpha?: number }): void {
        const enabled = !!borders?.enabled
        const color = typeof borders?.color === 'string' && /^#[0-9a-f]{6}$/i.test(borders.color.trim()) ? borders.color.trim() : '#c6ff00'
        const width = Math.min(6, Math.max(1, Math.round(Number(borders?.width) || 1)))
        const alpha = Math.min(100, Math.max(20, Math.round(Number(borders?.alpha) || 55)))
        document.body.classList.toggle('hagis-pane-borders', enabled)
        document.body.style.setProperty('--hagis-border-color', color)
        document.body.style.setProperty('--hagis-border-width', `${width}px`)
        document.body.style.setProperty('--hagis-border-alpha', `${alpha}%`)
        this.viewSync.setInset(enabled ? Math.ceil(width / 2) : 0)
    }

    apply (): void {
        const hagis = this.config.store?.hagis
        if (!hagis) {
            return
        }
        document.body.classList.toggle('hagis-compact', !!hagis.compactMode)
        document.body.classList.toggle('hagis-hide-pane-controls', !hagis.paneControls)
        document.body.classList.toggle('hagis-tags-on', hagis.paneTags !== false)
        this.applyBorders(hagis.paneBorders)
        this.applyTerminalColors()
        if (this.varsElement) {
            const spaciness = Math.min(1, Math.max(0.1, Number(hagis.compactSpaciness) || 0.5))
            // Tabby는 html 요소에 --spaciness를 지정하므로 body에서 덮어쓴다 (탭 높이·터미널 여백)
            this.varsElement.textContent = `body.hagis-compact { --spaciness: ${spaciness}; }`
        }
    }
}
